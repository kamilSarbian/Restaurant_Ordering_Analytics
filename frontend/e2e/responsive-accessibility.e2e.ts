import process from 'node:process';
import { URL } from 'node:url';

import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

import { requireEnvironmentValue, validateLoopbackBaseUrl } from './support/runtime';

const MENU_ITEM_NAME = 'Roasted Root Vegetable Soup';
const UNAVAILABLE_MENU_ITEM_NAME = 'Warm Apple Cake';
const CRITICAL_RESOURCE_TYPES = new Set([
  'document',
  'fetch',
  'script',
  'stylesheet',
  'xhr',
]);
const SENSITIVE_QUERY_NAME_PATTERN =
  /(?:access|auth|capability|credential|password|secret|signature|token)/iu;
const STRIPE_HOST_PATTERN =
  /(?:^|\.)(?:stripe\.com|stripe\.dev|stripe\.network|stripeassets\.com|stripecdn\.com|stripepayments\.com)$/iu;
const VIEWPORTS = [
  { height: 812, label: 'mobile', width: 375 },
  { height: 1024, label: 'tablet', width: 768 },
  { height: 800, label: 'desktop', width: 1280 },
] as const;
const OVERFLOW_TOLERANCE_PX = 1;
const SAFE_SYNTHETIC_ENVIRONMENT_NAMES = new Set([
  'E2E_ADMIN_EMAIL',
  'E2E_ADMIN_PASSWORD',
]);
const baseOrigin = validateLoopbackBaseUrl(
  requireEnvironmentValue('E2E_BASE_URL', process.env),
);
const runId = requireEnvironmentValue('E2E_RUN_ID', process.env);

interface SyntheticIdentity {
  readonly email: string;
  readonly password: string;
}

interface RuntimeBox {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface RuntimeElement {
  readonly disabled?: boolean;
  readonly parentElement: RuntimeElement | null;
  readonly previousElementSibling: RuntimeElement | null;
  readonly scrollWidth?: number;
  scrollLeft?: number;
  readonly clientWidth?: number;
  readonly tagName: string;
  blur?: () => void;
  closest: (selector: string) => RuntimeElement | null;
  focus?: () => void;
  getAttribute: (name: string) => string | null;
  getBoundingClientRect: () => RuntimeBox;
  querySelector: (selector: string) => RuntimeElement | null;
}

interface BrowserRuntime {
  readonly document: {
    readonly activeElement: RuntimeElement | null;
    readonly body: RuntimeElement & {
      readonly clientWidth: number;
      readonly scrollWidth: number;
    };
    readonly documentElement: RuntimeElement & {
      readonly clientWidth: number;
      readonly scrollWidth: number;
    };
    readonly fonts: {
      readonly ready: Promise<unknown>;
    };
    readonly scrollingElement:
      | (RuntimeElement & {
          readonly clientWidth: number;
          readonly scrollWidth: number;
        })
      | null;
    querySelectorAll: (selector: string) => Iterable<RuntimeElement>;
  };
  getComputedStyle: (element: RuntimeElement) => {
    readonly boxShadow: string;
    readonly display: string;
    readonly opacity: string;
    readonly outlineStyle: string;
    readonly outlineWidth: string;
    readonly overflowWrap: string;
    readonly overflowX: string;
    readonly visibility: string;
    readonly wordBreak: string;
  };
  readonly innerWidth: number;
  readonly scrollX: number;
  readonly scrollY: number;
  readonly location: {
    readonly hash: string;
    readonly pathname: string;
    readonly search: string;
  };
  requestAnimationFrame: (callback: () => void) => number;
  scrollTo: (x: number, y: number) => void;
}

interface OverflowBoxDiagnostic {
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
}

interface OverflowElementDiagnostic {
  readonly box: OverflowBoxDiagnostic;
  readonly role: string | null;
  readonly selector: string;
}

interface OverflowScrollerDiagnostic {
  readonly box: Pick<OverflowBoxDiagnostic, 'left' | 'right' | 'width'>;
  readonly clientWidth: number;
  readonly scrollWidth: number;
  readonly selector: string;
}

interface OverflowSnapshot {
  readonly body: {
    readonly clientWidth: number;
    readonly delta: number;
    readonly scrollWidth: number;
  };
  readonly localTableOffenderCount: number;
  readonly localTableScrollers: readonly OverflowScrollerDiagnostic[];
  readonly nonLocalOffenderCount: number;
  readonly offenders: readonly OverflowElementDiagnostic[];
  readonly pathname: string;
  readonly scrollingElement: {
    readonly clientWidth: number;
    readonly delta: number;
    readonly maximumScrollX: number;
    readonly scrollWidth: number;
  };
  readonly viewportWidth: number;
}

function safeInvariant(condition: unknown, code: string): asserts condition {
  if (!condition) {
    throw new Error(code);
  }
}

function requireSyntheticEnvironmentValue(name: string): string {
  if (!SAFE_SYNTHETIC_ENVIRONMENT_NAMES.has(name)) {
    throw new Error('E2E_SYNTHETIC_ENVIRONMENT_NAME_INVALID');
  }
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error('E2E_SYNTHETIC_ENVIRONMENT_VALUE_INVALID');
  }
  return value;
}

