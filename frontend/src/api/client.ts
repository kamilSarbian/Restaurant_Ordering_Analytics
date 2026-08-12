export type ApiRequestErrorKind =
  'aborted' | 'http' | 'invalid-response' | 'network' | 'timeout';

interface RequestJsonOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

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

function readApiBaseUrl(): string {
  const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim() ?? '';
  return configuredBaseUrl.replace(/\/+$/, '');
}

export function buildApiUrl(path: string): string {
  if (!path.startsWith('/api/')) {
    throw new ApiRequestError('invalid-response', 'The API request path is not valid.');
  }

  const baseUrl = readApiBaseUrl();
  if (baseUrl === '') {
    return path;
  }

  let parsedBaseUrl: URL;
  try {
    parsedBaseUrl = new URL(baseUrl);
  } catch (error: unknown) {
    throw new ApiRequestError(
      'invalid-response',
      'The public API base URL is not valid.',
      { cause: error },
    );
  }
  if (!['http:', 'https:'].includes(parsedBaseUrl.protocol)) {
    throw new ApiRequestError(
      'invalid-response',
      'The public API base URL protocol is not supported.',
    );
  }
  return `${baseUrl}${path}`;
}

export async function requestJson(
  path: string,
  options: RequestJsonOptions = {},
): Promise<unknown> {
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
  }, options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);

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
