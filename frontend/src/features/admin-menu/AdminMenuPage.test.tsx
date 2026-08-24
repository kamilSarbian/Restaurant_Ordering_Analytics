import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import { AuthProvider } from '../auth/AuthContext';
import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub } from '../../test/fetchStub';

const TOKEN = 'synthetic-menu-admin-token';
const CATEGORY_ID = '00000000-0000-4000-8000-000000000101';
const INACTIVE_CATEGORY_ID = '00000000-0000-4000-8000-000000000102';
const ITEM_ID = '00000000-0000-4000-8000-000000000201';
const SECOND_ITEM_ID = '00000000-0000-4000-8000-000000000202';
const UPDATED_AT = '2026-08-12T12:00:00+00:00';
const ME = {
  email: 'menu-admin@example.test',
  id: '00000000-0000-4000-8000-000000000903',
  is_active: true,
  role: 'admin',
};
const CUSTOMER_ME = { ...ME, role: 'customer' };

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value | PromiseLike<Value>) => void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolveValue: Deferred<Value>['resolve'] = () => {
    throw new Error('Deferred test value was not initialized');
  };
  const promise = new Promise<Value>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

function category(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    created_at: '2026-08-11T12:00:00+00:00',
    description: 'Drinks served all day.',
    display_order: 10,
    id: CATEGORY_ID,
    is_active: true,
    name: 'Drinks',
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function item(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    allergens: ['milk'],
    category_id: CATEGORY_ID,
    cost_amount: 4500,
    created_at: '2026-08-11T12:00:00+00:00',
    currency: 'NOK',
    description: 'Freshly prepared.',
    display_order: 20,
    id: ITEM_ID,
    image_url: null,
    is_active: true,
    is_available: false,
    name: 'Coffee',
    price_amount: 9900,
    updated_at: UPDATED_AT,
    ...overrides,
  };
}

function categoryPage(
  items: Record<string, unknown>[] = [category()],
  overrides: Partial<Record<string, unknown>> = {},
) {
  return { items, limit: 50, offset: 0, total: items.length, ...overrides };
}

function itemPage(
  items: Record<string, unknown>[] = [item()],
  overrides: Partial<Record<string, unknown>> = {},
) {
  return { items, limit: 50, offset: 0, total: items.length, ...overrides };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function renderMenu(): ReturnType<typeof createMemoryRouter> {
  storeToken();
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/', element: <h1>Customer home</h1> },
          { path: '/account', element: <h1>Customer account</h1> },
          { path: '/login', element: <h1>Sign in</h1> },
          adminRoutes,
        ],
      },
    ],
    { initialEntries: ['/admin/menu'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}

async function waitForInitialMenu(): Promise<void> {
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Menu' }),
  ).toBeInTheDocument();
  await screen.findAllByText('Coffee');
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.unstubAllGlobals();
});

