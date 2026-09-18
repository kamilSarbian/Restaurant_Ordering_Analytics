import {
  ApiRequestError,
  type ApiRequestErrorKind,
  buildApiUrl,
  resolveApiRequestTimeoutMs,
} from './client';

const AUTH_ME_PATH = '/api/v1/auth/me';
const ACCOUNT_ORDERS_PATH = '/api/v1/account/orders';
const ACCOUNT_ORDER_DETAIL_PATTERN =
  /^\/api\/v1\/account\/orders\/ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const PATH_VALIDATION_ORIGIN = 'http://authenticated-api.local';

interface AuthenticatedApiRequestErrorOptions {
  cause?: unknown;
  retryAfterSeconds?: number;
  status?: number;
}

export interface AuthenticatedRequestOptions {
  accessToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Represent a safe protected-API failure without exposing response payload data. */
export class AuthenticatedApiRequestError extends ApiRequestError {
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: ApiRequestErrorKind,
    message: string,
    options: AuthenticatedApiRequestErrorOptions = {},
  ) {
    super(kind, message, { cause: options.cause, status: options.status });
    this.name = 'AuthenticatedApiRequestError';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function invalidRequest(
  message: string,
  cause?: unknown,
): AuthenticatedApiRequestError {
  return new AuthenticatedApiRequestError('invalid-response', message, { cause });
}

function isAllowedAccountOrdersPath(path: string, parsed: URL): boolean {
  if (path === ACCOUNT_ORDERS_PATH) {
    return true;
  }
  if (ACCOUNT_ORDER_DETAIL_PATTERN.test(path)) {
    return true;
  }
  if (
    !path.startsWith(`${ACCOUNT_ORDERS_PATH}?`) ||
    parsed.pathname !== ACCOUNT_ORDERS_PATH
  ) {
    return false;
  }

  const segments = path.slice(ACCOUNT_ORDERS_PATH.length + 1).split('&');
  const seenKeys = new Set<string>();
  for (const segment of segments) {
    const match = /^(limit|offset)=(\d+)$/.exec(segment);
    if (match === null || seenKeys.has(match[1]!)) {
      return false;
    }
    const key = match[1]!;
    const value = Number(match[2]);
    if (
      !Number.isSafeInteger(value) ||
      (key === 'limit' && (value < 1 || value > 100)) ||
      (key === 'offset' && value < 0)
    ) {
      return false;
    }
    seenKeys.add(key);
  }
  return segments.length > 0 && seenKeys.size === segments.length;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f);
  });
}

function validateAuthenticatedPath(path: string): void {
  if (
    path === '' ||
    !path.startsWith('/') ||
    path.startsWith('//') ||
    path.includes('\\') ||
    path.includes('%') ||
    containsControlCharacter(path)
  ) {
    throw invalidRequest('The authenticated API request path is not valid.');
  }

  let parsed: URL;
  try {
    parsed = new URL(path, PATH_VALIDATION_ORIGIN);
  } catch (error: unknown) {
    throw invalidRequest('The authenticated API request path is not valid.', error);
  }

  const allowed =
    path === AUTH_ME_PATH ||
    (parsed.hash === '' && isAllowedAccountOrdersPath(path, parsed));
  if (parsed.origin !== PATH_VALIDATION_ORIGIN || parsed.hash !== '' || !allowed) {
    throw invalidRequest('The authenticated API request path is not valid.');
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function createBearerHeaders(accessToken: string): Headers {
  if (accessToken.trim() === '' || /\s/.test(accessToken)) {
    throw invalidRequest('The authenticated API access token is not valid.');
  }
  return new Headers({
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
  });
}

/** Send one explicit-Bearer JSON GET to the strict canonical protected allowlist. */
export async function authenticatedRequestJson(
  path: string,
  options: AuthenticatedRequestOptions,
): Promise<unknown> {
  validateAuthenticatedPath(path);
  const headers = createBearerHeaders(options.accessToken);
  let timeoutMs: number;
  try {
    timeoutMs = resolveApiRequestTimeoutMs(options.timeoutMs);
  } catch (error: unknown) {
    throw invalidRequest('The authenticated API timeout is not valid.', error);
  }

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
    const response = await fetch(buildApiUrl(path), {
      cache: 'no-store',
      credentials: 'omit',
      headers,
      method: 'GET',
      signal: controller.signal,
    });
    responseReceived = true;

    if (!response.ok) {
      throw new AuthenticatedApiRequestError(
        'http',
        'The authenticated API request was not successful.',
        {
          retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
          status: response.status,
        },
      );
    }

    return await response.json();
  } catch (error: unknown) {
    if (error instanceof AuthenticatedApiRequestError) {
      throw error;
    }
    if (error instanceof ApiRequestError) {
      throw invalidRequest('The authenticated API configuration is not valid.', error);
    }
    if (timeoutTriggered) {
      throw new AuthenticatedApiRequestError(
        'timeout',
        'The authenticated API request timed out.',
        { cause: error },
      );
    }
    if (controller.signal.aborted) {
      throw new AuthenticatedApiRequestError(
        'aborted',
        'The authenticated API request was aborted.',
        { cause: error },
      );
    }
    if (responseReceived) {
      throw new AuthenticatedApiRequestError(
        'invalid-response',
        'The authenticated API response was not valid JSON.',
        { cause: error },
      );
    }
    throw new AuthenticatedApiRequestError(
      'network',
      'The authenticated API request could not be completed.',
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
