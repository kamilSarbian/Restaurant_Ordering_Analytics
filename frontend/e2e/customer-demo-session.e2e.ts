import process from 'node:process';
import { URL } from 'node:url';

import {
  expect,
  test,
  type APIResponse,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { requireEnvironmentValue, validateLoopbackBaseUrl } from './support/runtime';

const AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
const DEMO_SESSION_STORAGE_KEY = 'restaurant-ordering:demo-session:v1';
const ORDER_ACCESS_STORAGE_PREFIX = 'restaurant-ordering:order-access:v1:';
const CUSTOMER_DEMO_SESSION_PATH = '/api/v1/auth/customer-demo-session';
const CURRENT_USER_PATH = '/api/v1/auth/me';
const MENU_ITEM_NAME = 'Roasted Root Vegetable Soup';
const DEMO_CUSTOMER_ID = '7f0c8d3f-4f58-4b2e-8d4a-2a5df7b40002';
const DEMO_CUSTOMER_EMAIL = 'demo-customer@example.com';
const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/u;
const baseOrigin = validateLoopbackBaseUrl(
  requireEnvironmentValue('E2E_BASE_URL', process.env),
);
const foreignOrderNumber = requireEnvironmentValue(
  'E2E_FOREIGN_ORDER_NUMBER',
  process.env,
);

interface DemoRequestObservation {
  readonly bodyAbsent: boolean;
  readonly contentTypeAbsent: boolean;
  readonly cookieAbsent: boolean;
  readonly method: string;
}

interface CurrentUserObservation {
  readonly activeCustomer: boolean;
  readonly exactIdentity: boolean;
  readonly status: number;
  readonly superAdministrator: boolean;
}

interface ExpectedHttpFailure {
  readonly method: string;
  readonly pathname: string;
  readonly status: number;
  remaining: number;
}

function safeInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

safeInvariant(
  PUBLIC_ORDER_NUMBER_PATTERN.test(foreignOrderNumber),
  'E2E_FOREIGN_ORDER_NUMBER_INVALID',
);

function sameOriginUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.origin === baseOrigin ? parsed : null;
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function isApiPath(request: Request, pathname: string): boolean {
  const parsed = sameOriginUrl(request.url());
  return parsed !== null && parsed.pathname === pathname;
}

function isCriticalRequest(request: Request): boolean {
  return new Set(['document', 'fetch', 'script', 'stylesheet', 'xhr']).has(
    request.resourceType(),
  );
}

class BrowserSafetyGuard {
  private readonly expectedHttpFailures: ExpectedHttpFailure[] = [];
  private readonly issues: string[] = [];

  constructor(page: Page) {
    page.on('console', (message) => {
      if (message.type() === 'error' && !this.isExpectedConsoleError(message)) {
        this.issues.push('console:error');
      }
    });
    page.on('pageerror', () => {
      this.issues.push('page:error');
    });
    page.on('requestfailed', (request) => {
      if (sameOriginUrl(request.url()) !== null && isCriticalRequest(request)) {
        this.issues.push('request:failed');
      }
    });
    page.on('response', (response) => {
      this.recordFailedResponse(response);
    });
  }

  expectHttpFailure(method: string, pathname: string, status: number): void {
    this.expectedHttpFailures.push({ method, pathname, remaining: 1, status });
  }

  assertClean(): void {
    safeInvariant(
      this.expectedHttpFailures.every(({ remaining }) => remaining === 0),
      'EXPECTED_HTTP_FAILURE_NOT_OBSERVED',
    );
    expect([...new Set(this.issues)], 'UNEXPECTED_BROWSER_FAILURE').toEqual([]);
  }

  private recordFailedResponse(response: Response): void {
    if (response.status() < 400 || !isCriticalRequest(response.request())) {
      return;
    }
    const parsed = sameOriginUrl(response.url());
    if (parsed === null) {
      return;
    }
    const expected = this.expectedHttpFailures.find(
      (failure) =>
        failure.remaining > 0 &&
        failure.method === response.request().method() &&
        failure.pathname === parsed.pathname &&
        failure.status === response.status(),
    );
    if (expected !== undefined) {
      expected.remaining -= 1;
      return;
    }
    this.issues.push('response:http-failure');
  }

  private isExpectedConsoleError(message: ConsoleMessage): boolean {
    if (
      !/^Failed to load resource: the server responded with a status of 404 \(Not Found\)$/u.test(
        message.text(),
      )
    ) {
      return false;
    }
    const parsed = sameOriginUrl(message.location().url);
    return (
      parsed !== null &&
      this.expectedHttpFailures.some(
        (failure) =>
          failure.method === 'GET' &&
          failure.pathname === parsed.pathname &&
          failure.status === 404,
      )
    );
  }
}

function waitForApiResponse(
  page: Page,
  method: string,
  pathname: string,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = sameOriginUrl(response.url());
    return (
      parsed !== null &&
      parsed.pathname === pathname &&
      response.request().method() === method
    );
  });
}

