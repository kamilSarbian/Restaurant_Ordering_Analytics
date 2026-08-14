import { AdminApiRequestError, adminRequestJson } from '../../api/adminApi';

const ADMIN_USERS_PATH = '/api/v1/admin/users';
const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AWARE_TIMESTAMP_PATTERN = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const LIST_ITEM_KEYS = [
  'created_at',
  'email',
  'id',
  'is_active',
  'role',
  'updated_at',
] as const;
const LIST_RESPONSE_KEYS = ['items', 'limit', 'offset', 'total'] as const;
const ROLE_UPDATE_RESPONSE_KEYS = ['email', 'id', 'role', 'updated_at'] as const;

/** Enumerate every role that may appear in the super-administrator user list. */
export type AdminUserRole = 'admin' | 'customer' | 'super_admin';

/** Enumerate the only target roles accepted by the ordinary-role mutation endpoint. */
export type OrdinaryAdminUserRole = Exclude<AdminUserRole, 'super_admin'>;

/** Describe one safe registered-user identity returned to a super-administrator. */
export interface AdminUserListItem {
  readonly createdAt: string;
  readonly email: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly role: AdminUserRole;
  readonly updatedAt: string;
}

/** Describe one deterministic page of safe registered-user identities. */
export interface AdminUsersResponse {
  readonly items: AdminUserListItem[];
  readonly limit: number;
  readonly offset: number;
  readonly total: number;
}

/** Configure one super-administrator user-list request. */
export interface FetchAdminUsersOptions {
  readonly accessToken: string;
  readonly limit?: number;
  readonly offset?: number;
  readonly signal?: AbortSignal;
}

/** Configure one ordinary-role mutation request. */
export interface UpdateAdminUserRoleOptions {
  readonly accessToken: string;
  readonly role: OrdinaryAdminUserRole;
  readonly signal?: AbortSignal;
}

/** Describe the safe result of one ordinary-role mutation. */
export interface AdminUserRoleUpdateResponse {
  readonly email: string;
  readonly id: string;
  readonly role: OrdinaryAdminUserRole;
  readonly updatedAt: string;
}

function invalidAdminUsersResponse(cause?: unknown): AdminApiRequestError {
  return new AdminApiRequestError(
    'invalid-response',
    'The administrator users response did not match its contract.',
    { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  expectedKeys: T,
): value is Record<T[number], unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return (
    actualKeys.length === expectedKeys.length &&
    expectedKeys.every((key) => Object.hasOwn(value, key))
  );
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isEmail(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 320 &&
    value.trim() === value &&
    value.includes('@')
  );
}

function isAwareTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AWARE_TIMESTAMP_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isAdminUserRole(value: unknown): value is AdminUserRole {
  return value === 'customer' || value === 'admin' || value === 'super_admin';
}

function isOrdinaryAdminUserRole(value: unknown): value is OrdinaryAdminUserRole {
  return value === 'customer' || value === 'admin';
}

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function validatePagination(limit: number, offset: number): void {
  if (
    !isSafeIntegerInRange(limit, 1, 100) ||
    !isSafeIntegerInRange(offset, 0, Number.MAX_SAFE_INTEGER)
  ) {
    throw invalidAdminUsersResponse();
  }
}

function parseListItem(value: unknown): AdminUserListItem {
  if (
    !hasExactKeys(value, LIST_ITEM_KEYS) ||
    !isUuid(value.id) ||
    !isEmail(value.email) ||
    !isAdminUserRole(value.role) ||
    typeof value.is_active !== 'boolean' ||
    !isAwareTimestamp(value.created_at) ||
    !isAwareTimestamp(value.updated_at)
  ) {
    throw invalidAdminUsersResponse();
  }

  return {
    createdAt: value.created_at,
    email: value.email,
    id: value.id,
    isActive: value.is_active,
    role: value.role,
    updatedAt: value.updated_at,
  };
}

function parseListResponse(
  value: unknown,
  expectedLimit: number,
  expectedOffset: number,
): AdminUsersResponse {
  if (
    !hasExactKeys(value, LIST_RESPONSE_KEYS) ||
    !Array.isArray(value.items) ||
    !isSafeIntegerInRange(value.total, 0, Number.MAX_SAFE_INTEGER) ||
    value.limit !== expectedLimit ||
    value.offset !== expectedOffset
  ) {
    throw invalidAdminUsersResponse();
  }

  const items = value.items.map(parseListItem);
  if (
    items.length > expectedLimit ||
    (items.length > 0 && expectedOffset + items.length > value.total)
  ) {
    throw invalidAdminUsersResponse();
  }

  return {
    items,
    limit: expectedLimit,
    offset: expectedOffset,
    total: value.total,
  };
}

function parseRoleUpdateResponse(
  value: unknown,
  expectedUserId: string,
  expectedRole: OrdinaryAdminUserRole,
): AdminUserRoleUpdateResponse {
  if (
    !hasExactKeys(value, ROLE_UPDATE_RESPONSE_KEYS) ||
    !isUuid(value.id) ||
    value.id.toLowerCase() !== expectedUserId.toLowerCase() ||
    !isEmail(value.email) ||
    !isOrdinaryAdminUserRole(value.role) ||
    value.role !== expectedRole ||
    !isAwareTimestamp(value.updated_at)
  ) {
    throw invalidAdminUsersResponse();
  }

  return {
    email: value.email,
    id: value.id,
    role: value.role,
    updatedAt: value.updated_at,
  };
}

/** Fetch and strictly parse one page of safe registered-user identities. */
export async function fetchAdminUsers(
  options: FetchAdminUsersOptions,
): Promise<AdminUsersResponse> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? DEFAULT_OFFSET;
  validatePagination(limit, offset);

  const payload = await adminRequestJson(
    `${ADMIN_USERS_PATH}?limit=${limit}&offset=${offset}`,
    {
      accessToken: options.accessToken,
      signal: options.signal,
    },
  );
  return parseListResponse(payload, limit, offset);
}

/** Apply and strictly parse one customer-to-admin or admin-to-customer role change. */
export async function updateAdminUserRole(
  userId: string,
  options: UpdateAdminUserRoleOptions,
): Promise<AdminUserRoleUpdateResponse> {
  if (!isUuid(userId) || !isOrdinaryAdminUserRole(options.role)) {
    throw invalidAdminUsersResponse();
  }

  const payload = await adminRequestJson(
    `${ADMIN_USERS_PATH}/${encodeURIComponent(userId)}/role`,
    {
      accessToken: options.accessToken,
      body: { role: options.role },
      method: 'PATCH',
      signal: options.signal,
    },
  );
  return parseRoleUpdateResponse(payload, userId, options.role);
}