function loadAdministratorIdentity(): SyntheticIdentity {
  const email = requireSyntheticEnvironmentValue('E2E_ADMIN_EMAIL');
  const password = requireSyntheticEnvironmentValue('E2E_ADMIN_PASSWORD');
  if (email !== `stage18-admin-${runId}@example.com`) {
    throw new Error('E2E_ADMIN_EMAIL_INVALID');
  }
  const passwordLength = Array.from(password).length;
  if (passwordLength < 15 || passwordLength > 128) {
    throw new Error('E2E_ADMIN_PASSWORD_INVALID');
  }
  return Object.freeze({ email, password });
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

function isCriticalRequest(request: Request): boolean {
  return CRITICAL_RESOURCE_TYPES.has(request.resourceType());
}

function isForbiddenBrowserPath(pathname: string): boolean {
  return (
    pathname === '/api/v1/stripe/webhook' ||
    pathname.startsWith('/api/v1/e2e/') ||
    pathname === '/api/v1/admin/auth/login' ||
    pathname === '/api/v1/admin/auth/me' ||
    pathname.endsWith('/checkout-session')
  );
}

class BrowserSafetyGuard {
  private readonly issues: string[] = [];

  constructor(page: Page, sensitiveValues: readonly string[]) {
    page.on('console', (message) => {
      if (message.type() === 'error') {
        this.issues.push('console-error');
      }
    });
    page.on('pageerror', () => {
      this.issues.push('page-error');
    });
    page.on('popup', () => {
      this.issues.push('unexpected-popup');
    });
    page.on('request', (request) => {
      this.inspectRequest(request, sensitiveValues);
    });
    page.on('requestfailed', (request) => {
      const parsed = parseUrl(request.url());
      if (parsed === null) {
        if (isCriticalRequest(request)) this.issues.push('critical-url-invalid');
        return;
      }
      if (parsed.origin === baseOrigin && isCriticalRequest(request)) {
        this.issues.push('critical-request-failed');
      }
    });
    page.on('response', (response) => {
      this.inspectResponse(response);
    });
  }

  assertClean(): void {
    expect([...new Set(this.issues)], 'UNEXPECTED_BROWSER_RUNTIME_FAILURE').toEqual([]);
  }

  private inspectRequest(request: Request, sensitiveValues: readonly string[]): void {
    const parsed = parseUrl(request.url());
    if (parsed === null) {
      if (isCriticalRequest(request)) this.issues.push('critical-url-invalid');
      return;
    }

    if (STRIPE_HOST_PATTERN.test(parsed.hostname)) {
      this.issues.push('stripe-network-request');
    }
    if (parsed.origin !== baseOrigin && isCriticalRequest(request)) {
      this.issues.push('external-critical-request');
    }
    if (parsed.username !== '' || parsed.password !== '') {
      this.issues.push('url-credentials-present');
    }
    if (
      [...parsed.searchParams.keys()].some((name) =>
        SENSITIVE_QUERY_NAME_PATTERN.test(name),
      ) ||
      sensitiveValues.some(
        (value) =>
          value.length > 0 &&
          (parsed.pathname.includes(value) || parsed.search.includes(value)),
      )
    ) {
      this.issues.push('sensitive-url-material');
    }
    if (parsed.origin === baseOrigin && isForbiddenBrowserPath(parsed.pathname)) {
      this.issues.push('forbidden-browser-endpoint');
    }
  }

  private inspectResponse(response: Response): void {
    if (response.status() < 400) {
      return;
    }
    const parsed = parseUrl(response.url());
    if (parsed !== null && parsed.origin === baseOrigin) {
      this.issues.push('unexpected-http-failure');
    }
  }
}

function waitForApiResponse(
  page: Page,
  method: string,
  pathname: string,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = parseUrl(response.url());
    return (
      parsed !== null &&
      parsed.origin === baseOrigin &&
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
        return { pathname: current.pathname, search: current.search };
      },
      { message: 'LOCATION_MISMATCH' },
    )
    .toEqual({ pathname, search: '' });
}