async function assertResponseStatus(
  responsePromise: Promise<Response>,
  expectedStatus: number,
  code: string,
): Promise<void> {
  const response = await responsePromise;
  safeInvariant(response.status() === expectedStatus, code);
}

async function assertLocation(page: Page, pathname: string): Promise<void> {
  await expect
    .poll(
      () => {
        const current = new URL(page.url());
        return { origin: current.origin, pathname: current.pathname };
      },
      { message: 'LOCATION_MISMATCH' },
    )
    .toEqual({ origin: baseOrigin, pathname });
}

function inspectCurrentUserResponse(
  response: APIResponse,
): Promise<CurrentUserObservation> {
  return response.json().then((payload: unknown) => {
    const isObject = typeof payload === 'object' && payload !== null;
    const id = isObject && 'id' in payload ? payload.id : undefined;
    const role = isObject && 'role' in payload ? payload.role : undefined;
    const email = isObject && 'email' in payload ? payload.email : undefined;
    const isActive = isObject && 'is_active' in payload ? payload.is_active : undefined;
    return {
      activeCustomer: role === 'customer' && isActive === true,
      exactIdentity: id === DEMO_CUSTOMER_ID && email === DEMO_CUSTOMER_EMAIL,
      status: response.status(),
      superAdministrator: role === 'super_admin',
    };
  });
}

async function assertCapabilityStored(
  page: Page,
  publicOrderNumber: string,
): Promise<void> {
  const state = await page.evaluate(
    ({ orderNumber, prefix }) => {
      const runtime = globalThis as typeof globalThis & {
        document: { body: { innerText: string } | null };
        location: { href: string };
        sessionStorage: { getItem: (key: string) => string | null };
      };
      const serialized = runtime.sessionStorage.getItem(`${prefix}${orderNumber}`);
      if (serialized === null) {
        return { exposed: false, valid: false };
      }
      try {
        const parsed: unknown = JSON.parse(serialized);
        if (
          typeof parsed !== 'object' ||
          parsed === null ||
          !('publicOrderNumber' in parsed) ||
          parsed.publicOrderNumber !== orderNumber ||
          !('token' in parsed) ||
          typeof parsed.token !== 'string' ||
          parsed.token.length === 0
        ) {
          return { exposed: false, valid: false };
        }
        return {
          exposed:
            runtime.location.href.includes(parsed.token) ||
            (runtime.document.body?.innerText.includes(parsed.token) ?? false),
          valid: true,
        };
      } catch (error: unknown) {
        void error;
        return { exposed: false, valid: false };
      }
    },
    { orderNumber: publicOrderNumber, prefix: ORDER_ACCESS_STORAGE_PREFIX },
  );
  safeInvariant(state.valid, 'ORDER_CAPABILITY_MISSING');
  safeInvariant(!state.exposed, 'ORDER_CAPABILITY_EXPOSED');
}

