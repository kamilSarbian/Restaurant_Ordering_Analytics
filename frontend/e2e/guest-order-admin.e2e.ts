import process from 'node:process';
import { URL } from 'node:url';

import {
  expect,
  test,
  type BrowserContext,
  type ConsoleMessage,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { requireEnvironmentValue, validateLoopbackBaseUrl } from './support/runtime';

const MENU_ITEM_NAME = 'Roasted Root Vegetable Soup';
const ORDER_ACCESS_STORAGE_PREFIX = 'restaurant-ordering:order-access:v1:';
const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/u;
const PUBLIC_ORDER_NUMBER_SEGMENT_PATTERN =
  /ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}/gu;
const UUID_SEGMENT_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu;
const ADMIN_USER_ROLE_PATH_PATTERN =
  /^\/api\/v1\/admin\/users\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/role$/iu;
const FAKE_CHECKOUT_PATH = '/api/v1/e2e/fake-checkout';
const FAKE_CHECKOUT_SCRIPT_PATH = '/api/v1/e2e/fake-checkout.js';
const FAKE_CHECKOUT_COMPLETION_PATH = '/api/v1/e2e/fake-checkout/complete';
const STRIPE_WEBHOOK_PATH = '/api/v1/stripe/webhook';
const SYNTHETIC_ENVIRONMENT_NAMES = new Set([
  'E2E_ADMIN_EMAIL',
  'E2E_ADMIN_PASSWORD',
  'E2E_PROMOTEE_EMAIL',
  'E2E_PROMOTEE_PASSWORD',
]);
const CUSTOMER_EMAIL_PATTERN = /^[a-z0-9][a-z0-9._+-]{0,63}@example\.com$/u;
const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:access|auth|capability|credential|password|secret|signature|token)/iu;
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
  consoleRemaining: number;
  readonly method: string;
  readonly pathname: string;
  readonly status: number;
  remaining: number;
}

interface AdminTransition {
  readonly actionLabel: string;
  readonly confirmation: string;
  readonly expectedStatus: string;
}

interface SafeLocation {
  readonly origin: string;
  readonly pathname: string;
  readonly search: string;
}

function safeInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function requireSyntheticEnvironmentValue(name: string): string {
  if (!SYNTHETIC_ENVIRONMENT_NAMES.has(name)) {
    throw new Error('E2E_SYNTHETIC_ENVIRONMENT_NAME_INVALID');
  }
  const value = process.env[name];
  if (value === undefined || value.length === 0 || value.trim() !== value) {
    throw new Error('E2E_SYNTHETIC_ENVIRONMENT_VALUE_INVALID');
  }
  return value;
}

function validatePassword(password: string, code: string): void {
  const length = Array.from(password).length;
  if (length < 15 || length > 128) {
    throw new Error(code);
  }
}

function loadScenarioIdentities(): {
  readonly administrator: SyntheticIdentity;
  readonly promotee: SyntheticIdentity;
} {
  const administrator = Object.freeze({
    email: requireSyntheticEnvironmentValue('E2E_ADMIN_EMAIL'),
    password: requireSyntheticEnvironmentValue('E2E_ADMIN_PASSWORD'),
  });
  const promotee = Object.freeze({
    email: requireSyntheticEnvironmentValue('E2E_PROMOTEE_EMAIL'),
    password: requireSyntheticEnvironmentValue('E2E_PROMOTEE_PASSWORD'),
  });
  if (administrator.email !== `stage18-admin-${runId}@example.com`) {
    throw new Error('E2E_ADMIN_EMAIL_INVALID');
  }
  if (
    promotee.email !== `stage18-promotee-${runId}@example.com` ||
    !CUSTOMER_EMAIL_PATTERN.test(promotee.email)
  ) {
    throw new Error('E2E_PROMOTEE_EMAIL_INVALID');
  }
  validatePassword(administrator.password, 'E2E_ADMIN_PASSWORD_INVALID');
  validatePassword(promotee.password, 'E2E_PROMOTEE_PASSWORD_INVALID');
  if (
    administrator.email === promotee.email ||
    administrator.password === promotee.password
  ) {
    throw new Error('E2E_SYNTHETIC_IDENTITIES_NOT_UNIQUE');
  }
  return Object.freeze({ administrator, promotee });
}