async function blurActiveElement(page: Page): Promise<void> {
  await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    runtime.document.activeElement?.blur?.();
  });
}

async function assertVisibleKeyboardFocus(locator: Locator): Promise<void> {
  await expect(locator).toBeFocused();
  const hasVisibleRing = await locator.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const style = runtime.getComputedStyle(element as unknown as RuntimeElement);
    return (
      style.boxShadow !== 'none' ||
      (style.outlineStyle !== 'none' && style.outlineWidth !== '0px')
    );
  });
  safeInvariant(hasVisibleRing, 'VISIBLE_FOCUS_RING_MISSING');
}

async function tabTo(page: Page, target: Locator, maximumTabs = 24): Promise<void> {
  for (let index = 0; index < maximumTabs; index += 1) {
    await page.keyboard.press('Tab');
    if (
      await target.evaluate((element) => {
        const runtime = globalThis as typeof globalThis & BrowserRuntime;
        return (
          runtime.document.activeElement === (element as unknown as RuntimeElement)
        );
      })
    ) {
      return;
    }
  }
  throw new Error('KEYBOARD_TARGET_NOT_REACHED');
}

async function waitForSettledLayout(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    await runtime.document.fonts.ready;
    const waitForFrame = () =>
      new Promise<void>((resolve) => {
        runtime.requestAnimationFrame(() => resolve());
      });
    await waitForFrame();
    await waitForFrame();
  });
}

