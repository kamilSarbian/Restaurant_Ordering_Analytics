import {
  buildAdminLoginTarget,
  parseSafeNext,
  resolveAuthDestination,
} from './authNavigation';

const ORDER_NUMBER = 'ROA-23456789ABCD';

describe('safe authentication navigation', () => {
  it.each([
    '/',
    '/account',
    `/account/orders/${ORDER_NUMBER}`,
    '/cart',
    '/menu',
    `/orders/${ORDER_NUMBER}/checkout`,
    `/orders/${ORDER_NUMBER}/payment-return`,
    `/orders/${ORDER_NUMBER}/checkout-cancelled`,
    `/orders/${ORDER_NUMBER}/status`,
  ])('accepts the current public route %s', (path) => {
    expect(parseSafeNext(path)).toBe(path);
  });

  it.each([
    '/admin',
    '/admin/orders',
    `/admin/orders/${ORDER_NUMBER}`,
    '/admin/menu',
    '/admin/analytics',
    '/admin/exports',
  ])('accepts the current administrator route %s', (path) => {
    expect(parseSafeNext(path)).toBe(path);
    expect(resolveAuthDestination(path, 'admin')).toBe(path);
    expect(resolveAuthDestination(path, 'super_admin')).toBe(path);
    expect(resolveAuthDestination(path, 'customer')).toBe('/account');
  });

  it('allows only a super administrator to continue to user management', () => {
    expect(parseSafeNext('/admin/users')).toBe('/admin/users');
    expect(resolveAuthDestination('/admin/users', 'super_admin')).toBe('/admin/users');
    expect(resolveAuthDestination('/admin/users', 'admin')).toBe('/admin');
    expect(resolveAuthDestination('/admin/users', 'customer')).toBe('/account');
  });

  it.each([
    null,
    '',
    '//example.invalid',
    'https://example.invalid',
    'http://example.invalid',
    '/\\example.invalid',
    '/%2f%2fexample.invalid',
    '/admin#section',
    '/admin?next=/admin',
    '/admin\u0000',
    '/login',
    '/register',
    '/account/orders/not-an-order',
    `/account/orders/${ORDER_NUMBER}/extra`,
    '/admin/login',
    '/admin/unknown',
    '/admin/../admin',
    '/orders/not-an-order/status',
  ])('rejects unsafe or unsupported continuation %s', (path) => {
    expect(parseSafeNext(path)).toBeNull();
    expect(resolveAuthDestination(path, 'admin')).toBe('/account');
  });

  it.each(['customer', 'admin', 'super_admin'] as const)(
    'uses the account destination for %s when no continuation is supplied',
    (role) => {
      expect(resolveAuthDestination(undefined, role)).toBe('/account');
    },
  );

  it('keeps the landing root as an explicit safe continuation', () => {
    expect(resolveAuthDestination('/', 'customer')).toBe('/');
  });

  it('encodes only a known current administrator continuation', () => {
    expect(buildAdminLoginTarget(`/admin/orders/${ORDER_NUMBER}`)).toBe(
      `/login?next=${encodeURIComponent(`/admin/orders/${ORDER_NUMBER}`)}`,
    );
    expect(buildAdminLoginTarget('/admin/unknown')).toBe('/login?next=%2Fadmin');
    expect(buildAdminLoginTarget('/admin/users')).toBe('/login?next=%2Fadmin%2Fusers');
  });
});
