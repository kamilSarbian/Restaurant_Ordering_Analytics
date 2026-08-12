import { AdminApiRequestError, adminRequestJson } from '../../api/adminApi';

const LOGIN_PATH = '/api/v1/admin/auth/login';
const ME_PATH = '/api/v1/admin/auth/me';

export interface AdminLoginResponse {
  accessToken: string;
  expiresIn: number;
}

export interface AdminProfile {
  email: string;
  isActive: true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function invalidAuthResponse(): AdminApiRequestError {
  return new AdminApiRequestError(
    'invalid-response',
    'The administrator authentication response was not valid.',
  );
}

/** Parse the exact administrator login success contract. */
export function parseAdminLoginResponse(value: unknown): AdminLoginResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['access_token', 'expires_in', 'token_type']) ||
    typeof value.access_token !== 'string' ||
    value.access_token.trim() === '' ||
    value.token_type !== 'bearer' ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) <= 0
  ) {
    throw invalidAuthResponse();
  }

  return {
    accessToken: value.access_token,
    expiresIn: value.expires_in as number,
  };
}

/** Parse the exact current-administrator success contract. */
export function parseAdminProfile(value: unknown): AdminProfile {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['email', 'is_active']) ||
    typeof value.email !== 'string' ||
    value.email.trim() !== value.email ||
    value.email.length === 0 ||
    !value.email.includes('@') ||
    value.is_active !== true
  ) {
    throw invalidAuthResponse();
  }

  return { email: value.email, isActive: true };
}

/** Authenticate one administrator without persisting the submitted password. */
export async function loginAdmin(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<AdminLoginResponse> {
  const payload = await adminRequestJson(LOGIN_PATH, {
    body: { email: email.trim().toLowerCase(), password },
    method: 'POST',
    signal,
  });
  return parseAdminLoginResponse(payload);
}

/** Validate one opaque administrator token against the current identity endpoint. */
export async function fetchCurrentAdmin(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AdminProfile> {
  const payload = await adminRequestJson(ME_PATH, { accessToken, signal });
  return parseAdminProfile(payload);
}