async function captureOverflowSnapshot(page: Page): Promise<OverflowSnapshot> {
  return page.evaluate((tolerance) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const root = runtime.document.scrollingElement ?? runtime.document.documentElement;
    const body = runtime.document.body;
    const originalScrollX = runtime.scrollX;
    const originalScrollY = runtime.scrollY;
    runtime.scrollTo(root.scrollWidth, originalScrollY);
    const maximumScrollX = runtime.scrollX;
    runtime.scrollTo(originalScrollX, originalScrollY);

    const safePathnames = new Set([
      '/',
      '/account',
      '/admin',
      '/admin/orders',
      '/admin/users',
      '/login',
      '/menu',
      '/register',
    ]);
    const safeRoles = new Set([
      'alert',
      'button',
      'complementary',
      'dialog',
      'form',
      'heading',
      'link',
      'list',
      'main',
      'navigation',
      'region',
      'status',
      'table',
    ]);
    const roundGeometry = (value: number) => Math.round(value * 100) / 100;
    const safeSelector = (element: RuntimeElement) => {
      const parts: string[] = [];
      let current: RuntimeElement | null = element;
      for (
        let depth = 0;
        depth < 5 && current !== null && current !== body;
        depth += 1
      ) {
        const tagName = current.tagName.toLowerCase();
        let position = 1;
        let sibling = current.previousElementSibling;
        while (sibling !== null) {
          if (sibling.tagName === current.tagName) position += 1;
          sibling = sibling.previousElementSibling;
        }
        parts.unshift(`${tagName}:nth-of-type(${position})`);
        current = current.parentElement;
      }
      return parts.join(' > ');
    };
    const safeRole = (element: RuntimeElement) => {
      const role = element.getAttribute('role');
      return role !== null && safeRoles.has(role) ? role : null;
    };
    const boxDiagnostic = (box: RuntimeBox): OverflowBoxDiagnostic => ({
      bottom: roundGeometry(box.bottom),
      left: roundGeometry(box.left),
      right: roundGeometry(box.right),
      top: roundGeometry(box.top),
      width: roundGeometry(box.width),
    });
    const localScrollerFor = (element: RuntimeElement) => {
      const table = element.closest('table');
      const wrapper = table?.parentElement ?? null;
      if (
        wrapper === null ||
        wrapper.clientWidth === undefined ||
        wrapper.scrollWidth === undefined
      ) {
        return null;
      }
      const style = runtime.getComputedStyle(wrapper);
      const box = wrapper.getBoundingClientRect();
      const bounded =
        box.left >= -tolerance && box.right <= runtime.innerWidth + tolerance;
      const scrollable =
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        wrapper.scrollWidth > wrapper.clientWidth + tolerance;
      return bounded && scrollable ? wrapper : null;
    };

    const offenders: OverflowElementDiagnostic[] = [];
    const localTableScrollers: OverflowScrollerDiagnostic[] = [];
    const recordedScrollers = new Set<RuntimeElement>();
    let localTableOffenderCount = 0;
    let nonLocalOffenderCount = 0;

    for (const element of runtime.document.querySelectorAll('body *')) {
      const style = runtime.getComputedStyle(element);
      const box = element.getBoundingClientRect();
      const rendered =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) > 0 &&
        Number.isFinite(box.left) &&
        Number.isFinite(box.right) &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0;
      const exceedsViewport =
        box.left < -tolerance || box.right > runtime.innerWidth + tolerance;
      if (!rendered || !exceedsViewport) continue;

      const localScroller = localScrollerFor(element);
      if (localScroller !== null) {
        localTableOffenderCount += 1;
        if (!recordedScrollers.has(localScroller) && localTableScrollers.length < 5) {
          recordedScrollers.add(localScroller);
          const scrollerBox = localScroller.getBoundingClientRect();
          localTableScrollers.push({
            box: {
              left: roundGeometry(scrollerBox.left),
              right: roundGeometry(scrollerBox.right),
              width: roundGeometry(scrollerBox.width),
            },
            clientWidth: localScroller.clientWidth ?? 0,
            scrollWidth: localScroller.scrollWidth ?? 0,
            selector: safeSelector(localScroller),
          });
        }
        continue;
      }

      nonLocalOffenderCount += 1;
      if (offenders.length < 8) {
        offenders.push({
          box: boxDiagnostic(box),
          role: safeRole(element),
          selector: safeSelector(element),
        });
      }
    }

    const pathname = safePathnames.has(runtime.location.pathname)
      ? runtime.location.pathname
      : 'unrecognized';
    const rootDelta = Math.max(0, root.scrollWidth - root.clientWidth);
    const bodyDelta = Math.max(0, body.scrollWidth - body.clientWidth);
    return {
      body: {
        clientWidth: body.clientWidth,
        delta: bodyDelta,
        scrollWidth: body.scrollWidth,
      },
      localTableOffenderCount,
      localTableScrollers,
      nonLocalOffenderCount,
      offenders,
      pathname,
      scrollingElement: {
        clientWidth: root.clientWidth,
        delta: rootDelta,
        maximumScrollX,
        scrollWidth: root.scrollWidth,
      },
      viewportWidth: runtime.innerWidth,
    };
  }, OVERFLOW_TOLERANCE_PX);
}

function stableOverflowSignature(snapshot: OverflowSnapshot): string {
  return JSON.stringify(snapshot);
}

function safeOverflowDiagnostics(snapshot: OverflowSnapshot): string {
  return JSON.stringify(snapshot);
}

async function captureStableOverflowSnapshot(page: Page): Promise<OverflowSnapshot> {
  await waitForSettledLayout(page);
  let previous = await captureOverflowSnapshot(page);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const runtime = globalThis as typeof globalThis & BrowserRuntime;
          runtime.requestAnimationFrame(() => resolve());
        }),
    );
    const current = await captureOverflowSnapshot(page);
    if (stableOverflowSignature(previous) === stableOverflowSignature(current)) {
      return current;
    }
    previous = current;
  }
  throw new Error(`RESPONSIVE_LAYOUT_UNSTABLE ${safeOverflowDiagnostics(previous)}`);
}

