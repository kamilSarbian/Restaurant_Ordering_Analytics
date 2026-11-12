import { expect, test, type Request } from '@playwright/test';

const AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
const DEMO_SESSION_STORAGE_KEY = 'restaurant-ordering:demo-session:v1';
const DEMO_ADMIN_EMAIL = 'demo-admin@example.com';

interface DemoRequestObservation {
  readonly bodyAbsent: boolean;
  readonly contentTypeAbsent: boolean;
  readonly cookieAbsent: boolean;
  readonly method: string;
}

function isApiPath(request: Request, pathname: string): boolean {
  return new URL(request.url()).pathname === pathname;
}

test('starts and ends the real reserved administrator demo session', async ({
  page,
}) => {
  const demoRequests: DemoRequestObservation[] = [];
  const restrictedDemoRequests: string[] = [];
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
  let markCurrentUserResponseCaptured: (status: number) => void = () => undefined;
  const currentUserResponseCaptured = new Promise<number>((resolve) => {
    markCurrentUserResponseCaptured = resolve;
  });

  await page.route('**/api/v1/auth/me', async (route) => {
    const backendResponse = await route.fetch();
    markCurrentUserResponseCaptured(backendResponse.status());
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
    expect(await currentUserResponseCaptured).toBe(200);
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
    await expect(page.getByRole('link', { name: 'Review orders' })).toBeVisible();

    await page.goto('/account');
    await expect(
      page.getByRole('heading', {
        name: 'Personal account is unavailable in this demo',
      }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'My account' })).toHaveCount(0);

    await page.goto('/admin/menu');
    await expect(
      page.getByRole('heading', { name: 'Menu management is unavailable' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'View the public menu' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Menu', exact: true })).toHaveCount(0);
    expect(restrictedDemoRequests).toEqual([]);

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
    await page.unroute('**/api/v1/auth/me');
  }
});
