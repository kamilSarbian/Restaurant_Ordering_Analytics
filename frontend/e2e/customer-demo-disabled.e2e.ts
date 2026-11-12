import { expect, test, type Page, type Request, type Response } from '@playwright/test';

const CUSTOMER_DEMO_SESSION_PATH = '/api/v1/auth/customer-demo-session';
const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/u;

interface RequestObservation {
  readonly bodyAbsent: boolean;
  readonly contentTypeAbsent: boolean;
  readonly cookieAbsent: boolean;
  readonly method: string;
}

function waitForApiResponse(
  page: Page,
  method: string,
  pathname: string,
): Promise<Response> {
  return page.waitForResponse((response) => {
    const parsed = new URL(response.url());
    return parsed.pathname === pathname && response.request().method() === method;
  });
}

async function assertResponseStatus(
  responsePromise: Promise<Response>,
  expectedStatus: number,
): Promise<void> {
  const response = await responsePromise;
  expect(response.status()).toBe(expectedStatus);
}

test('keeps customer demo disabled while admin demo remains available', async ({
  page,
}) => {
  const observations: RequestObservation[] = [];
  const observeCustomerDemoRequest = (request: Request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname !== CUSTOMER_DEMO_SESSION_PATH) {
      return;
    }
    const headers = request.headers();
    observations.push({
      bodyAbsent: request.postData() === null,
      contentTypeAbsent: headers['content-type'] === undefined,
      cookieAbsent: headers.cookie === undefined,
      method: request.method(),
    });
  };
  page.on('request', observeCustomerDemoRequest);

  try {
    await page.goto('/menu');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Our menu' }),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try admin demo' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Try customer demo' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Log in' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: 'Add to cart' }).first(),
    ).toBeVisible();

    await page.goto('/login');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Choose a portfolio demo path' }),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try admin demo' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try customer demo' })).toHaveCount(
      0,
    );

    const result = await page.evaluate(async (pathname) => {
      const response = await fetch(pathname, {
        credentials: 'omit',
        method: 'POST',
      });
      let genericNotFound = false;
      let tokenAbsent = false;
      try {
        const payload: unknown = await response.json();
        genericNotFound =
          typeof payload === 'object' &&
          payload !== null &&
          'detail' in payload &&
          payload.detail === 'Not Found';
        tokenAbsent =
          typeof payload === 'object' &&
          payload !== null &&
          !('access_token' in payload) &&
          !('token' in payload);
      } catch (error: unknown) {
        void error;
      }
      return { genericNotFound, status: response.status, tokenAbsent };
    }, CUSTOMER_DEMO_SESSION_PATH);

    expect(result).toEqual({
      genericNotFound: true,
      status: 404,
      tokenAbsent: true,
    });
    expect(observations).toEqual([
      {
        bodyAbsent: true,
        contentTypeAbsent: true,
        cookieAbsent: true,
        method: 'POST',
      },
    ]);
  } finally {
    page.off('request', observeCustomerDemoRequest);
  }
});

test('preserves anonymous ordering and synchronous demo checkout', async ({ page }) => {
  test.setTimeout(60_000);
  const customerDemoRequests: Request[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === CUSTOMER_DEMO_SESSION_PATH) {
      customerDemoRequests.push(request);
    }
  });

  await page.goto('/menu');
  const firstMenuItem = page.getByRole('article').first();
  await expect(
    firstMenuItem.getByRole('button', { name: 'Add to cart' }),
  ).toBeVisible();
  await firstMenuItem.getByRole('button', { name: 'Add to cart' }).click();

  const menuResponse = waitForApiResponse(page, 'GET', '/api/v1/menu');
  const quoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  await page.getByRole('link', { name: 'View cart', exact: true }).click();
  await Promise.all([
    assertResponseStatus(menuResponse, 200),
    assertResponseStatus(quoteResponse, 200),
  ]);

  const freshQuoteResponse = waitForApiResponse(page, 'POST', '/api/v1/orders/quote');
  const createOrderResponse = waitForApiResponse(page, 'POST', '/api/v1/orders');
  await page
    .getByRole('button', {
      name: 'Place demo order and continue to simulated payment',
    })
    .click();
  await Promise.all([
    assertResponseStatus(freshQuoteResponse, 200),
    assertResponseStatus(createOrderResponse, 201),
  ]);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order created' }),
  ).toBeVisible();

  const checkoutMatch =
    /^\/orders\/(ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12})\/checkout$/u.exec(
      new URL(page.url()).pathname,
    );
  expect(checkoutMatch).not.toBeNull();
  const publicOrderNumber = checkoutMatch?.[1] ?? '';
  expect(PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber)).toBe(true);

  const checkoutResponse = waitForApiResponse(
    page,
    'POST',
    `/api/v1/orders/${publicOrderNumber}/checkout-session`,
  );
  await page.getByRole('button', { name: 'Run simulated payment' }).click();
  await assertResponseStatus(checkoutResponse, 201);
  await expect(
    page.getByRole('heading', {
      level: 2,
      name: /^(Demo payment completed|Payment failed|Payment attempt expired)$/u,
    }),
  ).toBeVisible();

  const statusResponse = waitForApiResponse(
    page,
    'GET',
    `/api/v1/orders/${publicOrderNumber}`,
  );
  await page.goto(`/orders/${publicOrderNumber}/status`);
  await assertResponseStatus(statusResponse, 200);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Order status' }),
  ).toBeVisible();
  expect(customerDemoRequests).toHaveLength(0);
});