async function assertNoMaterialOverflow(page: Page): Promise<void> {
  const snapshot = await captureStableOverflowSnapshot(page);
  const pageCanScrollHorizontally =
    snapshot.scrollingElement.delta > OVERFLOW_TOLERANCE_PX ||
    snapshot.scrollingElement.maximumScrollX > OVERFLOW_TOLERANCE_PX;
  if (pageCanScrollHorizontally || snapshot.nonLocalOffenderCount > 0) {
    throw new Error(
      `MATERIAL_HORIZONTAL_OVERFLOW ${safeOverflowDiagnostics(snapshot)}`,
    );
  }
}

async function assertVisibleControlsWithinViewport(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const controls = Array.from(
      runtime.document.querySelectorAll(
        'a, button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])',
      ),
    );
    let visibleCount = 0;
    for (const control of controls) {
      const style = runtime.getComputedStyle(control);
      const box = control.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.opacity !== '0' &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.top < Number.POSITIVE_INFINITY;
      if (!visible || box.top < 0 || control.closest('table') !== null) {
        continue;
      }
      visibleCount += 1;
      if (box.left < -1 || box.right > runtime.innerWidth + 1) {
        return { bounded: false, visibleCount };
      }
    }
    return { bounded: true, visibleCount };
  });
  safeInvariant(result.visibleCount > 0, 'VISIBLE_CONTROL_SET_EMPTY');
  safeInvariant(result.bounded, 'CRITICAL_CONTROL_CLIPPED');
}

async function assertResponsiveSurface(page: Page): Promise<void> {
  await assertNoMaterialOverflow(page);
  await assertVisibleControlsWithinViewport(page);
}

async function assertTableReachable(table: Locator): Promise<void> {
  const wrapper = table.locator('..');
  await expect(wrapper).toBeVisible();
  const result = await wrapper.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const scrollContainer = element as unknown as RuntimeElement;
    const tableElement = scrollContainer.querySelector('table');
    const lastCell = tableElement?.querySelector('tbody tr > *:last-child');
    if (
      tableElement === null ||
      lastCell === null ||
      lastCell === undefined ||
      scrollContainer.scrollWidth === undefined ||
      scrollContainer.clientWidth === undefined
    ) {
      return { overflowAllowed: false, reachable: false };
    }
    const style = runtime.getComputedStyle(scrollContainer);
    const maximumScroll = Math.max(
      0,
      scrollContainer.scrollWidth - scrollContainer.clientWidth,
    );
    scrollContainer.scrollLeft = maximumScroll;
    const wrapperBox = scrollContainer.getBoundingClientRect();
    const lastCellBox = lastCell.getBoundingClientRect();
    const reachable =
      lastCellBox.right >= wrapperBox.left - 1 &&
      lastCellBox.left <= wrapperBox.right + 1;
    scrollContainer.scrollLeft = 0;
    return {
      overflowAllowed: style.overflowX === 'auto' || style.overflowX === 'scroll',
      reachable,
    };
  });
  safeInvariant(result.overflowAllowed, 'TABLE_SCROLL_CONTRACT_MISSING');
  safeInvariant(result.reachable, 'TABLE_FINAL_COLUMN_UNREACHABLE');
}

async function assertCollectionLayout(
  page: Page,
  accessibleName: string,
  viewportWidth: number,
): Promise<void> {
  const cards = page.getByRole('list', { name: accessibleName });
  const table = page.getByRole('table', { name: accessibleName });
  if (viewportWidth < 768) {
    await expect(cards).toBeVisible();
    await expect(table).toBeHidden();
    const cardsFit = await cards.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      const box = (element as unknown as RuntimeElement).getBoundingClientRect();
      return box.left >= -1 && box.right <= runtime.innerWidth + 1;
    });
    safeInvariant(cardsFit, 'RESPONSIVE_CARD_COLLECTION_CLIPPED');
    return;
  }
  await expect(table).toBeVisible();
  await expect(cards).toBeHidden();
  await assertTableReachable(table);
}

async function assertLongTextWraps(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const wrapsSafely = await locator.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    const node = element as unknown as RuntimeElement;
    const style = runtime.getComputedStyle(node);
    const box = node.getBoundingClientRect();
    return (
      (style.overflowWrap === 'anywhere' ||
        style.wordBreak === 'break-word' ||
        style.wordBreak === 'anywhere') &&
      box.left >= -1 &&
      box.right <= runtime.innerWidth + 1
    );
  });
  safeInvariant(wrapsSafely, 'LONG_TEXT_WRAP_CONTRACT_MISSING');
}