test('completes the isolated reserved customer demo lifecycle', async ({ page }) => {
  test.setTimeout(90_000);
  const guard = new BrowserSafetyGuard(page);
  const demoRequests: DemoRequestObservation[] = [];
  const adminApiRequests: string[] = [];
  page.on('request', (request) => {
    const parsed = sameOriginUrl(request.url());
    if (parsed === null) {
      return;
    }
    if (parsed.pathname.startsWith('/api/v1/admin')) {
      adminApiRequests.push(parsed.pathname);
    }
    if (!isApiPath(request, CUSTOMER_DEMO_SESSION_PATH)) {
      return;
    }
    const headers = request.headers();
    demoRequests.push({
      bodyAbsent: request.postData() === null,
      contentTypeAbsent: headers['content-type'] === undefined,
      cookieAbsent: headers.cookie === undefined,
      method: request.method(),
    });
  });

  let releaseCurrentUserResponse: () => void = () => undefined;
  const currentUserResponseGate = new Promise<void>((resolve) => {
    releaseCurrentUserResponse = resolve;
  });
  let captureCurrentUser: (observation: CurrentUserObservation) => void = () =>
    undefined;
  const currentUserCaptured = new Promise<CurrentUserObservation>((resolve) => {
    captureCurrentUser = resolve;
  });

  await page.route(`**${CURRENT_USER_PATH}`, async (route) => {
    const backendResponse = await route.fetch();
    captureCurrentUser(await inspectCurrentUserResponse(backendResponse));
    await currentUserResponseGate;
    await route.fulfill({ response: backendResponse });
  });

  try {
    await page.goto('/menu');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Our menu' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Try customer demo' }).click();
    await assertLocation(page, '/login');

    const sessionResponse = waitForApiResponse(
      page,
      'POST',
      CUSTOMER_DEMO_SESSION_PATH,
    );
    await page.getByRole('button', { name: 'Try customer demo' }).click();
    await assertResponseStatus(sessionResponse, 200, 'CUSTOMER_DEMO_STATUS_MISMATCH');
    const currentUser = await currentUserCaptured;
    safeInvariant(currentUser.status === 200, 'CURRENT_USER_STATUS_MISMATCH');
    safeInvariant(currentUser.activeCustomer, 'CURRENT_USER_ROLE_INVALID');
    safeInvariant(currentUser.exactIdentity, 'CURRENT_USER_IDENTITY_INVALID');
    safeInvariant(!currentUser.superAdministrator, 'CURRENT_USER_PRIVILEGE_INVALID');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Checking your session' }),
    ).toBeVisible();
    expect(demoRequests).toEqual([
      {
        bodyAbsent: true,
        contentTypeAbsent: true,
        cookieAbsent: true,
        method: 'POST',
      },
    ]);

    releaseCurrentUserResponse();
    await assertLocation(page, '/account');
    await expect(
      page.getByText('Customer demo · shared synthetic history', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeVisible();

    const foreignPath = `/api/v1/account/orders/${foreignOrderNumber}`;
    guard.expectHttpFailure('GET', foreignPath, 404);
    const foreignResponse = waitForApiResponse(page, 'GET', foreignPath);
    await page.goto(`/account/orders/${foreignOrderNumber}`);
    await assertResponseStatus(foreignResponse, 404, 'FOREIGN_ORDER_STATUS_MISMATCH');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Order unavailable' }),
    ).toBeVisible();
    await expect(
      page.getByText('This order is unavailable.', { exact: true }),
    ).toBeVisible();

    const redirectedAccountResponse = waitForApiResponse(
      page,
      'GET',
      '/api/v1/account/orders',
    );
    await page.goto('/admin');
    await assertResponseStatus(
      redirectedAccountResponse,
      200,
      'ADMIN_REDIRECT_ACCOUNT_STATUS_MISMATCH',
    );
    await assertLocation(page, '/account');
    await expect(
      page.getByRole('heading', { level: 1, name: 'My orders' }),
    ).toBeVisible();
    expect(adminApiRequests, 'ADMIN_API_REQUEST_OBSERVED').toEqual([]);

    const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
    await page.getByRole('link', { name: 'Menu', exact: true }).click();
    await assertResponseStatus(menuResponse, 200, 'MENU_STATUS_MISMATCH');
    const menuItem = page.getByRole('article', { exact: true, name: MENU_ITEM_NAME });
    await menuItem.getByRole('button', { name: 'Add to cart' }).click();

    const cartMenuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
    const quoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    await page.getByRole('link', { name: 'View cart', exact: true }).click();
    await Promise.all([
      assertResponseStatus(cartMenuResponse, 200, 'CART_MENU_STATUS_MISMATCH'),
      assertResponseStatus(quoteResponse, 200, 'QUOTE_STATUS_MISMATCH'),
    ]);
    const placeOrderButton = page.getByRole('button', {
      name: 'Place demo order and continue to simulated payment',
    });
    await expect(placeOrderButton).toBeEnabled();
    const freshQuoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
    const createOrderResponse = waitForApiResponse(page, 'POST', '/api/v1/orders');
    await placeOrderButton.click();
    await Promise.all([
      assertResponseStatus(freshQuoteResponse, 200, 'FRESH_QUOTE_STATUS_MISMATCH'),
      assertResponseStatus(createOrderResponse, 201, 'CREATE_ORDER_STATUS_MISMATCH'),
    ]);
    await expect(
      page.getByRole('heading', { level: 1, name: 'Order created' }),
    ).toBeVisible();
    const checkoutMatch =
      /^\/orders\/(ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12})\/checkout$/u.exec(
        new URL(page.url()).pathname,
      );
    safeInvariant(checkoutMatch !== null, 'CHECKOUT_ROUTE_INVALID');
    const publicOrderNumber = checkoutMatch[1];
    safeInvariant(
      publicOrderNumber !== undefined &&
        PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber),
      'PUBLIC_ORDER_NUMBER_INVALID',
    );
    await assertCapabilityStored(page, publicOrderNumber);

    const accountListResponse = waitForApiResponse(
      page,
      'GET',
      '/api/v1/account/orders',
    );
    await page.getByRole('link', { name: 'My account', exact: true }).click();
    await assertResponseStatus(
      accountListResponse,
      200,
      'ACCOUNT_LIST_STATUS_MISMATCH',
    );
    await expect(page.getByText(/Showing 1.*1 of 1/u)).toBeVisible();
    await expect(page.getByText(foreignOrderNumber, { exact: true })).toHaveCount(0);
    const ownOrderLink = page
      .getByRole('link', { exact: true, name: publicOrderNumber })
      .first();
    await expect(ownOrderLink).toBeVisible();

    const ownDetailPath = `/api/v1/account/orders/${publicOrderNumber}`;
    const ownDetailResponse = waitForApiResponse(page, 'GET', ownDetailPath);
    await ownOrderLink.click();
    await assertResponseStatus(ownDetailResponse, 200, 'OWN_ORDER_STATUS_MISMATCH');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Order details' }),
    ).toBeVisible();

    const checkoutOrderResponse = waitForApiResponse(
      page,
      'GET',
      `/api/v1/orders/${publicOrderNumber}`,
    );
    await page.goto(`/orders/${publicOrderNumber}/checkout`);
    await assertResponseStatus(
      checkoutOrderResponse,
      200,
      'CHECKOUT_ORDER_STATUS_MISMATCH',
    );
    const checkoutSessionResponse = waitForApiResponse(
      page,
      'POST',
      `/api/v1/orders/${publicOrderNumber}/checkout-session`,
    );
    await page
      .getByRole('button', { name: 'Run simulated payment', exact: true })
      .click();
    await assertResponseStatus(
      checkoutSessionResponse,
      201,
      'CHECKOUT_SESSION_STATUS_MISMATCH',
    );
    await expect(
      page.getByRole('heading', {
        level: 2,
        name: /^(Demo payment completed|Payment failed|Payment attempt expired)$/u,
      }),
    ).toBeVisible();
    await assertLocation(page, `/orders/${publicOrderNumber}/checkout`);
    await assertCapabilityStored(page, publicOrderNumber);

    const orderStatusResponse = waitForApiResponse(
      page,
      'GET',
      `/api/v1/orders/${publicOrderNumber}`,
    );
    await page.goto(`/orders/${publicOrderNumber}/status`);
    await assertResponseStatus(
      orderStatusResponse,
      200,
      'PUBLIC_ORDER_STATUS_MISMATCH',
    );
    await expect(
      page.getByRole('heading', { level: 1, name: 'Order status' }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Log out', exact: true }).click();
    await assertLocation(page, '/');
    const storageState = await page.evaluate(
      ({ authKey, demoKey }) => ({
        authPresent: sessionStorage.getItem(authKey) !== null,
        demoPresent: sessionStorage.getItem(demoKey) !== null,
      }),
      { authKey: AUTH_STORAGE_KEY, demoKey: DEMO_SESSION_STORAGE_KEY },
    );
    expect(storageState).toEqual({ authPresent: false, demoPresent: false });
    expect(demoRequests).toHaveLength(1);
    expect(adminApiRequests, 'ADMIN_API_REQUEST_OBSERVED').toEqual([]);
    guard.assertClean();
  } finally {
    releaseCurrentUserResponse();
    await page.unroute(`**${CURRENT_USER_PATH}`);
  }
});
