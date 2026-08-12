import { vi } from 'vitest';

interface JsonResponseStep {
  body?: string;
  headers?: HeadersInit;
  json?: unknown;
  status?: number;
}

interface RejectedResponseStep {
  error: unknown;
}

interface AbortResponseStep {
  waitForAbort: true;
}

interface PromiseResponseStep {
  responsePromise: Promise<Response>;
}

export type FetchStep =
  JsonResponseStep | RejectedResponseStep | AbortResponseStep | PromiseResponseStep;

export interface FetchCall {
  body: string | null;
  headers: Headers;
  method: string;
  signal: AbortSignal | null;
  url: string;
}

export interface FetchStub {
  calls: FetchCall[];
  fetch: typeof fetch;
}

function createAbortError(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError');
}

function waitForAbort(signal: AbortSignal | null): Promise<Response> {
  if (signal === null) {
    return Promise.reject(new Error('Abort test response requires a signal'));
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError());
  }

  return new Promise<Response>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(createAbortError()), { once: true });
  });
}

export function installFetchStub(...queuedSteps: FetchStep[]): FetchStub {
  const calls: FetchCall[] = [];
  const steps = [...queuedSteps];
  const fetchImplementation: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : null;
    const signal = init?.signal ?? request?.signal ?? null;
    calls.push({
      body: typeof init?.body === 'string' ? init.body : null,
      headers: new Headers(init?.headers ?? request?.headers),
      method: init?.method ?? request?.method ?? 'GET',
      signal,
      url: request?.url ?? input.toString(),
    });

    const step = steps.shift();
    if (step === undefined) {
      throw new Error('No queued fetch response is available');
    }
    if ('error' in step) {
      throw step.error;
    }
    if ('waitForAbort' in step) {
      return waitForAbort(signal);
    }
    if ('responsePromise' in step) {
      return step.responsePromise;
    }

    const headers = new Headers(step.headers);
    let body = step.body;
    if ('json' in step) {
      body = JSON.stringify(step.json);
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
    }
    return new Response(body ?? null, {
      headers,
      status: step.status ?? 200,
    });
  };

  vi.stubGlobal('fetch', fetchImplementation);
  return { calls, fetch: fetchImplementation };
}