async function openMenu(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.goto('/menu');
  await assertResponseStatus(response, 200, 'MENU_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();
}

async function assertPublicLayouts(page: Page): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Fresh food, ordered your way' }),
    ).toBeVisible();
    await expect(
      page.getByRole('navigation', { name: 'Customer navigation' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);

    await openMenu(page);
    await expect(
      page.getByRole('complementary', { name: 'Cart summary' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);

    await page.goto('/login');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Sign in' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);

    await page.goto('/register');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Create account' }),
    ).toBeVisible();
    await assertResponsiveSurface(page);
  }
}

async function assertCustomerKeyboardContracts(page: Page): Promise<void> {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto('/');
  await blurActiveElement(page);
  const skipLink = page.getByRole('link', { name: 'Skip to main content' });
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(skipLink);
  await page.keyboard.press('Enter');
  await expect(page.locator('#main-content')).toBeFocused();
  await expect.poll(() => new URL(page.url()).hash).toBe('#main-content');

  await page.goto('/');
  await blurActiveElement(page);
  const guestLink = page
    .getByRole('navigation', { name: 'Start ordering' })
    .getByRole('link', { name: 'Order as guest' });
  await tabTo(page, guestLink);
  await assertVisibleKeyboardFocus(guestLink);
  const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  await page.keyboard.press('Enter');
  await assertResponseStatus(menuResponse, 200, 'KEYBOARD_MENU_STATUS_MISMATCH');
  await assertLocation(page, '/menu');
  await expect(page.getByRole('heading', { level: 1, name: 'Our menu' })).toBeVisible();

  const categoryButton = page
    .getByRole('group', { name: 'Category' })
    .getByRole('button', { exact: true, name: 'Desserts' });
  await expect(categoryButton).toBeVisible();
  await blurActiveElement(page);
  await tabTo(page, categoryButton);
  await assertVisibleKeyboardFocus(categoryButton);
  await page.keyboard.press('Enter');
  await expect(categoryButton).toHaveAttribute('aria-pressed', 'true');

  const unavailableCard = page.getByRole('article', {
    exact: true,
    name: UNAVAILABLE_MENU_ITEM_NAME,
  });
  const unavailableButton = unavailableCard.getByRole('button', {
    name: 'Unavailable',
  });
  await expect(unavailableButton).toBeDisabled();
  await blurActiveElement(page);
  const disabledCouldFocus = await unavailableButton.evaluate((element) => {
    const runtime = globalThis as typeof globalThis & BrowserRuntime;
    (element as unknown as RuntimeElement).focus?.();
    return runtime.document.activeElement === (element as unknown as RuntimeElement);
  });
  safeInvariant(!disabledCouldFocus, 'DISABLED_CONTROL_KEYBOARD_FOCUSABLE');
  await page.keyboard.press('Enter');
  await expect(
    page
      .getByRole('complementary', { name: 'Cart summary' })
      .getByText('0 items in cart'),
  ).toBeVisible();
}

async function assertAuthKeyboardContracts(page: Page): Promise<void> {
  await page.goto('/login');
  const email = page.getByLabel('Email', { exact: true });
  const password = page.getByLabel('Password', { exact: true });
  const submit = page.getByRole('button', { name: 'Sign in', exact: true });
  const back = page.getByRole('link', { name: 'Back to home' });
  await blurActiveElement(page);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(email);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(password);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(submit);
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(back);
  await page.keyboard.press('Shift+Tab');
  await assertVisibleKeyboardFocus(submit);

  let loginPostCount = 0;
  page.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === '/api/v1/auth/login' &&
      request.method() === 'POST'
    ) {
      loginPostCount += 1;
    }
  });
  await page.keyboard.press('Enter');
  await expect(email).toBeFocused();
  await expect(email).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#login-email-error')).toBeVisible();
  await expect(email).toHaveAttribute('aria-describedby', 'login-email-error');
  safeInvariant(loginPostCount === 0, 'INVALID_LOGIN_POSTED');

  await page.goto('/register');
  const registerEmail = page.getByLabel('Email', { exact: true });
  const registerPassword = page.getByLabel('Password', { exact: true });
  let registerPostCount = 0;
  page.on('request', (request) => {
    const parsed = parseUrl(request.url());
    if (
      parsed !== null &&
      parsed.origin === baseOrigin &&
      parsed.pathname === '/api/v1/auth/register' &&
      request.method() === 'POST'
    ) {
      registerPostCount += 1;
    }
  });
  await registerEmail.fill(`stage18-form-${runId}@example.com`);
  await registerEmail.press('Enter');
  await expect(registerPassword).toBeFocused();
  await expect(registerPassword).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#register-password-error')).toBeVisible();
  await expect(registerPassword).toHaveAttribute(
    'aria-describedby',
    'register-password-guidance register-password-error',
  );
  safeInvariant(registerPostCount === 0, 'INVALID_REGISTRATION_POSTED');
}

