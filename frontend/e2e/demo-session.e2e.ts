import { Buffer } from 'node:buffer';

import {
  expect,
  test,
  type APIResponse,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';

const AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
const DEMO_SESSION_STORAGE_KEY = 'restaurant-ordering:demo-session:v1';
const DEMO_ADMIN_EMAIL = 'demo-admin@example.com';
const ANALYTICS_PATHS = {
  categories: '/api/v1/admin/analytics/categories',
  orderTypes: '/api/v1/admin/analytics/order-types',
  overview: '/api/v1/admin/analytics/overview',
  products: '/api/v1/admin/analytics/products',
  samplePeriod: '/api/v1/admin/analytics/sample-period',
} as const;

type AnalyticsOperation = keyof typeof ANALYTICS_PATHS;

interface DemoRequestObservation {
  readonly bodyAbsent: boolean;
  readonly contentTypeAbsent: boolean;
  readonly cookieAbsent: boolean;
  readonly method: string;
}

interface CurrentUserObservation {
  readonly activeAdministrator: boolean;
  readonly exactEmail: boolean;
  readonly status: number;
  readonly superAdministrator: boolean;
}

function isApiPath(request: Request, pathname: string): boolean {
  return new URL(request.url()).pathname === pathname;
}

function analyticsOperation(request: Request): AnalyticsOperation | null {
  if (request.method() !== 'GET') {
    return null;
  }
  const pathname = new URL(request.url()).pathname;
  const match = Object.entries(ANALYTICS_PATHS).find(
    ([, expectedPath]) => pathname === expectedPath,
  );
  return match === undefined ? null : (match[0] as AnalyticsOperation);
}

function waitForAnalyticsResponse(
  page: Page,
  operation: AnalyticsOperation,
): Promise<Response> {
  return page.waitForResponse((response) => {
    return analyticsOperation(response.request()) === operation;
  });
}

async function inspectCurrentUserResponse(
  response: APIResponse,
): Promise<CurrentUserObservation> {
  const payload: unknown = await response.json();
  const isObject = typeof payload === 'object' && payload !== null;
  const role = isObject && 'role' in payload ? payload.role : undefined;
  const email = isObject && 'email' in payload ? payload.email : undefined;
  const isActive = isObject && 'is_active' in payload ? payload.is_active : undefined;
  return {
    activeAdministrator: role === 'admin' && isActive === true,
    exactEmail: email === DEMO_ADMIN_EMAIL,
    status: response.status(),
    superAdministrator: role === 'super_admin',
  };
}

test('starts and ends the real reserved administrator demo session', async ({
  page,
}) => {
  const demoRequests: DemoRequestObservation[] = [];
  const restrictedDemoRequests: string[] = [];
  const analyticsStatuses: Array<{
    readonly operation: AnalyticsOperation;
    readonly status: number;
  }> = [];
  const recordAnalyticsResponse = (response: Response): void => {
    const operation = analyticsOperation(response.request());
    if (operation !== null) {
      analyticsStatuses.push({ operation, status: response.status() });
    }
  };
  page.on('response', recordAnalyticsResponse);
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (
      pathname.startsWith('/api/v1/account/orders') ||
      pathname.startsWith('/api/v1/admin/menu')
    ) {
      restrictedDemoRequests.push(pathname);
    }
    if (!isApiPath(request, '/api/v1/auth/demo-session')) {
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

  await page.route('**/api/v1/auth/me', async (route) => {
    const backendResponse = await route.fetch();
    captureCurrentUser(await inspectCurrentUserResponse(backendResponse));
    await currentUserResponseGate;
    await route.fulfill({ response: backendResponse });
  });

  try {
    await page.goto('/menu');
    await page.getByRole('link', { name: 'Try admin demo' }).click();
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/u);

    const demoResponse = page.waitForResponse(
      (response) =>
        isApiPath(response.request(), '/api/v1/auth/demo-session') &&
        response.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Try admin demo' }).click();

    expect((await demoResponse).status()).toBe(200);
    const currentUser = await currentUserCaptured;
    expect(currentUser).toEqual({
      activeAdministrator: true,
      exactEmail: true,
      status: 200,
      superAdministrator: false,
    });
    await expect(page).toHaveURL(/\/login\?next=%2Fadmin$/u);
    await expect(
      page.getByRole('heading', { name: 'Checking your session' }),
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
    await expect(page).toHaveURL(/\/admin$/u);
    await expect(
      page.getByText('Portfolio demo · shared synthetic data', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText(DEMO_ADMIN_EMAIL, { exact: true })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Users', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Menu', exact: true })).toHaveCount(0);
    await expect(
      page.getByRole('link', { name: 'Menu sandbox', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Review orders', exact: true }),
    ).toBeVisible();

    await page.setViewportSize({ height: 900, width: 640 });
    await expect(
      page.getByRole('link', { name: 'Open analytics', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View exports', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          document: { documentElement: { scrollWidth: number } };
          innerWidth: number;
        };
        return runtime.document.documentElement.scrollWidth <= runtime.innerWidth + 1;
      }),
    ).toBe(true);

    await page.goto('/admin/menu');
    await expect(page.getByRole('heading', { name: 'Menu sandbox' })).toBeVisible();
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          document: { documentElement: { scrollWidth: number } };
          innerWidth: number;
        };
        return runtime.document.documentElement.scrollWidth <= runtime.innerWidth + 1;
      }),
    ).toBe(true);

    await page.goto('/account');
    await expect(
      page.getByRole('heading', {
        name: 'Personal account is unavailable in this demo',
      }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'My account' })).toHaveCount(0);

    await page.setViewportSize({ height: 812, width: 375 });
    await page.goto('/admin/menu');
    await expect(page.getByRole('heading', { name: 'Menu sandbox' })).toBeVisible();
    await expect(
      page.getByText(/Changes stay in this browser memory only/u),
    ).toBeVisible();
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          document: { documentElement: { scrollWidth: number } };
          innerWidth: number;
        };
        return runtime.document.documentElement.scrollWidth <= runtime.innerWidth + 1;
      }),
    ).toBe(true);
    const firstEditor = page.getByRole('group').first();
    const originalName = await firstEditor.getByLabel('Name').inputValue();
    await firstEditor.getByLabel('Name').fill('Browser preview dish');
    await expect(
      page
        .getByRole('region', { name: 'Current browser preview' })
        .getByText('Browser preview dish'),
    ).toBeVisible();
    const addDishButtons = page.getByRole('button', { name: /^Add dish to /u });
    await expect(addDishButtons).toHaveCount(5);
    const targetCategory = addDishButtons.nth(1).locator('xpath=ancestor::section[1]');
    await addDishButtons.nth(1).click();
    const sampleEditor = targetCategory.getByRole('group', {
      exact: true,
      name: 'Sample dish 1',
    });
    await expect(sampleEditor).toBeVisible();
    await sampleEditor
      .getByLabel('Local preview image for Sample dish 1', { exact: true })
      .setInputFiles({
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ),
        mimeType: 'image/png',
        name: 'browser-preview.png',
      });
    await expect(
      page
        .getByRole('region', { name: 'Current browser preview' })
        .getByRole('img', { exact: true, name: 'Sample dish 1 preview' }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Admin home' }).click();
    await page.getByRole('link', { name: 'Menu sandbox', exact: true }).click();
    await expect(page.getByLabel('Name').first()).toHaveValue('Browser preview dish');
    await page.getByRole('button', { name: 'Reset to original menu' }).click();
    await expect(page.getByLabel('Name').first()).toHaveValue(originalName);
    await expect(
      page.getByRole('group', { exact: true, name: 'Sample dish 1' }),
    ).toHaveCount(0);
    expect(restrictedDemoRequests).toEqual([]);

    const analyticsResponses = Object.keys(ANALYTICS_PATHS).map((operation) => {
      return waitForAnalyticsResponse(page, operation as AnalyticsOperation);
    });
    await page.goto('/admin/analytics');
    for (const response of await Promise.all(analyticsResponses)) {
      expect(response.status()).toBe(200);
    }
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Analytics' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { exact: true, name: 'Historical demo data' }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      page
        .getByRole('region', { exact: true, name: 'Applied analytics context' })
        .getByText('Applied', { exact: true }),
    ).toBeVisible();
    for (const sectionName of [
      'Overview',
      'Product sales',
      'Category sales',
      'Order types',
    ]) {
      const section = page.getByRole('region', {
        exact: true,
        name: sectionName,
      });
      await expect(section).toHaveAttribute('aria-busy', 'false');
      await expect(section.getByText('Section unavailable')).toHaveCount(0);
    }
    const analyticsCurrency = page.getByLabel('Currency', { exact: true });
    await expect(analyticsCurrency).toHaveValue('NOK');
    await expect(analyticsCurrency.locator('option[value=""]')).toHaveText(
      'All currencies',
    );
    await expect(
      page.getByRole('heading', {
        exact: true,
        name: 'Approximate NOK conversion',
      }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          document: { documentElement: { scrollWidth: number } };
          innerWidth: number;
        };
        return runtime.document.documentElement.scrollWidth <= runtime.innerWidth + 1;
      }),
    ).toBe(true);

    await page.setViewportSize({ height: 900, width: 640 });
    const exportSamplePeriodResponse = waitForAnalyticsResponse(page, 'samplePeriod');
    await page.goto('/admin/exports');
    expect((await exportSamplePeriodResponse).status()).toBe(200);
    await expect(
      page.getByRole('heading', { exact: true, level: 1, name: 'Exports' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { exact: true, name: 'Historical demo data' }),
    ).toBeVisible();
    for (const buttonName of [
      'Download orders CSV',
      'Download product sales CSV',
      'Download payments CSV',
    ]) {
      await expect(
        page.getByRole('button', { exact: true, name: buttonName }),
      ).toBeEnabled();
    }
    const exportCurrency = page.getByLabel('Currency', { exact: true });
    await expect(exportCurrency).toHaveValue('NOK');
    await expect(exportCurrency.locator('option[value=""]')).toHaveText(
      'All currencies',
    );
    expect(
      await page.evaluate(() => {
        const runtime = globalThis as typeof globalThis & {
          document: { documentElement: { scrollWidth: number } };
          innerWidth: number;
        };
        return runtime.document.documentElement.scrollWidth <= runtime.innerWidth + 1;
      }),
    ).toBe(true);

    await page.goto('/menu');
    await expect(
      page.getByText('Admin demo · shared synthetic data', { exact: true }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Admin', exact: true }).click();
    await expect(page).toHaveURL(/\/admin$/u);
    expect(demoRequests).toHaveLength(1);

    const storedSessionState = await page.evaluate(
      ({ authKey, demoKey }) => {
        const storage = (
          globalThis as typeof globalThis & {
            sessionStorage: { getItem: (key: string) => string | null };
          }
        ).sessionStorage;
        return {
          authPresent: storage.getItem(authKey) !== null,
          demoPresent: storage.getItem(demoKey) !== null,
        };
      },
      { authKey: AUTH_STORAGE_KEY, demoKey: DEMO_SESSION_STORAGE_KEY },
    );
    expect(storedSessionState).toEqual({ authPresent: true, demoPresent: true });
    expect(analyticsStatuses.length).toBeGreaterThanOrEqual(6);
    expect(analyticsStatuses.filter(({ status }) => status !== 200)).toEqual([]);

    await page.getByRole('button', { name: 'Log out' }).click();
    await expect(page).toHaveURL(/\/$/u);
    await expect(page.getByRole('link', { name: 'Try admin demo' })).toBeVisible();
    const clearedSessionState = await page.evaluate(
      ({ authKey, demoKey }) => {
        const storage = (
          globalThis as typeof globalThis & {
            sessionStorage: { getItem: (key: string) => string | null };
          }
        ).sessionStorage;
        return {
          authPresent: storage.getItem(authKey) !== null,
          demoPresent: storage.getItem(demoKey) !== null,
        };
      },
      { authKey: AUTH_STORAGE_KEY, demoKey: DEMO_SESSION_STORAGE_KEY },
    );
    expect(clearedSessionState).toEqual({
      authPresent: false,
      demoPresent: false,
    });
  } finally {
    releaseCurrentUserResponse();
    page.off('response', recordAnalyticsResponse);
    await page.unroute('**/api/v1/auth/me');
  }
});
