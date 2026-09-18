export type ApiRequestErrorKind =
  'aborted' | 'http' | 'invalid-response' | 'network' | 'timeout';

interface RequestJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const MAX_REQUEST_TIMEOUT_MS = 90_000;
const PUBLIC_HTTPS_ORIGIN_PATTERN =
  /^https:\/\/(?:\[[^\]/?#@\\\s]+\]|[^:/?#@\\\s]+)(?::\d+)?\/?$/iu;

export class ApiRequestError extends Error {
  readonly kind: ApiRequestErrorKind;
  readonly status: number | null;

  constructor(
    kind: ApiRequestErrorKind,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'ApiRequestError';
    this.kind = kind;
    this.status = options.status ?? null;
  }
}

function invalidRuntimeConfiguration(
  message: string,
  cause?: unknown,
): ApiRequestError {
  return new ApiRequestError('invalid-response', message, { cause });
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function readApiBaseUrl(): string {
  const isLocalDevelopmentBuild =
    !import.meta.env.PROD &&
    (import.meta.env.MODE === 'development' || import.meta.env.MODE === 'test');
  const isE2eBuild = import.meta.env.PROD && import.meta.env.MODE === 'e2e';
  const requiresPublicHttpsBase = !isLocalDevelopmentBuild && !isE2eBuild;
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';
  if (configuredBaseUrl === '') {
    if (requiresPublicHttpsBase) {
      throw invalidRuntimeConfiguration('The public API base URL is not valid.');
    }
    return '';
  }
  if (isE2eBuild) {
    throw invalidRuntimeConfiguration('The public API base URL is not valid.');
  }
  if (requiresPublicHttpsBase && !PUBLIC_HTTPS_ORIGIN_PATTERN.test(configuredBaseUrl)) {
    throw invalidRuntimeConfiguration('The public API base URL is not valid.');
  }

  const normalizedBaseUrl = configuredBaseUrl.replace(/\/+$/, '');
  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(normalizedBaseUrl);
  } catch (error: unknown) {
    throw invalidRuntimeConfiguration('The public API base URL is not valid.', error);
  }

  const isLoopback = isLoopbackHostname(parsedBaseUrl.hostname);
  const isSupportedProtocol =
    (parsedBaseUrl.protocol === 'https:' && !(requiresPublicHttpsBase && isLoopback)) ||
    (isLocalDevelopmentBuild && parsedBaseUrl.protocol === 'http:' && isLoopback);
  if (
    !isSupportedProtocol ||
    parsedBaseUrl.username !== '' ||
    parsedBaseUrl.password !== '' ||
    parsedBaseUrl.pathname !== '/' ||
    parsedBaseUrl.search !== '' ||
    parsedBaseUrl.hash !== ''
  ) {
    throw invalidRuntimeConfiguration('The public API base URL is not valid.');
  }

  return parsedBaseUrl.origin;
}

/** Resolve one bounded request timeout from an override or the public build config. */
export function resolveApiRequestTimeoutMs(timeoutMs?: number): number {
  if (timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > MAX_REQUEST_TIMEOUT_MS
    ) {
      throw invalidRuntimeConfiguration('The API request timeout is not valid.');
    }
    return timeoutMs;
  }

  const configuredTimeout = import.meta.env.VITE_API_TIMEOUT_MS?.trim() ?? '';
  if (configuredTimeout === '') {
    return DEFAULT_REQUEST_TIMEOUT_MS;
  }
  if (!/^[1-9]\d*$/.test(configuredTimeout)) {
    throw invalidRuntimeConfiguration('The API request timeout is not valid.');
  }

  const parsedTimeout = Number(configuredTimeout);
  if (!Number.isSafeInteger(parsedTimeout) || parsedTimeout > MAX_REQUEST_TIMEOUT_MS) {
    throw invalidRuntimeConfiguration('The API request timeout is not valid.');
  }
  return parsedTimeout;
}

export function buildApiUrl(path: string): string {
  if (!path.startsWith('/api/')) {
    throw new ApiRequestError('invalid-response', 'The API request path is not valid.');
  }

  const baseUrl = readApiBaseUrl();
  if (baseUrl === '') {
    return path;
  }

  return `${baseUrl}${path}`;
}

export async function requestJson(
  path: string,
  options: RequestJsonOptions = {},
): Promise<unknown> {
  const timeoutMs = resolveApiRequestTimeoutMs(options.timeoutMs);
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
      headers: { Accept: 'application/json' },
      method: 'GET',
      signal: controller.signal,
    });
    responseReceived = true;

    if (!response.ok) {
      throw new ApiRequestError('http', 'The API request was not successful.', {
        status: response.status,
      });
    }

    return await response.json();
  } catch (error: unknown) {
    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (timeoutTriggered) {
      throw new ApiRequestError('timeout', 'The API request timed out.', {
        cause: error,
      });
    }
    if (controller.signal.aborted) {
      throw new ApiRequestError('aborted', 'The API request was aborted.', {
        cause: error,
      });
    }
    if (responseReceived) {
      throw new ApiRequestError(
        'invalid-response',
        'The API response was not valid JSON.',
        { cause: error },
      );
    }
    throw new ApiRequestError('network', 'The API request could not be completed.', {
      cause: error,
    });
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