async function loginAdministrator(
  page: Page,
  identity: SyntheticIdentity,
): Promise<void> {
  await page.goto('/login?next=%2Faccount');
  await page.getByLabel('Email', { exact: true }).fill(identity.email);
  await page.getByLabel('Password', { exact: true }).fill(identity.password);
  const loginResponse = waitForApiResponse(page, 'POST', '/api/v1/auth/login');
  const currentUserResponse = waitForApiResponse(page, 'GET', '/api/v1/auth/me');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await Promise.all([
    assertResponseStatus(loginResponse, 200, 'ADMIN_LOGIN_STATUS_MISMATCH'),
    assertResponseStatus(currentUserResponse, 200, 'ADMIN_ME_STATUS_MISMATCH'),
  ]);
  await assertLocation(page, '/account');
}

async function createOwnedOrder(page: Page): Promise<void> {
  await openMenu(page);
  const item = page.getByRole('article', { exact: true, name: MENU_ITEM_NAME });
  await item.getByRole('button', { name: 'Add to cart' }).click();
  await expect(item.getByText('1 in cart', { exact: true })).toBeVisible();

  const cartMenuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  const quoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  await page.getByRole('link', { name: 'View cart', exact: true }).click();
  await Promise.all([
    assertResponseStatus(cartMenuResponse, 200, 'CART_MENU_STATUS_MISMATCH'),
    assertResponseStatus(quoteResponse, 200, 'QUOTE_STATUS_MISMATCH'),
  ]);
  const placeOrderButton = page.getByRole('button', {
    name: 'Place order and continue to payment',
  });
  await expect(placeOrderButton).toBeEnabled();
  const freshQuoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  const orderResponse = waitForApiResponse(page, 'POST', '/api/v1/orders');
  await placeOrderButton.click();
  await Promise.all([
    assertResponseStatus(freshQuoteResponse, 200, 'FRESH_QUOTE_STATUS_MISMATCH'),
    assertResponseStatus(orderResponse, 201, 'ORDER_CREATE_STATUS_MISMATCH'),
  ]);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order created' }),
  ).toBeVisible();
}

async function openAccount(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/account/orders');
  await page.goto('/account');
  await assertResponseStatus(response, 200, 'ACCOUNT_ORDERS_STATUS_MISMATCH');
  await expect(
    page.getByRole('heading', { level: 1, name: 'My orders' }),
  ).toBeVisible();
}

async function openAdminOrders(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/admin/orders');
  await page.goto('/admin/orders');
  await assertResponseStatus(response, 200, 'ADMIN_ORDERS_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Orders' })).toBeVisible();
}

async function openAdminUsers(page: Page): Promise<void> {
  const response = waitForApiResponse(page, 'GET', '/api/v1/admin/users');
  await page.goto('/admin/users');
  await assertResponseStatus(response, 200, 'ADMIN_USERS_STATUS_MISMATCH');
  await expect(page.getByRole('heading', { level: 1, name: 'Users' })).toBeVisible();
}

