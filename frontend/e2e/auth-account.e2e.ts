import process from 'node:process';
import { URL } from 'node:url';

import {
  expect,
  test,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { requireEnvironmentValue, validateLoopbackBaseUrl } from './support/runtime';

const AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
const LEGACY_AUTH_STORAGE_KEY = 'restaurant-ordering:admin-auth:v1';
const MENU_ITEM_NAME = 'Roasted Root Vegetable Soup';
const CUSTOMER_ENVIRONMENT_NAMES = new Set([
  'E2E_CUSTOMER_A_EMAIL',
  'E2E_CUSTOMER_A_PASSWORD',
  'E2E_CUSTOMER_B_EMAIL',
  'E2E_CUSTOMER_B_PASSWORD',
]);
const CUSTOMER_EMAIL_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,63}@example\.com$/u;
const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/u;
const PUBLIC_ORDER_NUMBER_SEGMENT_PATTERN =
  /ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}/gu;
const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/iu;
const UUID_SEGMENT_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const PRIVATE_DETAIL_PATTERN =
  /\b(?:authorization|bearer|owner|ownership|payment|stripe|token|user[_ -]?id)\b/iu;
const CRITICAL_RESOURCE_TYPES = new Set([
  'document',
  'fetch',
  'script',
  'stylesheet',
  'xhr',
]);
const baseOrigin = validateLoopbackBaseUrl(
  requireEnvironmentValue('E2E_BASE_URL', process.env),
);
const runId = requireEnvironmentValue('E2E_RUN_ID', process.env);

interface SyntheticIdentity {
  readonly email: string;
  readonly password: string;
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

function requireCustomerEnvironmentValue(name: string): string {
  if (!CUSTOMER_ENVIRONMENT_NAMES.has(name)) {
    throw new Error('E2E_CUSTOMER_ENVIRONMENT_NAME_INVALID');
  }
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error('E2E_CUSTOMER_ENVIRONMENT_VALUE_MISSING');
  }
  return value;
}

function loadSyntheticIdentity(label: 'a' | 'b'): SyntheticIdentity {
  const upperLabel = label.toUpperCase();
  const email = requireCustomerEnvironmentValue(`E2E_CUSTOMER_${upperLabel}_EMAIL`);
  const password = requireCustomerEnvironmentValue(
    `E2E_CUSTOMER_${upperLabel}_PASSWORD`,
  );
  if (
    email.trim() !== email ||
    !CUSTOMER_EMAIL_PATTERN.test(email) ||
    !email
      .slice(0, email.indexOf('@'))
      .split(/[._+-]/u)
      .includes(runId)
  ) {
    throw new Error('E2E_CUSTOMER_EMAIL_INVALID');
  }
  const passwordLength = Array.from(password).length;
  if (passwordLength < 15 || passwordLength > 128) {
    throw new Error('E2E_CUSTOMER_PASSWORD_INVALID');
  }
  return Object.freeze({ email, password });
}

function sanitizePathname(pathname: string): string {
  return pathname
    .replace(PUBLIC_ORDER_NUMBER_SEGMENT_PATTERN, ':public-order')
    .replace(UUID_SEGMENT_PATTERN, ':id');
}

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

function isCriticalRequest(request: Request): boolean {
  return CRITICAL_RESOURCE_TYPES.has(request.resourceType());
}

function isForbiddenLifecyclePath(pathname: string): boolean {
  return (
    pathname === '/api/v1/admin' ||
    pathname.startsWith('/api/v1/admin/') ||
    pathname === '/api/v1/payments' ||
    pathname.startsWith('/api/v1/payments/') ||
    pathname.endsWith('/checkout-session')
  );
}

class BrowserSafetyGuard {
  private readonly expectedHttpFailures: ExpectedHttpFailure[] = [];
  private readonly issues: string[] = [];

