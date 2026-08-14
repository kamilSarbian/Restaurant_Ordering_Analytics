import { afterEach, vi } from 'vitest';

import { AdminApiRequestError } from '../../api/adminApi';
import { installFetchStub } from '../../test/fetchStub';
import {
  fetchAdminUsers,
  updateAdminUserRole,
  type UpdateAdminUserRoleOptions,
} from './adminUsersApi';

const ACCESS_TOKEN = 'synthetic-super-admin-access-token';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000101';
const ADMIN_ID = '00000000-0000-4000-8000-000000000102';
const SUPER_ADMIN_ID = '00000000-0000-4000-8000-000000000103';
const CREATED_AT = '2026-08-12T08:00:00+02:00';
const UPDATED_AT = '2026-08-12T08:05:00+02:00';
const LIST_ITEMS = [
  {
    created_at: CREATED_AT,
    email: 'customer@example.test',
    id: CUSTOMER_ID,
    is_active: true,
    role: 'customer',
    updated_at: UPDATED_AT,
  },
  {
    created_at: CREATED_AT,
    email: 'admin@example.test',
    id: ADMIN_ID,
    is_active: false,
    role: 'admin',
    updated_at: UPDATED_AT,
  },
  {
    created_at: CREATED_AT,
    email: 'super-admin@example.test',
    id: SUPER_ADMIN_ID,
    is_active: true,
    role: 'super_admin',
    updated_at: UPDATED_AT,
  },
] as const;
const LIST_RESPONSE = {
  items: LIST_ITEMS,
  limit: 50,
  offset: 0,
  total: 3,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function invokeOperation(
  operation: 'list' | 'patch',
  signal?: AbortSignal,
): Promise<unknown> {
  if (operation === 'list') {
    return fetchAdminUsers({ accessToken: ACCESS_TOKEN, signal });
  }
  return updateAdminUserRole(CUSTOMER_ID, {
    accessToken: ACCESS_TOKEN,
    role: 'admin',
    signal,
  });
}

describe('super-administrator users API', () => {
  it('fetches the exact default page and maps the strict safe DTO', async () => {
    const stub = installFetchStub({ json: LIST_RESPONSE });

    await expect(fetchAdminUsers({ accessToken: ACCESS_TOKEN })).resolves.toEqual({
      items: [
        {
          createdAt: CREATED_AT,
          email: 'customer@example.test',
          id: CUSTOMER_ID,
          isActive: true,
          role: 'customer',
          updatedAt: UPDATED_AT,
        },
        {
          createdAt: CREATED_AT,
          email: 'admin@example.test',
          id: ADMIN_ID,
          isActive: false,
          role: 'admin',
          updatedAt: UPDATED_AT,
        },
        {
          createdAt: CREATED_AT,
          email: 'super-admin@example.test',
          id: SUPER_ADMIN_ID,
          isActive: true,
          role: 'super_admin',
          updatedAt: UPDATED_AT,
        },
      ],
      limit: 50,
      offset: 0,
      total: 3,
    });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: null,
      method: 'GET',
      url: '/api/v1/admin/users?limit=50&offset=0',
    });
    expect(stub.calls[0]?.headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(stub.calls[0]?.headers.get('Accept')).toBe('application/json');
    expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
    expect(stub.calls[0]?.url).not.toContain(ACCESS_TOKEN);
  });

  it('uses the exact caller-supplied bounded pagination', async () => {
    const stub = installFetchStub({
      json: { items: [], limit: 25, offset: 75, total: 75 },
    });

    await fetchAdminUsers({
      accessToken: ACCESS_TOKEN,
      limit: 25,
      offset: 75,
    });

    expect(stub.calls[0]?.url).toBe('/api/v1/admin/users?limit=25&offset=75');
  });

  it.each([
    { limit: 0, offset: 0 },
    { limit: 101, offset: 0 },
    { limit: 50.5, offset: 0 },
    { limit: 50, offset: -1 },
    { limit: 50, offset: Number.NaN },
    { limit: 50, offset: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects invalid pagination before fetch: %#', async ({ limit, offset }) => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    await expect(
      fetchAdminUsers({ accessToken: ACCESS_TOKEN, limit, offset }),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([401, 403, 422, 503])(
    'preserves safe typed list HTTP status %s',
    async (status) => {
      installFetchStub({ json: { detail: 'private backend detail' }, status });

      const error = await fetchAdminUsers({ accessToken: ACCESS_TOKEN }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(error).toMatchObject({ kind: 'http', status });
      expect(String(error)).not.toContain('private backend detail');
    },
  );

  it.each([
    { ...LIST_RESPONSE, password_hash: 'must-never-be-accepted' },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEMS[0], owner_id: CUSTOMER_ID }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEMS[0], id: 'not-a-uuid' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEMS[0], email: 'not-an-email' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEMS[0], role: 'operator' }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEMS[0], is_active: 1 }] },
    { ...LIST_RESPONSE, items: [{ ...LIST_ITEMS[0], created_at: '2026-08-12' }] },
    { ...LIST_RESPONSE, items: 'not-an-array' },
    { ...LIST_RESPONSE, total: '3' },
    { ...LIST_RESPONSE, limit: 25 },
    { ...LIST_RESPONSE, offset: 10 },
    { ...LIST_RESPONSE, items: LIST_ITEMS, total: 2 },
    { ...LIST_RESPONSE, items: LIST_ITEMS, limit: 2 },
  ])('rejects a malformed or expanded list DTO %#', async (payload) => {
    installFetchStub({ json: payload });

    const error = await fetchAdminUsers({ accessToken: ACCESS_TOKEN }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AdminApiRequestError);
    expect(error).toMatchObject({ kind: 'invalid-response', status: null });
  });

  it.each(['admin', 'customer'] as const)(
    'sends and maps the exact ordinary target role %s',
    async (role) => {
      const stub = installFetchStub({
        json: {
          email: 'target@example.test',
          id: CUSTOMER_ID,
          role,
          updated_at: UPDATED_AT,
        },
      });

      await expect(
        updateAdminUserRole(CUSTOMER_ID, {
          accessToken: ACCESS_TOKEN,
          role,
        }),
      ).resolves.toEqual({
        email: 'target@example.test',
        id: CUSTOMER_ID,
        role,
        updatedAt: UPDATED_AT,
      });
      expect(stub.calls).toHaveLength(1);
      expect(stub.calls[0]).toMatchObject({
        body: JSON.stringify({ role }),
        method: 'PATCH',
        url: `/api/v1/admin/users/${CUSTOMER_ID}/role`,
      });
      expect(stub.calls[0]?.headers.get('Authorization')).toBe(
        `Bearer ${ACCESS_TOKEN}`,
      );
      expect(stub.calls[0]?.headers.get('Content-Type')).toBe('application/json');
      expect(stub.calls[0]?.headers.has('X-Order-Access-Token')).toBe(false);
      expect(stub.calls[0]?.url).not.toContain(ACCESS_TOKEN);
    },
  );

  it('rejects super_admin as a target role before fetch', async () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);
    const invalidOptions: UpdateAdminUserRoleOptions = {
      accessToken: ACCESS_TOKEN,
      // @ts-expect-error The public mutation contract deliberately excludes super_admin.
      role: 'super_admin',
    };

    await expect(
      updateAdminUserRole(CUSTOMER_ID, invalidOptions),
    ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404, 409, 422, 503])(
    'preserves safe typed role-update HTTP status %s',
    async (status) => {
      installFetchStub({ json: { detail: 'private backend detail' }, status });

      const error = await updateAdminUserRole(CUSTOMER_ID, {
        accessToken: ACCESS_TOKEN,
        role: 'admin',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(error).toMatchObject({ kind: 'http', status });
      expect(String(error)).not.toContain('private backend detail');
    },
  );

  it.each([
    {
      email: 'target@example.test',
      id: CUSTOMER_ID,
      role: 'admin',
      updated_at: UPDATED_AT,
      is_active: true,
    },
    {
      email: 'target@example.test',
      id: ADMIN_ID,
      role: 'admin',
      updated_at: UPDATED_AT,
    },
    {
      email: 'target@example.test',
      id: CUSTOMER_ID,
      role: 'customer',
      updated_at: UPDATED_AT,
    },
    {
      email: 'target@example.test',
      id: CUSTOMER_ID,
      role: 'super_admin',
      updated_at: UPDATED_AT,
    },
    {
      email: 'target@example.test',
      id: CUSTOMER_ID,
      role: 'admin',
      updated_at: '2026-08-12',
    },
    {
      email: '',
      id: CUSTOMER_ID,
      role: 'admin',
      updated_at: UPDATED_AT,
    },
  ])(
    'rejects a malformed, expanded, or mismatched role-update DTO %#',
    async (payload) => {
      installFetchStub({ json: payload });

      const error = await updateAdminUserRole(CUSTOMER_ID, {
        accessToken: ACCESS_TOKEN,
        role: 'admin',
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(error).toMatchObject({ kind: 'invalid-response', status: null });
    },
  );

  it.each(['../orders', 'not-a-uuid', `${CUSTOMER_ID}/password`])(
    'rejects the non-UUID mutation target %s before fetch',
    async (userId) => {
      const fetchSpy = vi.fn<typeof fetch>();
      vi.stubGlobal('fetch', fetchSpy);

      await expect(
        updateAdminUserRole(userId, {
          accessToken: ACCESS_TOKEN,
          role: 'admin',
        }),
      ).rejects.toMatchObject({ kind: 'invalid-response', status: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    },
  );

  it.each(['list', 'patch'] as const)(
    'maps a rejected %s fetch to one network failure without retrying',
    async (operation) => {
      const stub = installFetchStub({ error: new TypeError('offline detail') });

      const error = await invokeOperation(operation).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(AdminApiRequestError);
      expect(error).toMatchObject({ kind: 'network', status: null });
      expect(String(error)).not.toContain('offline detail');
      expect(stub.calls).toHaveLength(1);
    },
  );

  it.each(['list', 'patch'] as const)(
    'uses the admin timeout for %s without retrying',
    async (operation) => {
      vi.useFakeTimers();
      const stub = installFetchStub({ waitForAbort: true });
      const request = invokeOperation(operation);
      const rejection = expect(request).rejects.toMatchObject({
        kind: 'timeout',
        status: null,
      });

      await vi.advanceTimersByTimeAsync(10_000);

      await rejection;
      expect(stub.calls).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['list', 'patch'] as const)(
    'forwards a caller abort for %s without retrying',
    async (operation) => {
      const stub = installFetchStub({ waitForAbort: true });
      const controller = new AbortController();
      const request = invokeOperation(operation, controller.signal);

      controller.abort();

      await expect(request).rejects.toMatchObject({
        kind: 'aborted',
        status: null,
      });
      expect(stub.calls).toHaveLength(1);
    },
  );

  it('exports no delete, password, active-state, or arbitrary mutation function', async () => {
    const exportedApi = await import('./adminUsersApi');

    expect(Object.keys(exportedApi).sort()).toEqual([
      'fetchAdminUsers',
      'updateAdminUserRole',
    ]);
  });
});