async function assertAuthenticatedLayouts(
  page: Page,
  identity: SyntheticIdentity,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await page.setViewportSize({ height: viewport.height, width: viewport.width });

    await page.goto('/');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Fresh food, ordered your way' }),
    ).toBeVisible();
    await assertLongTextWraps(
      page.locator('main strong').filter({ hasText: identity.email }),
    );
    await assertResponsiveSurface(page);

    await openAccount(page);
    await assertCollectionLayout(page, 'Your orders, newest first', viewport.width);
    await assertResponsiveSurface(page);
    const previous = page.getByRole('button', { name: 'Previous', exact: true });
    const next = page.getByRole('button', { name: 'Next', exact: true });
    await expect(previous).toBeDisabled();
    await expect(next).toBeDisabled();
    const disabledPaginationFocused = await previous.evaluate((element) => {
      const runtime = globalThis as typeof globalThis & BrowserRuntime;
      (element as unknown as RuntimeElement).focus?.();
      return runtime.document.activeElement === (element as unknown as RuntimeElement);
    });
    safeInvariant(!disabledPaginationFocused, 'DISABLED_PAGINATION_FOCUSABLE');

    await openAdminOrders(page);
    await assertCollectionLayout(
      page,
      'Administrator orders, newest first',
      viewport.width,
    );
    await assertResponsiveSurface(page);

    await openAdminUsers(page);
    await assertCollectionLayout(
      page,
      'Registered users, oldest first',
      viewport.width,
    );
    await assertLongTextWraps(
      page.locator('header').getByText(identity.email, { exact: true }),
    );
    if (viewport.width < 768) {
      await assertLongTextWraps(
        page.getByRole('heading', { level: 2, name: identity.email }),
      );
    }
    await assertResponsiveSurface(page);
  }
}

async function assertAdministratorKeyboardContracts(page: Page): Promise<void> {
  await page.setViewportSize({ height: 812, width: 375 });
  await page.goto('/admin');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Administrator workspace' }),
  ).toBeVisible();
  await blurActiveElement(page);
  const skipLink = page.getByRole('link', {
    name: 'Skip to administrator content',
  });
  await page.keyboard.press('Tab');
  await assertVisibleKeyboardFocus(skipLink);
  await page.keyboard.press('Enter');
  await expect(page.locator('#admin-main-content')).toBeFocused();
  await expect.poll(() => new URL(page.url()).hash).toBe('#admin-main-content');

  await page.goto('/admin');
  await blurActiveElement(page);
  const ordersLink = page
    .getByRole('navigation', { name: 'Administrator navigation' })
    .getByRole('link', { name: 'Orders', exact: true });
  await tabTo(page, ordersLink);
  await assertVisibleKeyboardFocus(ordersLink);
  const response = waitForApiResponse(page, 'GET', '/api/v1/admin/orders');
  await page.keyboard.press('Enter');
  await assertResponseStatus(response, 200, 'ADMIN_KEYBOARD_ORDERS_STATUS_MISMATCH');
  await assertLocation(page, '/admin/orders');
}

async function closeContext(context: BrowserContext): Promise<void> {
  let cleanupFailed = false;
  try {
    await context.close();
  } catch (error: unknown) {
    void error;
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    throw new Error('E2E_CONTEXT_CLEANUP_FAILED');
  }
}

test.describe.configure({ mode: 'serial' });

test('keeps responsive shells, keyboard focus, and runtime boundaries usable', async ({
  browser,
  page,
}) => {
  test.setTimeout(180_000);
  const administrator = loadAdministratorIdentity();
  const sensitiveValues = [administrator.email, administrator.password];
  const publicGuard = new BrowserSafetyGuard(page, sensitiveValues);
  const adminContext = await browser.newContext({ baseURL: baseOrigin });
  const adminPage = await adminContext.newPage();
  const adminGuard = new BrowserSafetyGuard(adminPage, sensitiveValues);

  let scenarioError: unknown;
  let finalizationError: unknown;
  try {
    await assertPublicLayouts(page);
    await assertCustomerKeyboardContracts(page);
    await assertAuthKeyboardContracts(page);

    await adminPage.setViewportSize({ height: 812, width: 375 });
    await loginAdministrator(adminPage, administrator);
    await createOwnedOrder(adminPage);
    await assertAuthenticatedLayouts(adminPage, administrator);
    await assertAdministratorKeyboardContracts(adminPage);
  } catch (error: unknown) {
    scenarioError = error;
  } finally {
    try {
      publicGuard.assertClean();
      adminGuard.assertClean();
    } catch (error: unknown) {
      finalizationError = error;
    }
    try {
      await closeContext(adminContext);
    } catch (error: unknown) {
      finalizationError ??= error;
    }
  }

  if (scenarioError !== undefined) {
    throw scenarioError;
  }
  if (finalizationError !== undefined) {
    throw finalizationError;
  }
});