describe('administrator category management', () => {
  it('refreshes canonical identity after a menu 403 and applies the customer guard', async () => {
    const categoryResponse = createDeferred<Response>();
    const itemResponse = createDeferred<Response>();
    const initialRequestsStarted = createDeferred<void>();
    const stub = installFetchStub(
      { json: ME },
      { responsePromise: categoryResponse.promise },
      { responsePromise: itemResponse.promise },
      { status: 403 },
      { json: CUSTOMER_ME },
    );
    const queuedFetch = stub.fetch;
    const fetchWithInitialRequestBarrier: typeof fetch = (input, init) => {
      const response = queuedFetch(input, init);
      if (stub.calls.length === 3) {
        initialRequestsStarted.resolve(undefined);
      }
      return response;
    };
    vi.stubGlobal('fetch', fetchWithInitialRequestBarrier);
    const router = renderMenu();
    const user = userEvent.setup();
    await initialRequestsStarted.promise;
    expect(stub.calls.slice(0, 3).map((call) => call.url)).toEqual([
      '/api/v1/auth/me',
      '/api/v1/admin/menu/categories?limit=50&offset=0',
      '/api/v1/admin/menu/items?limit=50&offset=0',
    ]);
    await act(async () => {
      categoryResponse.resolve(jsonResponse(categoryPage()));
      itemResponse.resolve(jsonResponse(itemPage([])));
      await Promise.all([categoryResponse.promise, itemResponse.promise]);
    });
    expect(
      screen.getByRole('heading', { name: 'No menu items yet' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));
    await user.type(screen.getByLabelText('Name'), 'Forbidden item');
    await user.type(screen.getByLabelText('Price (minor units)'), '100');

    await user.click(screen.getByRole('button', { name: 'Create menu item' }));

    expect(
      await screen.findByRole('heading', { name: 'Customer account' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/account');
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(stub.calls.map((call) => call.url)).toContain('/api/v1/auth/me');
    expect(stub.calls.filter((call) => call.url === '/api/v1/auth/me')).toHaveLength(2);
  });

  it('keeps the admin page mounted when a menu 403 refresh confirms the admin role', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage() },
      { status: 403 },
      { json: ME },
    );
    renderMenu();
    const user = userEvent.setup();
    await waitForInitialMenu();
    await user.click(screen.getByRole('button', { name: 'Edit Coffee' }));
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Forbidden edit');

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(
      await screen.findByText(
        'The menu item could not be saved. Review the form and try again.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Menu' })).toBeVisible();
    expect(stub.calls.filter((call) => call.url === '/api/v1/auth/me')).toHaveLength(2);
    expect(
      stub.calls.filter((call) =>
        call.url.includes(`/api/v1/admin/menu/items/${ITEM_ID}`),
      ),
    ).toHaveLength(1);
  });

  it('loads exact authenticated category and item pages and renders safe operational data', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage() },
    );

    renderMenu();

    expect(
      screen.getByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    await waitForInitialMenu();
    expect(stub.calls.map((call) => call.url)).toEqual([
      '/api/v1/auth/me',
      '/api/v1/admin/menu/categories?limit=50&offset=0',
      '/api/v1/admin/menu/items?limit=50&offset=0',
    ]);
    expect(
      stub.calls
        .slice(1)
        .every((call) => call.headers.get('Authorization') === `Bearer ${TOKEN}`),
    ).toBe(true);
    expect(
      screen.getByText(
        'Changes affect future orders only. Historical order snapshots and analytics do not change.',
      ),
    ).toBeVisible();
    expect(screen.queryByText(CATEGORY_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(ITEM_ID)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
  });

  it('keeps category and item loading failures independent and validates strict DTOs', async () => {
    installFetchStub(
      { json: ME },
      { json: { ...categoryPage(), extra: true } },
      { json: itemPage([]) },
    );

    renderMenu();

    expect(
      await screen.findByRole('heading', { name: 'Unable to load categories' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'No menu items yet' }),
    ).toBeVisible();
    expect(screen.getByText(/unexpected response/i)).toBeVisible();
  });

  it('renders an empty category state independently and rejects a malformed item DTO', async () => {
    installFetchStub(
      { json: ME },
      { json: categoryPage([]) },
      { json: itemPage([item({ currency: 'nok' })]) },
    );

    renderMenu();

    expect(
      await screen.findByRole('heading', { name: 'No categories yet' }),
    ).toBeVisible();
    expect(
      await screen.findByRole('heading', { name: 'Unable to load menu items' }),
    ).toBeVisible();
    expect(screen.getByText(/unexpected response/i)).toBeVisible();
  });

  it('uses backend pagination and manual category refresh without client sorting', async () => {
    const first = category({ name: 'First page' });
    const next = category({ id: INACTIVE_CATEGORY_ID, name: 'Second page' });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage([first], { total: 51 }) },
      { json: itemPage([]) },
      { json: categoryPage([next], { offset: 50, total: 51 }) },
      { json: categoryPage([next], { offset: 50, total: 51 }) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('First page');

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect((await screen.findAllByText('Second page'))[0]).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Refresh categories' }));

    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(stub.calls[3]?.url).toBe('/api/v1/admin/menu/categories?limit=50&offset=50');
    expect(stub.calls[4]?.url).toBe('/api/v1/admin/menu/categories?limit=50&offset=50');
  });

  it('validates category input before sending and focuses the first invalid field', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');

    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.clear(screen.getByLabelText('Display order'));
    await user.type(screen.getByLabelText('Display order'), '-1');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(screen.getByText('Enter a category name.')).toBeVisible();
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
    expect(stub.calls).toHaveLength(3);
  });

  it('sends the exact category POST once, does not update optimistically, and refetches on success', async () => {
    let resolveMutation!: (response: Response) => void;
    const pendingMutation = new Promise<Response>((resolve) => {
      resolveMutation = resolve;
    });
    const created = category({
      description: null,
      display_order: 0,
      id: INACTIVE_CATEGORY_ID,
      is_active: false,
      name: 'Desserts',
    });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { responsePromise: pendingMutation },
      { json: categoryPage([category(), created]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), '  Desserts  ');
    await user.click(screen.getByLabelText(/Active — visible/));
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(screen.queryByText('Desserts')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(stub.calls).toHaveLength(4);
    expect(stub.calls[3]).toMatchObject({
      method: 'POST',
      url: '/api/v1/admin/menu/categories',
    });
    expect(JSON.parse(stub.calls[3]?.body ?? '')).toEqual({
      description: null,
      display_order: 0,
      is_active: false,
      name: 'Desserts',
    });

    resolveMutation(
      new Response(JSON.stringify(created), {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      }),
    );
    expect(
      await screen.findByText('The category was created and the list was refreshed.'),
    ).toBeVisible();
    expect((await screen.findAllByText('Desserts'))[0]).toBeVisible();
    expect(stub.calls).toHaveLength(5);
  });

  it('sends only changed category PATCH fields, supports null clearing, and rejects an empty PATCH', async () => {
    const updated = category({ description: null });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { json: updated },
      { json: categoryPage([updated]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');
    await user.click(screen.getByRole('button', { name: 'Edit Drinks' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      screen.getByText('Change at least one category field before saving.'),
    ).toBeVisible();
    expect(stub.calls).toHaveLength(3);

    await user.clear(screen.getByLabelText('Description'));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await screen.findByText('The category was updated and the list was refreshed.');

    expect(stub.calls[3]?.url).toBe(`/api/v1/admin/menu/categories/${CATEGORY_ID}`);
    expect(stub.calls[3]?.method).toBe('PATCH');
    expect(JSON.parse(stub.calls[3]?.body ?? '')).toEqual({ description: null });
  });

  it.each([
    [409, 'A category with this name already exists.'],
    [422, 'Review the category fields and try again.'],
  ])('maps category HTTP %s safely and preserves the form', async (status, message) => {
    installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { status },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Duplicate');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('Duplicate');
  });

  it('locks an ambiguous category mutation until a deliberate refresh', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { error: new TypeError('synthetic network failure') },
      { json: categoryPage() },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Uncertain');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(await screen.findByText(/result could not be confirmed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create category' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh categories' }));
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'Create category' })).toBeEnabled();
  });

  it('treats a category mutation 503 as uncertain until a deliberate refresh', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { status: 503 },
      { json: categoryPage() },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Uncertain service result');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(await screen.findByText(/result could not be confirmed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create category' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh categories' }));
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'Create category' })).toBeEnabled();
  });

  it('expires the session on category mutation 401', async () => {
    installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { status: 401 },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Drinks');
    await user.click(screen.getByRole('button', { name: 'Add category' }));
    await user.type(screen.getByLabelText('Name'), 'Unauthorized');
    await user.click(screen.getByRole('button', { name: 'Create category' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});

describe('administrator menu-item management', () => {
  it('paginates menu items and uses a safe category-name fallback', async () => {
    const unknownCategoryItem = item({
      category_id: INACTIVE_CATEGORY_ID,
      name: 'Unknown category item',
    });
    const second = item({ id: SECOND_ITEM_ID, name: 'Second page item' });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([unknownCategoryItem], { total: 51 }) },
      { json: itemPage([second], { offset: 50, total: 51 }) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findAllByText('Unknown category item');
    expect(screen.getAllByText('Category not loaded').length).toBeGreaterThan(0);
    await user.click(screen.getAllByRole('button', { name: 'Next' })[1]!);
    expect((await screen.findAllByText('Second page item'))[0]).toBeVisible();
    expect(stub.calls[3]?.url).toBe('/api/v1/admin/menu/items?limit=50&offset=50');
  });

  it('manually refreshes the current menu-item page', async () => {
    const refreshed = item({ name: 'Refreshed coffee' });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage() },
      { json: itemPage([refreshed]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await waitForInitialMenu();

    await user.click(screen.getByRole('button', { name: 'Refresh menu items' }));

    expect((await screen.findAllByText('Refreshed coffee'))[0]).toBeVisible();
    expect(stub.calls[3]?.url).toBe('/api/v1/admin/menu/items?limit=50&offset=0');
  });

  it('loads all category pages and keeps inactive categories selectable', async () => {
    const inactive = category({
      id: INACTIVE_CATEGORY_ID,
      is_active: false,
      name: 'Archived',
    });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage([category()], { total: 2 }) },
      { json: itemPage() },
      { json: { items: [category(), inactive], limit: 100, offset: 0, total: 2 } },
    );
    const user = userEvent.setup();
    renderMenu();
    await waitForInitialMenu();
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));

    const select = await screen.findByLabelText('Category');
    expect(select).toContainHTML('Archived (inactive)');
    expect(stub.calls[3]?.url).toBe('/api/v1/admin/menu/categories?limit=100&offset=0');
  });

  it('sends the exact menu-item POST with minor units, uppercase currency, allergens, and independent controls', async () => {
    let resolveMutation!: (response: Response) => void;
    const pendingMutation = new Promise<Response>((resolve) => {
      resolveMutation = resolve;
    });
    const inactive = category({
      id: INACTIVE_CATEGORY_ID,
      is_active: false,
      name: 'Archived',
    });
    const created = item({
      allergens: ['milk', 'milk'],
      category_id: INACTIVE_CATEGORY_ID,
      cost_amount: null,
      currency: 'EUR',
      description: null,
      image_url: null,
      is_active: false,
      is_available: true,
      name: 'Latte',
      price_amount: 1250,
    });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage([category(), inactive]) },
      { json: itemPage([]) },
      { responsePromise: pendingMutation },
      { json: itemPage([created]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findByRole('heading', { name: 'No menu items yet' });
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));
    await user.selectOptions(screen.getByLabelText('Category'), INACTIVE_CATEGORY_ID);
    await user.type(screen.getByLabelText('Name'), ' Latte ');
    await user.type(screen.getByLabelText('Price (minor units)'), '1250');
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'eur');
    await user.type(
      screen.getByLabelText('Allergens — one per line'),
      ' milk \n\n milk ',
    );
    await user.click(screen.getByLabelText(/Active — catalog record enabled/));
    await user.click(screen.getByRole('button', { name: 'Create menu item' }));

    expect(screen.queryByText('Latte')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    expect(stub.calls).toHaveLength(4);
    expect(JSON.parse(stub.calls[3]?.body ?? '')).toEqual({
      allergens: ['milk', 'milk'],
      category_id: INACTIVE_CATEGORY_ID,
      cost_amount: null,
      currency: 'EUR',
      description: null,
      display_order: 0,
      image_url: null,
      is_active: false,
      is_available: true,
      name: 'Latte',
      price_amount: 1250,
    });

    resolveMutation(
      new Response(JSON.stringify(created), {
        headers: { 'Content-Type': 'application/json' },
        status: 201,
      }),
    );
    await screen.findByText('The menu item was created and the list was refreshed.');
    expect(stub.calls).toHaveLength(5);
  });

  it('sends only changed item PATCH fields and supports reassignment and nullable clearing', async () => {
    const inactive = category({
      id: INACTIVE_CATEGORY_ID,
      is_active: false,
      name: 'Archived',
    });
    const updated = item({
      category_id: INACTIVE_CATEGORY_ID,
      cost_amount: null,
      description: null,
      image_url: null,
      is_active: false,
      is_available: true,
    });
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage([category(), inactive]) },
      { json: itemPage([item({ image_url: 'https://example.test/coffee.jpg' })]) },
      { json: updated },
      { json: itemPage([updated]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await waitForInitialMenu();
    await user.click(screen.getByRole('button', { name: 'Edit Coffee' }));
    await user.selectOptions(screen.getByLabelText('Category'), INACTIVE_CATEGORY_ID);
    await user.clear(screen.getByLabelText('Description'));
    await user.clear(screen.getByLabelText('Image URL'));
    await user.clear(screen.getByLabelText('Cost (minor units, optional)'));
    await user.click(screen.getByLabelText(/Active — catalog record enabled/));
    await user.click(screen.getByLabelText(/Available — currently orderable/));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await screen.findByText('The menu item was updated and the list was refreshed.');
    expect(stub.calls[3]?.url).toBe(`/api/v1/admin/menu/items/${ITEM_ID}`);
    expect(JSON.parse(stub.calls[3]?.body ?? '')).toEqual({
      category_id: INACTIVE_CATEGORY_ID,
      cost_amount: null,
      description: null,
      image_url: null,
      is_active: false,
      is_available: true,
    });
  });

  it.each([
    ['12.50', '', 'Price must be a positive safe integer.'],
    ['100', '-1', 'Cost must be blank or a non-negative safe integer.'],
    ['9007199254740992', '', 'Price must be a positive safe integer.'],
  ])(
    'rejects invalid integer money input price=%s cost=%s',
    async (price, cost, message) => {
      const stub = installFetchStub(
        { json: ME },
        { json: categoryPage() },
        { json: itemPage([]) },
      );
      const user = userEvent.setup();
      renderMenu();
      await screen.findByRole('heading', { name: 'No menu items yet' });
      await user.click(screen.getByRole('button', { name: 'Add menu item' }));
      await user.type(screen.getByLabelText('Name'), 'Invalid money');
      await user.type(screen.getByLabelText('Price (minor units)'), price);
      if (cost)
        await user.type(screen.getByLabelText('Cost (minor units, optional)'), cost);
      await user.click(screen.getByRole('button', { name: 'Create menu item' }));

      expect(screen.getByText(message)).toBeVisible();
      expect(stub.calls).toHaveLength(3);
    },
  );

  it('rejects invalid currency and an empty item PATCH before transport', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage() },
    );
    const user = userEvent.setup();
    renderMenu();
    await waitForInitialMenu();
    await user.click(screen.getByRole('button', { name: 'Edit Coffee' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      screen.getByText('Change at least one menu-item field before saving.'),
    ).toBeVisible();
    await user.clear(screen.getByLabelText('Currency'));
    await user.type(screen.getByLabelText('Currency'), 'N1');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(screen.getByText(/exactly three uppercase ASCII letters/i)).toBeVisible();
    expect(stub.calls).toHaveLength(3);
  });

  it.each([
    [409, 'A menu item with this name already exists in the selected category.'],
    [422, 'Review the menu-item fields and try again.'],
  ])('maps menu-item HTTP %s safely', async (status, message) => {
    installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { status },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findByRole('heading', { name: 'No menu items yet' });
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));
    await user.type(screen.getByLabelText('Name'), 'Duplicate');
    await user.type(screen.getByLabelText('Price (minor units)'), '100');
    await user.click(screen.getByRole('button', { name: 'Create menu item' }));
    expect(await screen.findByText(message)).toBeVisible();
  });

  it('treats a 503 item mutation as uncertain and unlocks only after item refresh', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { status: 503 },
      { json: itemPage([]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findByRole('heading', { name: 'No menu items yet' });
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));
    await user.type(screen.getByLabelText('Name'), 'Uncertain item');
    await user.type(screen.getByLabelText('Price (minor units)'), '100');
    await user.click(screen.getByRole('button', { name: 'Create menu item' }));
    expect(await screen.findByText(/result could not be confirmed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create menu item' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh menu items' }));
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'Create menu item' })).toBeEnabled();
  });

  it('treats an item mutation network error as uncertain until item refresh', async () => {
    const stub = installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { error: new TypeError('synthetic item network failure') },
      { json: itemPage([]) },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findByRole('heading', { name: 'No menu items yet' });
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));
    await user.type(screen.getByLabelText('Name'), 'Uncertain network item');
    await user.type(screen.getByLabelText('Price (minor units)'), '100');
    await user.click(screen.getByRole('button', { name: 'Create menu item' }));

    expect(await screen.findByText(/result could not be confirmed/i)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create menu item' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Refresh menu items' }));
    await waitFor(() => expect(stub.calls).toHaveLength(5));
    expect(screen.getByRole('button', { name: 'Create menu item' })).toBeEnabled();
  });

  it('expires the session on a menu-item mutation 401', async () => {
    installFetchStub(
      { json: ME },
      { json: categoryPage() },
      { json: itemPage([]) },
      { status: 401 },
    );
    const user = userEvent.setup();
    renderMenu();
    await screen.findByRole('heading', { name: 'No menu items yet' });
    await user.click(screen.getByRole('button', { name: 'Add menu item' }));
    await user.type(screen.getByLabelText('Name'), 'Unauthorized item');
    await user.type(screen.getByLabelText('Price (minor units)'), '100');
    await user.click(screen.getByRole('button', { name: 'Create menu item' }));

    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });
});