  constructor(page: Page) {
    page.on('console', (message) => {
      if (message.type() === 'error' && !this.isExpectedNetworkConsoleError(message)) {
        this.issues.push('console:error');
      }
    });
    page.on('pageerror', () => {
      this.issues.push('page:error');
    });
    page.on('request', (request) => {
      const parsed = sameOriginUrl(request.url());
      if (parsed !== null && isForbiddenLifecyclePath(parsed.pathname)) {
        this.issues.push(
          `forbidden-request:${request.method()}:${sanitizePathname(parsed.pathname)}`,
        );
      }
    });
    page.on('requestfailed', (request) => {
      const parsed = sameOriginUrl(request.url());
      if (parsed !== null && isCriticalRequest(request)) {
        this.issues.push(
          `request-failed:${request.method()}:${sanitizePathname(parsed.pathname)}`,
        );
      }
    });
    page.on('response', (response) => {
      this.recordFailedResponse(response);
    });
  }

  expectHttpFailure(method: string, pathname: string, status: number): void {
    const existing = this.expectedHttpFailures.find(
      (failure) =>
        failure.method === method &&
        failure.pathname === pathname &&
        failure.status === status,
    );
    if (existing === undefined) {
      this.expectedHttpFailures.push({ method, pathname, remaining: 1, status });
      return;
    }
    existing.remaining += 1;
  }

  assertExpectedFailuresConsumed(): void {
    const outstanding = this.expectedHttpFailures
      .filter((failure) => failure.remaining > 0)
      .map(
        (failure) =>
          `${failure.method}:${sanitizePathname(failure.pathname)}:${failure.status}:${failure.remaining}`,
      );
    expect(outstanding, 'EXPECTED_HTTP_FAILURE_NOT_OBSERVED').toEqual([]);
  }

  assertClean(): void {
    this.assertExpectedFailuresConsumed();
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
    const method = response.request().method();
    const expected = this.expectedHttpFailures.find(
      (failure) =>
        failure.remaining > 0 &&
        failure.method === method &&
        failure.pathname === parsed.pathname &&
        failure.status === response.status(),
    );
    if (expected !== undefined) {
      expected.remaining -= 1;
      return;
    }
    this.issues.push(
      `http-failure:${method}:${sanitizePathname(parsed.pathname)}:${response.status()}`,
    );
  }

