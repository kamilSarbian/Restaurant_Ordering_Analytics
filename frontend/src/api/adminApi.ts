import { ApiRequestError, type ApiRequestErrorKind, buildApiUrl } from './client';

const ADMIN_PATH_PREFIX = '/api/v1/admin/';
const DEFAULT_ADMIN_BLOB_TIMEOUT_MS = 30_000;
const DEFAULT_ADMIN_JSON_TIMEOUT_MS = 10_000;
const ADMIN_PATH_VALIDATION_ORIGIN = 'http://admin-api.local';

export type AdminHttpMethod = 'GET' | 'PATCH' | 'POST';

export interface AdminRequestJsonOptions {
  accessToken?: string;
  body?: unknown;
  method?: AdminHttpMethod;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AdminRequestBlobOptions {
  accessToken: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface AdminBlobResponse {
  readonly blob: Blob;
  readonly contentDisposition: string | null;
  readonly contentType: string | null;
  readonly status: number;
}

interface AdminApiRequestErrorOptions {
  cause?: unknown;
  retryAfterSeconds?: number;
  status?: number;
}

/** Represent a safe administrator transport failure without response payload data. */
export class AdminApiRequestError extends ApiRequestError {
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: ApiRequestErrorKind,
    message: string,
    options: AdminApiRequestErrorOptions = {},
  ) {
    super(kind, message, { cause: options.cause, status: options.status });
    this.name = 'AdminApiRequestError';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function validateAdminPath(path: string): void {
  let parsedPath: URL;
  try {
    parsedPath = new URL(path, ADMIN_PATH_VALIDATION_ORIGIN);
  } catch (error: unknown) {
    throw new AdminApiRequestError(
      'invalid-response',
      'The administrator API request path is not valid.',
      { cause: error },
    );
  }

  if (
    !path.startsWith('/') ||
    parsedPath.origin !== ADMIN_PATH_VALIDATION_ORIGIN ||
    parsedPath.hash !== '' ||
    !parsedPath.pathname.startsWith(ADMIN_PATH_PREFIX)
  ) {
    throw new AdminApiRequestError(
      'invalid-response',
      'The administrator API request path is not valid.',
    );
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 ? seconds : undefined;
}

function serializeBody(body: unknown): string {
  try {
    return JSON.stringify(body);
  } catch (error: unknown) {
    throw new AdminApiRequestError(
      'invalid-response',
      'The administrator API request body could not be serialized.',
      { cause: error },
    );
  }
}

function createAdminHeaders(accessToken: string | undefined, accept: string): Headers {
  const headers = new Headers({ Accept: accept });
  if (accessToken !== undefined) {
    if (accessToken.trim() === '') {
      throw new AdminApiRequestError(
        'invalid-response',
        'The administrator access token is not valid.',
      );
    }
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  return headers;
}

interface AdminRequestOptions {
  body?: string;
  headers: Headers;
  method: AdminHttpMethod;
  signal?: AbortSignal;
  timeoutMs: number;
}

async function executeAdminRequest<T>(
  path: string,
  options: AdminRequestOptions,
  readResponse: (response: Response) => Promise<T>,
  invalidResponseMessage: string,
): Promise<T> {
  validateAdminPath(path);

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
  }, options.timeoutMs);

  try {
    const response = await fetch(buildApiUrl(path), {
      body: options.body,
      cache: 'no-store',
      credentials: 'omit',
      headers: options.headers,
      method: options.method,
      signal: controller.signal,
    });
    responseReceived = true;

    if (!response.ok) {
      throw new AdminApiRequestError(
        'http',
        'The administrator API request was not successful.',
        {
          retryAfterSeconds: parseRetryAfter(response.headers.get('Retry-After')),
          status: response.status,
        },
      );
    }

    return await readResponse(response);
  } catch (error: unknown) {
    if (error instanceof AdminApiRequestError) {
      throw error;
    }
    if (timeoutTriggered) {
      throw new AdminApiRequestError(
        'timeout',
        'The administrator API request timed out.',
        { cause: error },
      );
    }
    if (controller.signal.aborted) {
      throw new AdminApiRequestError(
        'aborted',
        'The administrator API request was aborted.',
        { cause: error },
      );
    }
    if (responseReceived) {
      throw new AdminApiRequestError('invalid-response', invalidResponseMessage, {
        cause: error,
      });
    }
    throw new AdminApiRequestError(
      'network',
      'The administrator API request could not be completed.',
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Send one JSON administrator request through the isolated Bearer boundary. */
export async function adminRequestJson(
  path: string,
  options: AdminRequestJsonOptions = {},
): Promise<unknown> {
  const headers = createAdminHeaders(options.accessToken, 'application/json');

  let serializedBody: string | undefined;
  if (options.body !== undefined) {
    serializedBody = serializeBody(options.body);
    headers.set('Content-Type', 'application/json');
  }

  return executeAdminRequest(
    path,
    {
      body: serializedBody,
      headers,
      method: options.method ?? 'GET',
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_ADMIN_JSON_TIMEOUT_MS,
    },
    (response) => response.json(),
    'The administrator API response was not valid JSON.',
  );
}

/** Send one Blob administrator GET through the isolated Bearer boundary. */
export async function adminRequestBlob(
  path: string,
  options: AdminRequestBlobOptions,
): Promise<AdminBlobResponse> {
  const headers = createAdminHeaders(options.accessToken, 'text/csv');

  return executeAdminRequest(
    path,
    {
      headers,
      method: 'GET',
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? DEFAULT_ADMIN_BLOB_TIMEOUT_MS,
    },
    async (response) => ({
      blob: await response.blob(),
      contentDisposition: response.headers.get('Content-Disposition'),
      contentType: response.headers.get('Content-Type'),
      status: response.status,
    }),
    'The administrator API response body could not be read.',
  );
}
