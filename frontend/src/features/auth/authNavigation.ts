export type AuthRole = 'admin' | 'customer' | 'super_admin';

const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const DEFAULT_AUTH_DESTINATION = '/account';
const STATIC_PUBLIC_PATHS = new Set(['/', '/account', '/cart', '/menu']);
const STATIC_ADMIN_PATHS = new Set([
  '/admin',
  '/admin/analytics',
  '/admin/exports',
  '/admin/menu',
  '/admin/orders',
]);
const STATIC_SUPER_ADMIN_PATHS = new Set(['/admin/users']);
const ORDER_SUFFIXES = new Set([
  'checkout',
  'checkout-cancelled',
  'payment-return',
  'status',
]);

function containsUnsafeSyntax(value: string): boolean {
  return (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    value.includes('?') ||
    value.includes('#') ||
    [...value].some((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
    })
  );
}

function isOrderPath(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.length === 4 &&
    parts[0] === '' &&
    parts[1] === 'orders' &&
    PUBLIC_ORDER_NUMBER_PATTERN.test(parts[2] ?? '') &&
    ORDER_SUFFIXES.has(parts[3] ?? '')
  );
}

function isAdminOrderDetailPath(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.length === 4 &&
    parts[0] === '' &&
    parts[1] === 'admin' &&
    parts[2] === 'orders' &&
    PUBLIC_ORDER_NUMBER_PATTERN.test(parts[3] ?? '')
  );
}

function isAccountOrderDetailPath(path: string): boolean {
  const parts = path.split('/');
  return (
    parts.length === 4 &&
    parts[0] === '' &&
    parts[1] === 'account' &&
    parts[2] === 'orders' &&
    PUBLIC_ORDER_NUMBER_PATTERN.test(parts[3] ?? '')
  );
}

/** Return a known Stage 16F continuation or null for unsafe input. */
export function parseSafeNext(value: string | null | undefined): string | null {
  if (value === null || value === undefined || containsUnsafeSyntax(value)) {
    return null;
  }
  if (
    STATIC_PUBLIC_PATHS.has(value) ||
    isAccountOrderDetailPath(value) ||
    isOrderPath(value)
  ) {
    return value;
  }
  if (
    STATIC_ADMIN_PATHS.has(value) ||
    STATIC_SUPER_ADMIN_PATHS.has(value) ||
    isAdminOrderDetailPath(value)
  ) {
    return value;
  }
  return null;
}

/** Return whether a safe continuation belongs to the administrator route tree. */
export function isAdminContinuation(path: string): boolean {
  return (
    STATIC_ADMIN_PATHS.has(path) ||
    STATIC_SUPER_ADMIN_PATHS.has(path) ||
    isAdminOrderDetailPath(path)
  );
}

/** Resolve the safe destination for one authenticated role. */
export function resolveAuthDestination(
  next: string | null | undefined,
  role: AuthRole,
): string {
  const safeNext = parseSafeNext(next);
  if (safeNext === null) {
    return DEFAULT_AUTH_DESTINATION;
  }
  if (STATIC_SUPER_ADMIN_PATHS.has(safeNext)) {
    if (role === 'super_admin') {
      return safeNext;
    }
    return role === 'admin' ? '/admin' : DEFAULT_AUTH_DESTINATION;
  }
  if (isAdminContinuation(safeNext) && role === 'customer') {
    return DEFAULT_AUTH_DESTINATION;
  }
  return safeNext;
}

/** Build a safe login continuation for a current administrator path. */
export function buildAdminLoginTarget(pathname: string): string {
  const safePath = parseSafeNext(pathname);
  const next = safePath !== null && isAdminContinuation(safePath) ? safePath : '/admin';
  return `/login?next=${encodeURIComponent(next)}`;
}
