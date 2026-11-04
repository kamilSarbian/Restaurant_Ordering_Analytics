import {
  AuthenticatedApiRequestError,
  authenticatedRequestJson,
} from '../../api/authenticatedApi';
import {
  ApiRequestError,
  buildApiUrl,
  resolveApiRequestTimeoutMs,
} from '../../api/client';

const LOGIN_PATH = '/api/v1/auth/login';
const REGISTER_PATH = '/api/v1/auth/register';
const DEMO_SESSION_PATH = '/api/v1/auth/demo-session';
const ME_PATH = '/api/v1/auth/me';
const TOKEN_RESPONSE_KEYS = ['access_token', 'expires_in', 'token_type'];
const USER_RESPONSE_KEYS = ['email', 'id', 'is_active', 'role'];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export { AuthenticatedApiRequestError as AuthApiRequestError };

export type AuthRole = 'admin' | 'customer' | 'super_admin';

export interface AuthUser {
  readonly email: string;
  readonly id: string;
  readonly isActive: boolean;
  readonly role: AuthRole;
}

export interface AuthTokenResponse {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly tokenType: 'bearer';
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

function isAuthRole(value: unknown): value is AuthRole {
  return value === 'customer' || value === 'admin' || value === 'super_admin';
}

function invalidAuthResponse(cause?: unknown): AuthenticatedApiRequestError {
  return new AuthenticatedApiRequestError(
    'invalid-response',
    'The authentication response did not match its contract.',
    { cause },
  );
}

/** Parse the exact canonical login or registration token response. */
export function parseAuthTokenResponse(value: unknown): AuthTokenResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, TOKEN_RESPONSE_KEYS) ||
    typeof value.access_token !== 'string' ||
    value.access_token.trim() === '' ||
    /\s/.test(value.access_token) ||
    value.token_type !== 'bearer' ||
    !Number.isSafeInteger(value.expires_in) ||
    (value.expires_in as number) <= 0
  ) {
    throw invalidAuthResponse();
  }

  return {
    accessToken: value.access_token,
    expiresIn: value.expires_in as number,
    tokenType: 'bearer',
  };
}

/** Parse the exact database-authoritative current-user response. */
export function parseAuthUser(value: unknown): AuthUser {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, USER_RESPONSE_KEYS) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.email !== 'string' ||
    value.email.length === 0 ||
    value.email.trim() !== value.email ||
    !value.email.includes('@') ||
    !isAuthRole(value.role) ||
    value.is_active !== true
  ) {
    throw invalidAuthResponse();
  }

  return {
    email: value.email,
    id: value.id,
    isActive: true,
    role: value.role,
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

async function requestAuthToken(
  path: typeof DEMO_SESSION_PATH | typeof LOGIN_PATH | typeof REGISTER_PATH,
  options: { body?: string; signal?: AbortSignal },
): Promise<AuthTokenResponse> {
  const timeoutMs = resolveApiRequestTimeoutMs();
  const controller = new AbortController();
  let timeoutTriggered = false;
  let responseReceived = false;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) {
    forwardAbort();
  } else {
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
  }

  const timeoutId = window.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, timeoutMs);

  try {
    const headers = new Headers({ Accept: 'application/json' });
    if (options.body !== undefined) {
      headers.set('Content-Type', 'application/json');
    }
    const response = await fetch(buildApiUrl(path), {
      body: options.body,
      cache: 'no-store',
      credentials: 'omit',
      headers,
      method: 'POST',
      signal: controller.signal,
    });
    responseReceived = true;

    if (!response.ok) {
      throw new AuthenticatedApiRequestError(
        'http',
        'The authentication request was not successful.',
        {
          retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
          status: response.status,
        },
      );
    }

    return parseAuthTokenResponse(await response.json());
  } catch (error: unknown) {
    if (error instanceof AuthenticatedApiRequestError) {
      throw error;
    }
    if (error instanceof ApiRequestError) {
      throw invalidAuthResponse(error);
    }
    if (timeoutTriggered) {
      throw new AuthenticatedApiRequestError(
        'timeout',
        'The authentication request timed out.',
        { cause: error },
      );
    }
    if (controller.signal.aborted) {
      throw new AuthenticatedApiRequestError(
        'aborted',
        'The authentication request was aborted.',
        { cause: error },
      );
    }
    if (responseReceived) {
      throw invalidAuthResponse(error);
    }
    throw new AuthenticatedApiRequestError(
      'network',
      'The authentication request could not be completed.',
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Authenticate any active registered role without persisting submitted credentials. */
export function loginUser(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<AuthTokenResponse> {
  return requestAuthToken(LOGIN_PATH, {
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    signal,
  });
}

/** Register one customer account without persisting submitted credentials. */
export function registerUser(
  email: string,
  password: string,
  signal?: AbortSignal,
): Promise<AuthTokenResponse> {
  return requestAuthToken(REGISTER_PATH, {
    body: JSON.stringify({ email: email.trim().toLowerCase(), password }),
    signal,
  });
}

/** Request one canonical demo-administrator token without credentials or a body. */
export function startDemoSession(signal?: AbortSignal): Promise<AuthTokenResponse> {
  return requestAuthToken(DEMO_SESSION_PATH, { signal });
}

/** Fetch the current database-authoritative user through canonical Bearer auth. */
export async function fetchCurrentUser(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AuthUser> {
  const response = await authenticatedRequestJson(ME_PATH, { accessToken, signal });
  return parseAuthUser(response);
}