function parseUrl(rawUrl: string): URL | null {
  try {
    return new URL(rawUrl);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function sameOriginUrl(rawUrl: string): URL | null {
  const parsed = parseUrl(rawUrl);
  return parsed !== null && parsed.origin === baseOrigin ? parsed : null;
}

function isCriticalRequest(request: Request): boolean {
  return CRITICAL_RESOURCE_TYPES.has(request.resourceType());
}

function isStripeHost(hostname: string): boolean {
  const normalized = hostname.toLocaleLowerCase('en-US');
  return [
    'stripe.com',
    'stripe.dev',
    'stripe.network',
    'stripeassets.com',
    'stripecdn.com',
    'stripepayments.com',
  ].some((suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`));
}

function sanitizePathname(pathname: string): string {
  return pathname
    .replace(PUBLIC_ORDER_NUMBER_SEGMENT_PATTERN, ':public-order')
    .replace(UUID_SEGMENT_PATTERN, ':id');
}

function isAllowedE2ERequest(method: string, pathname: string): boolean {
  return (
    (method === 'GET' &&
      (pathname === FAKE_CHECKOUT_PATH || pathname === FAKE_CHECKOUT_SCRIPT_PATH)) ||
    (method === 'POST' && pathname === FAKE_CHECKOUT_COMPLETION_PATH)
  );
}

class BrowserSafetyGuard {
  private readonly expectedHttpFailures: ExpectedHttpFailure[] = [];
  private readonly issues: string[] = [];
  private readonly sensitiveValues = new Set<string>();

  constructor(page: Page, sensitiveValues: readonly string[]) {
    for (const value of sensitiveValues) {
      this.addSensitiveValue(value);
    }
    page.on('console', (message) => {
      if (message.type() !== 'error') {
        return;
      }
      if (this.containsSensitiveValue(message.text())) {
        this.issues.push('console-sensitive-value');
        return;
      }
      if (!this.isExpectedNetworkConsoleError(message)) {
        this.issues.push('console:error');
      }
    });
    page.on('pageerror', () => {
      this.issues.push('page:error');
    });
    page.on('request', (request) => {
      this.recordRequest(request);
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

  addSensitiveValue(value: string): void {
    if (value.length > 0) {
      this.sensitiveValues.add(value);
    }
  }

  expectHttpFailure(method: string, pathname: string, status: number): void {
    const existing = this.expectedHttpFailures.find(
      (failure) =>
        failure.method === method &&
        failure.pathname === pathname &&
        failure.status === status,
    );
    if (existing === undefined) {
      this.expectedHttpFailures.push({
        consoleRemaining: 1,
        method,
        pathname,
        remaining: 1,
        status,
      });
      return;
    }
    existing.consoleRemaining += 1;
    existing.remaining += 1;
  }

  assertExpectedFailuresConsumed(): void {
    const outstandingResponses = this.expectedHttpFailures
      .filter((failure) => failure.remaining > 0)
      .map(
        (failure) =>
          `${failure.method}:${sanitizePathname(failure.pathname)}:${failure.status}:${failure.remaining}`,
      );
    const outstandingDiagnostics = this.expectedHttpFailures
      .filter((failure) => failure.consoleRemaining > 0)
      .map(
        (failure) =>
          `${failure.method}:${sanitizePathname(failure.pathname)}:${failure.status}:${failure.consoleRemaining}`,
      );
    expect(outstandingResponses, 'EXPECTED_HTTP_FAILURE_NOT_OBSERVED').toEqual([]);
    expect(outstandingDiagnostics, 'EXPECTED_HTTP_DIAGNOSTIC_NOT_OBSERVED').toEqual([]);
  }

  assertClean(): void {
    this.assertExpectedFailuresConsumed();
    expect([...new Set(this.issues)], 'UNEXPECTED_BROWSER_FAILURE').toEqual([]);
  }

  private containsSensitiveValue(value: string): boolean {
    return [...this.sensitiveValues].some((sensitive) => value.includes(sensitive));
  }

  private recordRequest(request: Request): void {
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      if (isCriticalRequest(request)) {
        this.issues.push('critical-request-url-invalid');
      }
      return;
    }
    if (isStripeHost(parsed.hostname)) {
      this.issues.push('real-stripe-request');
      return;
    }
    if (parsed.origin !== baseOrigin) {
      if (isCriticalRequest(request)) {
        this.issues.push(`external-critical-request:${request.resourceType()}`);
      }
      return;
    }
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      this.containsSensitiveValue(request.url())
    ) {
      this.issues.push('sensitive-request-url');
    }
    if (
      [...parsed.searchParams.keys()].some((name) =>
        SENSITIVE_QUERY_NAME_PATTERN.test(name),
      )
    ) {
      this.issues.push('sensitive-query-name');
    }
    if (
      parsed.pathname.startsWith('/api/v1/e2e/') &&
      !isAllowedE2ERequest(request.method(), parsed.pathname)
    ) {
      this.issues.push('unexpected-e2e-request');
    }
    if (parsed.pathname === STRIPE_WEBHOOK_PATH) {
      this.issues.push('browser-webhook-request');
    }
    if (
      parsed.pathname === '/api/v1/admin/auth/login' ||
      parsed.pathname === '/api/v1/admin/auth/me'
    ) {
      this.issues.push('legacy-admin-auth-request');
    }
  }

  private recordFailedResponse(response: Response): void {
    if (response.status() < 400) {
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
      !/^Failed to load resource: the server responded with a status of 409 \(Conflict\)$/u.test(
        message.text(),
      )
    ) {
      return false;
    }
    const parsed = sameOriginUrl(message.location().url);
    if (parsed === null) {
      return false;
    }
    const expected = this.expectedHttpFailures.find(
      (failure) =>
        failure.consoleRemaining > 0 &&
        failure.method === 'PATCH' &&
        failure.pathname === parsed.pathname &&
        failure.status === 409,
    );
    if (expected === undefined) {
      return false;
    }
    expected.consoleRemaining -= 1;
    return true;
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

function waitForApiResponsePattern(
  page: Page,
  method: string,
  pathnamePattern: RegExp,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = sameOriginUrl(response.url());
    return (
      parsed !== null &&
      pathnamePattern.test(parsed.pathname) &&
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

async function readSafeLocation(page: Page): Promise<SafeLocation> {
  return page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & {
      location: { origin: string; pathname: string; search: string };
    };
    return {
      origin: runtime.location.origin,
      pathname: runtime.location.pathname,
      search: runtime.location.search,
    };
  });
}

async function assertLocation(
  page: Page,
  pathname: string,
  search = '',
): Promise<void> {
  await expect
    .poll(() => readSafeLocation(page), { message: 'LOCATION_MISMATCH' })
    .toEqual({ origin: baseOrigin, pathname, search });
}

async function assertFakeCheckoutLocation(page: Page): Promise<void> {
  await expect
    .poll(() => readSafeLocation(page), {
      message: 'FAKE_CHECKOUT_LOCATION_INVALID',
    })
    .toEqual({ origin: baseOrigin, pathname: FAKE_CHECKOUT_PATH, search: '' });
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const runtime = globalThis as typeof globalThis & {
            location: { hash: string };
          };
          return runtime.location.hash === '';
        }),
      { message: 'FAKE_CHECKOUT_FRAGMENT_NOT_CLEARED' },
    )
    .toBe(true);
}

async function registerCustomer(
  page: Page,
  identity: SyntheticIdentity,
): Promise<void> {
  await page.goto('/register');
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
}

async function loginIdentity(
  page: Page,
  identity: SyntheticIdentity,
  destination: '/admin',
): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(destination)}`);
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
  await assertLocation(page, destination);
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
}

async function assertGuestCapabilityInternal(
  page: Page,
  publicOrderNumber: string,
): Promise<void> {
  const state = await page.evaluate(
    ({ prefix, orderNumber }) => {
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
        const candidate: unknown = JSON.parse(serialized);
        if (
          typeof candidate !== 'object' ||
          candidate === null ||
          !('publicOrderNumber' in candidate) ||
          candidate.publicOrderNumber !== orderNumber ||
          !('token' in candidate) ||
          typeof candidate.token !== 'string' ||
          candidate.token.trim().length === 0 ||
          !('version' in candidate) ||
          candidate.version !== 1
        ) {
          return { exposed: false, valid: false };
        }
        return {
          exposed:
            runtime.location.href.includes(candidate.token) ||
            (runtime.document.body?.innerText.includes(candidate.token) ?? false),
          valid: true,
        };
      } catch (error: unknown) {
        void error;
        return { exposed: false, valid: false };
      }
    },
    { orderNumber: publicOrderNumber, prefix: ORDER_ACCESS_STORAGE_PREFIX },
  );
  safeInvariant(state.valid, 'GUEST_CAPABILITY_MISSING');
  safeInvariant(state.exposed === false, 'GUEST_CAPABILITY_EXPOSED');
}

function adminOrderSummary(page: Page) {
  return page.getByRole('heading', { level: 2, name: 'Order summary' }).locator('..');
}

function adminPaymentAttempt(page: Page) {
  return page
    .getByRole('heading', { level: 3, name: 'Payment attempt 1' })
    .locator('..');
}

async function assertAdminOrderStatus(page: Page, status: string): Promise<void> {
  const statusBadge = adminOrderSummary(page).locator(
    `[data-status="${status.toLowerCase()}"]`,
  );
  await expect(statusBadge).toHaveCount(1);
  await expect(statusBadge).toHaveText(status);
}

async function denyUnpaidAcceptance(
  page: Page,
  guard: BrowserSafetyGuard,
  publicOrderNumber: string,
): Promise<void> {
  const statusPath = `/api/v1/admin/orders/${publicOrderNumber}/status`;
  await page.getByRole('button', { name: 'Accept order', exact: true }).click();
  const confirmation = page.getByRole('group', { name: 'Accept this order?' });
  await expect(confirmation).toBeVisible();

  guard.expectHttpFailure('PATCH', statusPath, 409);
  const mutationResponse = waitForApiResponse(page, 'PATCH', statusPath);
  const refreshResponse = waitForApiResponse(
    page,
    'GET',
    `/api/v1/admin/orders/${publicOrderNumber}`,
  );
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await Promise.all([
    assertResponseStatus(mutationResponse, 409, 'UNPAID_ACCEPTANCE_STATUS_MISMATCH'),
    assertResponseStatus(refreshResponse, 200, 'UNPAID_REFRESH_STATUS_MISMATCH'),
  ]);
  await expect(
    page.getByText(
      'The order changed or this action is not currently allowed. The latest order details have been loaded.',
      { exact: true },
    ),
  ).toBeVisible();
  guard.assertExpectedFailuresConsumed();
  await assertAdminOrderStatus(page, 'Created');
  await expect(
    adminPaymentAttempt(page).getByText('Pending', { exact: true }),
  ).toBeVisible();
}

async function applyAdminTransition(
  page: Page,
  publicOrderNumber: string,
  transition: AdminTransition,
): Promise<void> {
  const statusPath = `/api/v1/admin/orders/${publicOrderNumber}/status`;
  await page.getByRole('button', { name: transition.actionLabel, exact: true }).click();
  const confirmation = page.getByRole('group', {
    name: transition.confirmation,
  });
  await expect(confirmation).toBeVisible();

  const mutationResponse = waitForApiResponse(page, 'PATCH', statusPath);
  const refreshResponse = waitForApiResponse(
    page,
    'GET',
    `/api/v1/admin/orders/${publicOrderNumber}`,
  );
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await Promise.all([
    assertResponseStatus(mutationResponse, 200, 'ORDER_TRANSITION_STATUS_MISMATCH'),
    assertResponseStatus(refreshResponse, 200, 'ORDER_TRANSITION_REFRESH_MISMATCH'),
  ]);
  await expect(page.getByText('Order status updated.', { exact: true })).toBeVisible();
  await assertAdminOrderStatus(page, transition.expectedStatus);
}

async function assertSuperAdminIsReadOnly(page: Page): Promise<void> {
  const usersTable = page.getByRole('table', {
    name: 'Registered users, oldest first',
  });
  const superAdminRow = usersTable.locator('tbody tr').filter({
    has: page.getByText('Super administrator', { exact: true }),
  });
  await expect(superAdminRow).toHaveCount(1);
  await expect(superAdminRow.getByText('Read only', { exact: true })).toBeVisible();
  await expect(superAdminRow.getByRole('button')).toHaveCount(0);
}

async function promoteCustomer(page: Page, identity: SyntheticIdentity): Promise<void> {
  const usersTable = page.getByRole('table', {
    name: 'Registered users, oldest first',
  });
  const customerRow = usersTable
    .locator('tbody tr')
    .filter({ hasText: identity.email });
  await expect(customerRow).toHaveCount(1);
  await expect(customerRow.getByText('Customer', { exact: true })).toBeVisible();
  await customerRow.getByRole('button', { name: /^Promote to admin for /u }).click();

  const confirmation = page.getByRole('group', { name: 'Confirm role change' });
  await expect(confirmation).toBeVisible();
  const mutationResponse = waitForApiResponsePattern(
    page,
    'PATCH',
    ADMIN_USER_ROLE_PATH_PATTERN,
  );
  const refreshResponse = waitForApiResponse(page, 'GET', '/api/v1/admin/users');
  await confirmation.getByRole('button', { name: 'Confirm', exact: true }).click();
  await Promise.all([
    assertResponseStatus(mutationResponse, 200, 'USER_PROMOTION_STATUS_MISMATCH'),
    assertResponseStatus(refreshResponse, 200, 'USER_PROMOTION_REFRESH_MISMATCH'),
  ]);
  await expect(
    page.getByText('The role was updated and the authoritative user list was loaded.', {
      exact: true,
    }),
  ).toBeVisible();
  await expect(customerRow.getByText('Administrator', { exact: true })).toBeVisible();
}

function requestMatches(request: Request, method: string, pathname: string): boolean {
  const parsed = sameOriginUrl(request.url());
  return parsed !== null && parsed.pathname === pathname && request.method() === method;
}

async function closeContexts(contexts: readonly BrowserContext[]): Promise<void> {
  let cleanupFailed = false;
  for (const context of [...contexts].reverse()) {
    try {
      await context.close();
    } catch (error: unknown) {
      void error;
      cleanupFailed = true;
    }
  }
  if (cleanupFailed) {
    throw new Error('E2E_CONTEXT_CLEANUP_FAILED');
  }
}

test.describe.configure({ mode: 'serial' });

test('completes guest payment and administrator governance without external trust', async ({
  browser,
  page: guestPage,
}) => {
  test.setTimeout(120_000);
  const { administrator, promotee } = loadScenarioIdentities();
  const initialSensitiveValues = [
    administrator.email,
    administrator.password,
    promotee.email,
    promotee.password,
  ];
  const guestGuard = new BrowserSafetyGuard(guestPage, initialSensitiveValues);
  const contextsToClose: BrowserContext[] = [];
  const guards: BrowserSafetyGuard[] = [guestGuard];

  let finalizationError: unknown;
  let scenarioError: unknown;
  try {
    const promoteeContext = await browser.newContext({ baseURL: baseOrigin });
    contextsToClose.push(promoteeContext);
    const promoteePage = await promoteeContext.newPage();
    const promoteeGuard = new BrowserSafetyGuard(promoteePage, initialSensitiveValues);
    guards.push(promoteeGuard);

    const adminContext = await browser.newContext({ baseURL: baseOrigin });
    contextsToClose.push(adminContext);
    const adminPage = await adminContext.newPage();
    const adminGuard = new BrowserSafetyGuard(adminPage, initialSensitiveValues);
    guards.push(adminGuard);

    const menuResponse = waitForApiResponse(guestPage, 'GET', '/api/v1/menu');
    await guestPage.goto('/menu');
    await assertResponseStatus(menuResponse, 200, 'MENU_STATUS_MISMATCH');
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Our menu' }),
    ).toBeVisible();
    const menuItem = guestPage.getByRole('article', {
      exact: true,
      name: MENU_ITEM_NAME,
    });
    await expect(menuItem).toBeVisible();
    await menuItem.getByRole('button', { name: 'Add to cart' }).click();
    await expect(menuItem.getByText('1 in cart', { exact: true })).toBeVisible();

    const cartMenuResponse = waitForApiResponse(guestPage, 'GET', '/api/v1/menu');
    const quoteResponse = waitForApiResponse(guestPage, 'POST', '/api/v1/orders/quote');
    await guestPage.getByRole('link', { name: 'View cart', exact: true }).click();
    await Promise.all([
      assertResponseStatus(cartMenuResponse, 200, 'CART_MENU_STATUS_MISMATCH'),
      assertResponseStatus(quoteResponse, 200, 'QUOTE_STATUS_MISMATCH'),
    ]);
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Your cart' }),
    ).toBeVisible();
    await expect(
      guestPage.getByRole('radio', { name: 'Takeaway', exact: true }),
    ).toBeChecked();
    const placeOrderButton = guestPage.getByRole('button', {
      name: 'Place order and continue to payment',
    });
    await expect(placeOrderButton).toBeEnabled();

    const freshQuoteResponse = waitForApiResponse(
      guestPage,
      'POST',
      '/api/v1/orders/quote',
    );
    const createOrderResponse = waitForApiResponse(guestPage, 'POST', '/api/v1/orders');
    await placeOrderButton.click();
    await Promise.all([
      assertResponseStatus(freshQuoteResponse, 200, 'FRESH_QUOTE_STATUS_MISMATCH'),
      assertResponseStatus(createOrderResponse, 201, 'CREATE_ORDER_STATUS_MISMATCH'),
    ]);
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Order created' }),
    ).toBeVisible();
    const checkoutPath = await guestPage.evaluate(() => {
      const runtime = globalThis as typeof globalThis & {
        location: { pathname: string };
      };
      return runtime.location.pathname;
    });
    const checkoutMatch =
      /^\/orders\/(ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12})\/checkout$/u.exec(
        checkoutPath,
      );
    safeInvariant(checkoutMatch !== null, 'CHECKOUT_ROUTE_INVALID');
    const publicOrderNumber = checkoutMatch[1];
    safeInvariant(
      publicOrderNumber !== undefined &&
        PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber),
      'PUBLIC_ORDER_NUMBER_INVALID',
    );
    await assertGuestCapabilityInternal(guestPage, publicOrderNumber);

    const checkoutSessionResponse = waitForApiResponse(
      guestPage,
      'POST',
      `/api/v1/orders/${publicOrderNumber}/checkout-session`,
    );
    await guestPage
      .getByRole('button', { name: 'Continue to secure payment', exact: true })
      .click();
    await assertResponseStatus(
      checkoutSessionResponse,
      201,
      'CHECKOUT_SESSION_STATUS_MISMATCH',
    );
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Test Checkout' }),
    ).toBeVisible();
    await assertFakeCheckoutLocation(guestPage);

    await registerCustomer(promoteePage, promotee);
    await logoutToHome(promoteePage);

    await loginIdentity(adminPage, administrator, '/admin');
    await expect(
      adminPage.getByRole('heading', {
        level: 1,
        name: 'Administrator workspace',
      }),
    ).toBeVisible();
    const ordersResponse = waitForApiResponse(adminPage, 'GET', '/api/v1/admin/orders');
    await adminPage
      .getByRole('navigation', { name: 'Administrator navigation' })
      .getByRole('link', { name: 'Orders', exact: true })
      .click();
    await assertResponseStatus(ordersResponse, 200, 'ADMIN_ORDERS_STATUS_MISMATCH');
    const ordersTable = adminPage.getByRole('table', {
      name: 'Administrator orders, newest first',
    });
    const detailResponse = waitForApiResponse(
      adminPage,
      'GET',
      `/api/v1/admin/orders/${publicOrderNumber}`,
    );
    await ordersTable
      .getByRole('link', { name: publicOrderNumber, exact: true })
      .click();
    await assertResponseStatus(detailResponse, 200, 'ADMIN_ORDER_STATUS_MISMATCH');
    await expect(
      adminPage.getByRole('heading', {
        level: 1,
        name: `Order ${publicOrderNumber}`,
      }),
    ).toBeVisible();
    await assertAdminOrderStatus(adminPage, 'Created');
    await expect(adminPaymentAttempt(adminPage)).toHaveCount(1);
    await expect(
      adminPaymentAttempt(adminPage).getByText('Pending', { exact: true }),
    ).toBeVisible();
    await denyUnpaidAcceptance(adminPage, adminGuard, publicOrderNumber);

    let completionRequestCount = 0;
    const countCompletionRequest = (request: Request) => {
      if (requestMatches(request, 'POST', FAKE_CHECKOUT_COMPLETION_PATH)) {
        completionRequestCount += 1;
      }
    };
    guestPage.on('request', countCompletionRequest);
    try {
      const completionResponse = waitForApiResponse(
        guestPage,
        'POST',
        FAKE_CHECKOUT_COMPLETION_PATH,
      );
      await guestPage
        .getByRole('button', { name: 'Complete test payment', exact: true })
        .click();
      await assertResponseStatus(
        completionResponse,
        200,
        'FAKE_CHECKOUT_COMPLETION_STATUS_MISMATCH',
      );
      await expect(
        guestPage.getByRole('heading', {
          level: 1,
          name: 'You returned from secure checkout',
        }),
      ).toBeVisible();
    } finally {
      guestPage.off('request', countCompletionRequest);
    }
    safeInvariant(
      completionRequestCount === 1,
      'FAKE_CHECKOUT_COMPLETION_COUNT_MISMATCH',
    );
    await assertLocation(guestPage, `/orders/${publicOrderNumber}/payment-return`);
    await expect(
      guestPage.getByText(
        'This page does not check payment status or make a payment claim.',
        {
          exact: true,
        },
      ),
    ).toBeVisible();
    await assertGuestCapabilityInternal(guestPage, publicOrderNumber);

    const paidDetailResponse = waitForApiResponse(
      adminPage,
      'GET',
      `/api/v1/admin/orders/${publicOrderNumber}`,
    );
    await adminPage.getByRole('button', { name: 'Refresh', exact: true }).click();
    await assertResponseStatus(
      paidDetailResponse,
      200,
      'PAID_ORDER_REFRESH_STATUS_MISMATCH',
    );
    await expect(adminPaymentAttempt(adminPage)).toHaveCount(1);
    await expect(
      adminPaymentAttempt(adminPage).getByText('Succeeded', { exact: true }),
    ).toBeVisible();

    const transitions: readonly AdminTransition[] = [
      {
        actionLabel: 'Accept order',
        confirmation: 'Accept this order?',
        expectedStatus: 'Accepted',
      },
      {
        actionLabel: 'Start preparing',
        confirmation: 'Start preparing this order?',
        expectedStatus: 'Preparing',
      },
      {
        actionLabel: 'Mark ready',
        confirmation: 'Mark this order as ready?',
        expectedStatus: 'Ready',
      },
      {
        actionLabel: 'Complete order',
        confirmation: 'Complete this order?',
        expectedStatus: 'Completed',
      },
    ];
    for (const transition of transitions) {
      await applyAdminTransition(adminPage, publicOrderNumber, transition);
    }
    await expect(
      adminPage.getByText('No further status actions are available.', {
        exact: true,
      }),
    ).toBeVisible();

    const orderStatusResponse = waitForApiResponse(
      guestPage,
      'GET',
      `/api/v1/orders/${publicOrderNumber}`,
    );
    await guestPage
      .getByRole('link', { name: 'View order status', exact: true })
      .click();
    await assertResponseStatus(
      orderStatusResponse,
      200,
      'PUBLIC_ORDER_STATUS_MISMATCH',
    );
    await expect(
      guestPage.getByRole('heading', { level: 1, name: 'Order status' }),
    ).toBeVisible();
    await expect(
      guestPage.getByRole('heading', { level: 2, name: 'Completed' }),
    ).toBeVisible();
    await expect(guestPage.locator('#main-content').getByText('Succeeded')).toHaveCount(
      0,
    );
    await assertGuestCapabilityInternal(guestPage, publicOrderNumber);

    const usersResponse = waitForApiResponse(adminPage, 'GET', '/api/v1/admin/users');
    await adminPage
      .getByRole('navigation', { name: 'Administrator navigation' })
      .getByRole('link', { name: 'Users', exact: true })
      .click();
    await assertResponseStatus(usersResponse, 200, 'ADMIN_USERS_STATUS_MISMATCH');
    await expect(
      adminPage.getByRole('heading', { level: 1, name: 'Users' }),
    ).toBeVisible();
    await assertSuperAdminIsReadOnly(adminPage);
    await promoteCustomer(adminPage, promotee);
    await assertSuperAdminIsReadOnly(adminPage);
    await logoutToHome(adminPage);

    await loginIdentity(promoteePage, promotee, '/admin');
    await expect(
      promoteePage.getByRole('heading', {
        level: 1,
        name: 'Administrator workspace',
      }),
    ).toBeVisible();
    await expect(
      promoteePage
        .getByRole('navigation', { name: 'Administrator navigation' })
        .getByRole('link', { name: 'Users', exact: true }),
    ).toHaveCount(0);

    let adminUsersApiRequestCount = 0;
    const countAdminUsersRequest = (request: Request) => {
      const parsed = sameOriginUrl(request.url());
      if (
        parsed !== null &&
        (parsed.pathname === '/api/v1/admin/users' ||
          parsed.pathname.startsWith('/api/v1/admin/users/'))
      ) {
        adminUsersApiRequestCount += 1;
      }
    };
    promoteePage.on('request', countAdminUsersRequest);
    try {
      const revalidationResponse = waitForApiResponse(
        promoteePage,
        'GET',
        '/api/v1/auth/me',
      );
      await promoteePage.goto('/admin/users');
      await assertResponseStatus(
        revalidationResponse,
        200,
        'PROMOTED_ADMIN_REVALIDATION_MISMATCH',
      );
      await assertLocation(promoteePage, '/admin');
      await expect(
        promoteePage.getByRole('heading', {
          level: 1,
          name: 'Administrator workspace',
        }),
      ).toBeVisible();
    } finally {
      promoteePage.off('request', countAdminUsersRequest);
    }
    safeInvariant(adminUsersApiRequestCount === 0, 'ADMIN_USERS_GUARD_REQUESTED_API');
  } catch (error: unknown) {
    scenarioError = error;
  }
  for (const guard of guards) {
    try {
      guard.assertClean();
    } catch (error: unknown) {
      finalizationError ??= error;
    }
  }
  try {
    await closeContexts(contextsToClose);
  } catch (error: unknown) {
    finalizationError ??= error;
  }
  if (finalizationError !== undefined) {
    throw finalizationError;
  }
  if (scenarioError !== undefined) {
    throw scenarioError;
  }
});