  private isExpectedNetworkConsoleError(message: ConsoleMessage): boolean {
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

const guards = new WeakMap<Page, BrowserSafetyGuard>();

function guardFor(page: Page): BrowserSafetyGuard {
  const guard = guards.get(page);
  safeInvariant(guard !== undefined, 'BROWSER_SAFETY_GUARD_MISSING');
  return guard;
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

async function assertLocation(
  page: Page,
  pathname: string,
  search = '',
): Promise<void> {
  await expect
    .poll(
      () => {
        const current = new URL(page.url());
        return { pathname: current.pathname, search: current.search };
      },
      { message: 'LOCATION_MISMATCH' },
    )
    .toEqual({ pathname, search });
}

async function registerCustomer(
  page: Page,
  identity: SyntheticIdentity,
): Promise<void> {
  await expect(
    page.getByRole('heading', { level: 1, name: 'Create account' }),
  ).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
  await page.getByLabel('Password', { exact: true }).fill(identity.password);
  await page.getByLabel('Confirm password', { exact: true }).fill(identity.password);

  const registrationResponse = waitForApiResponse(
    page,
    'POST',
    '/api/v1/auth/register',
  );
  const currentUserResponse = waitForApiResponse(page, 'GET', '/api/v1/auth/me');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await Promise.all([
    assertResponseStatus(registrationResponse, 201, 'REGISTRATION_STATUS_MISMATCH'),
    assertResponseStatus(currentUserResponse, 200, 'CURRENT_USER_STATUS_MISMATCH'),
  ]);

  await assertLocation(page, '/account');
  await expect(
    page.getByRole('heading', { level: 1, name: 'My orders' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
  const navigation = page.getByRole('navigation', { name: 'Customer navigation' });
  await expect(navigation.getByRole('link', { name: 'My account' })).toBeVisible();
  await expect(navigation.getByRole('link', { name: 'Admin' })).toHaveCount(0);
}

async function loginCustomer(page: Page, identity: SyntheticIdentity): Promise<void> {
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
  await page.getByLabel('Password', { exact: true }).fill(identity.password);

  const loginResponse = waitForApiResponse(page, 'POST', '/api/v1/auth/login');
  const currentUserResponse = waitForApiResponse(page, 'GET', '/api/v1/auth/me');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await Promise.all([
    assertResponseStatus(loginResponse, 200, 'LOGIN_STATUS_MISMATCH'),
    assertResponseStatus(currentUserResponse, 200, 'CURRENT_USER_STATUS_MISMATCH'),
  ]);

  await assertLocation(page, '/account');
  await expect(
    page.getByRole('heading', { level: 1, name: 'My orders' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
}

async function logoutToHome(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await assertLocation(page, '/');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Fresh food, ordered your way',
    }),
  ).toBeVisible();
  const authStorageRemains = await page.evaluate(
    ({ canonicalKey, legacyKey }) => {
      const storage = (
        globalThis as typeof globalThis & {
          sessionStorage: { getItem: (key: string) => string | null };
        }
      ).sessionStorage;
      return (
        storage.getItem(canonicalKey) !== null || storage.getItem(legacyKey) !== null
      );
    },
    {
      canonicalKey: AUTH_STORAGE_KEY,
      legacyKey: LEGACY_AUTH_STORAGE_KEY,
    },
  );
  expect(authStorageRemains, 'AUTH_STORAGE_NOT_CLEARED').toBe(false);
}

function containsPrivateDetails(
  visibleText: string,
  identities: readonly SyntheticIdentity[],
): boolean {
  const normalizedText = visibleText.toLocaleLowerCase('en-US');
  return (
    identities.some((identity) =>
      normalizedText.includes(identity.email.toLocaleLowerCase('en-US')),
    ) ||
    UUID_PATTERN.test(visibleText) ||
    PRIVATE_DETAIL_PATTERN.test(visibleText)
  );
}

async function assertCustomerSafeMainContent(
  page: Page,
  identities: readonly SyntheticIdentity[],
): Promise<void> {
  const visibleText = await page.locator('#main-content').innerText();
  expect(
    containsPrivateDetails(visibleText, identities),
    'PRIVATE_CUSTOMER_DETAIL_RENDERED',
  ).toBe(false);
}

test.beforeEach(async ({ page }) => {
  guards.set(page, new BrowserSafetyGuard(page));
});

test.afterEach(async ({ page }) => {
  guardFor(page).assertClean();
});

test('isolates canonical customer authentication and personally owned orders', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const customerA = loadSyntheticIdentity('a');
  const customerB = loadSyntheticIdentity('b');
  safeInvariant(
    customerA.email !== customerB.email && customerA.password !== customerB.password,
    'E2E_CUSTOMER_IDENTITIES_NOT_UNIQUE',
  );
  const identities = [customerA, customerB] as const;

  await page.goto('/');
  await expect(
    page.getByRole('heading', {
      level: 1,
      name: 'Fresh food, ordered your way',
    }),
  ).toBeVisible();

  await page
    .locator('#main-content')
    .getByRole('link', { name: 'Create account', exact: true })
    .click();
  await registerCustomer(page, customerA);
  await logoutToHome(page);

  await page.goto('/account');
  await assertLocation(page, '/login', '?next=%2Faccount');
  await loginCustomer(page, customerA);

  const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.getByRole('link', { name: 'Menu', exact: true }).click();
  await assertResponseStatus(menuResponse, 200, 'MENU_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();
  const menuItem = page.getByRole('article', {
    exact: true,
    name: MENU_ITEM_NAME,
  });
  await expect(menuItem).toBeVisible();
  await menuItem.getByRole('button', { name: 'Add to cart' }).click();
  await expect(menuItem.getByText('1 in cart', { exact: true })).toBeVisible();

  const cartMenuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  const initialQuoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  await page.getByRole('link', { name: 'View cart', exact: true }).click();
  await Promise.all([
    assertResponseStatus(cartMenuResponse, 200, 'CART_MENU_STATUS_MISMATCH'),
    assertResponseStatus(initialQuoteResponse, 200, 'INITIAL_QUOTE_STATUS_MISMATCH'),
  ]);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Your cart' }),
  ).toBeVisible();
  const placeOrderButton = page.getByRole('button', {
    name: 'Place order and continue to payment',
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
  await expect(
    page.getByRole('button', { name: 'Continue to secure payment' }),
  ).toBeVisible();
  const checkoutPathMatch =
    /^\/orders\/(ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12})\/checkout$/u.exec(
      new URL(page.url()).pathname,
    );
  safeInvariant(checkoutPathMatch !== null, 'CHECKOUT_ROUTE_INVALID');
  const publicOrderNumber = checkoutPathMatch[1];
  safeInvariant(
    publicOrderNumber !== undefined &&
      PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber),
    'PUBLIC_ORDER_NUMBER_INVALID',
  );

  const accountListResponse = waitForApiResponse(page, 'GET', '/api/v1/account/orders');
  await page.getByRole('link', { name: 'My account', exact: true }).click();
  await assertResponseStatus(accountListResponse, 200, 'ACCOUNT_LIST_STATUS_MISMATCH');
  await assertLocation(page, '/account');
  await expect(
    page.getByRole('heading', { level: 1, name: 'My orders' }),
  ).toBeVisible();
  await expect(page.getByText(/Showing 1.*1 of 1/u)).toBeVisible();
  const ownedOrderLink = page
    .getByRole('link', { exact: true, name: publicOrderNumber })
    .first();
  await expect(ownedOrderLink).toBeVisible();
  await assertCustomerSafeMainContent(page, identities);

  const accountDetailPath = `/api/v1/account/orders/${publicOrderNumber}`;
  const accountDetailResponse = waitForApiResponse(page, 'GET', accountDetailPath);
  await ownedOrderLink.click();
  await assertResponseStatus(
    accountDetailResponse,
    200,
    'ACCOUNT_DETAIL_STATUS_MISMATCH',
  );
  await assertLocation(page, `/account/orders/${publicOrderNumber}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order details' }),
  ).toBeVisible();
  await expect(page.getByText(publicOrderNumber, { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Order received' })).toBeVisible();
  await expect(
    page.getByRole('heading', { exact: true, level: 2, name: 'What you ordered' }),
  ).toBeVisible();
  await assertCustomerSafeMainContent(page, identities);
  await logoutToHome(page);

  await page
    .locator('#main-content')
    .getByRole('link', { name: 'Create account', exact: true })
    .click();
  await registerCustomer(page, customerB);
  await logoutToHome(page);
  await page
    .locator('#main-content')
    .getByRole('link', { name: 'Log in', exact: true })
    .click();
  await assertLocation(page, '/login');
  await loginCustomer(page, customerB);

  const guard = guardFor(page);
  guard.expectHttpFailure('GET', accountDetailPath, 404);
  const revalidationResponse = waitForApiResponse(page, 'GET', '/api/v1/auth/me');
  const crossUserResponse = waitForApiResponse(page, 'GET', accountDetailPath);
  await page.goto(`/account/orders/${publicOrderNumber}`);
  await Promise.all([
    assertResponseStatus(revalidationResponse, 200, 'CURRENT_USER_STATUS_MISMATCH'),
    assertResponseStatus(crossUserResponse, 404, 'CROSS_USER_STATUS_MISMATCH'),
  ]);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order unavailable' }),
  ).toBeVisible();
  await expect(
    page.getByText('This order is unavailable.', { exact: true }),
  ).toBeVisible();
  await assertCustomerSafeMainContent(page, identities);
  guard.assertExpectedFailuresConsumed();

  const adminRevalidationResponse = waitForApiResponse(page, 'GET', '/api/v1/auth/me');
  const redirectedAccountResponse = waitForApiResponse(
    page,
    'GET',
    '/api/v1/account/orders',
  );
  await page.goto('/admin');
  await Promise.all([
    assertResponseStatus(
      adminRevalidationResponse,
      200,
      'CURRENT_USER_STATUS_MISMATCH',
    ),
    assertResponseStatus(
      redirectedAccountResponse,
      200,
      'REDIRECTED_ACCOUNT_STATUS_MISMATCH',
    ),
  ]);
  await assertLocation(page, '/account');
  await expect(
    page.getByRole('heading', { level: 1, name: 'My orders' }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { name: 'No orders yet' })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Administrator workspace' }),
  ).toHaveCount(0);

  await logoutToHome(page);
  await page
    .locator('#main-content')
    .getByRole('link', { name: 'Log in', exact: true })
    .click();
  await assertLocation(page, '/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  guard.assertClean();
});
