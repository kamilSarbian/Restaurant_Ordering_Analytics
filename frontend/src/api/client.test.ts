/// <reference types="node" />

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApiUrl, requestJson, resolveApiRequestTimeoutMs } from './client';
import { installFetchStub } from '../test/fetchStub';

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('public API runtime configuration', () => {
  it.each(['development', 'test'])(
    'keeps an empty base URL same-origin in exact %s mode',
    (mode) => {
      vi.stubEnv('MODE', mode);
      vi.stubEnv('PROD', false);
      vi.stubEnv('VITE_API_BASE_URL', '');

      expect(buildApiUrl('/api/v1/menu')).toBe('/api/v1/menu');
    },
  );

  it('keeps development mode strict when Vite marks the build as production', () => {
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE_URL', '');

    expect(() => buildApiUrl('/api/v1/menu')).toThrow(
      'The public API base URL is not valid.',
    );
  });

  it('does not grant E2E behavior to a non-production E2E mode', () => {
    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_API_BASE_URL', '');

    expect(() => buildApiUrl('/api/v1/menu')).toThrow(
      'The public API base URL is not valid.',
    );
  });

  it.each([
    {
      baseUrl: 'https://api.example.test',
      expected: 'https://api.example.test/api/v1/menu',
    },
    {
      baseUrl: 'https://api.example.test/',
      expected: 'https://api.example.test/api/v1/menu',
    },
    {
      baseUrl: 'https://api.example.test:8443/',
      expected: 'https://api.example.test:8443/api/v1/menu',
    },
  ])('accepts an exact production HTTPS origin: $baseUrl', ({ baseUrl, expected }) => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE_URL', baseUrl);

    expect(buildApiUrl('/api/v1/menu')).toBe(expected);
  });

  it.each(
    ['development', 'test'].flatMap((mode) =>
      ['http://localhost:8000', 'http://127.0.0.1:8000', 'http://[::1]:8000'].map(
        (origin) => ({ mode, origin }),
      ),
    ),
  )('permits loopback HTTP for exact $mode mode: $origin', ({ mode, origin }) => {
    vi.stubEnv('MODE', mode);
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_API_BASE_URL', origin);

    expect(buildApiUrl('/api/v1/menu')).toBe(`${origin}/api/v1/menu`);
  });

  it.each([
    '',
    '   ',
    'http://api.example.test',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'http://[::1]:8000',
    'https://localhost:8000',
    'https://127.0.0.1:8000',
    'https://[::1]:8000',
    'https://user@api.example.test',
    'https://@api.example.test',
    'https://user:@api.example.test',
    'https://user:password@api.example.test',
    'https://api.example.test/prefix',
    'https://api.example.test/foo/..',
    'https://api.example.test/foo/%2e%2e',
    'https://api.example.test/.',
    'https://api.example.test//',
    'https://api.example.test///',
    'https://api.example.test?',
    'https://api.example.test#',
    'https://api.example.test?query=value',
    'https://api.example.test#fragment',
    'https://api.example.test:',
    'https://api.example.test\\foo\\..',
    '/api/v1/menu',
    '//api.example.test',
    'ftp://api.example.test',
    'not-a-url',
  ])('rejects an unsafe production API base URL: %s', (baseUrl) => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE_URL', baseUrl);

    expect(() => buildApiUrl('/api/v1/menu')).toThrow(
      'The public API base URL is not valid.',
    );
  });

  it('rejects non-loopback HTTP outside production', () => {
    vi.stubEnv('MODE', 'development');
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_API_BASE_URL', 'http://api.example.test');

    expect(() => buildApiUrl('/api/v1/menu')).toThrow(
      'The public API base URL is not valid.',
    );
  });

  it('permits same-origin API paths only for the exact E2E build mode', () => {
    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE_URL', '');

    expect(buildApiUrl('/api/v1/menu')).toBe('/api/v1/menu');
  });

  it.each([
    'http://api.example.test',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
    'https://api.example.test',
    'https://user:password@api.example.test',
    'https://api.example.test/path',
    'https://api.example.test?query=value',
    'https://api.example.test#fragment',
  ])('does not turn E2E mode into a general API-base bypass: %s', (baseUrl) => {
    vi.stubEnv('MODE', 'e2e');
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE_URL', baseUrl);

    expect(() => buildApiUrl('/api/v1/menu')).toThrow(
      'The public API base URL is not valid.',
    );
  });

  it.each([
    { mode: 'staging', production: true },
    { mode: 'staging', production: false },
    { mode: 'E2E', production: true },
    { mode: 'e2e ', production: true },
  ])(
    'keeps unknown mode $mode fail-closed when PROD=$production',
    ({ mode, production }) => {
      vi.stubEnv('MODE', mode);
      vi.stubEnv('PROD', production);
      vi.stubEnv('VITE_API_BASE_URL', '');

      expect(() => buildApiUrl('/api/v1/menu')).toThrow(
        'The public API base URL is not valid.',
      );
    },
  );

  it.each([
    { mode: 'staging', production: false },
    { mode: 'e2e', production: false },
    { mode: 'development', production: true },
    { mode: 'test', production: true },
  ])(
    'rejects loopback HTTP for nonlocal mode $mode with PROD=$production',
    ({ mode, production }) => {
      vi.stubEnv('MODE', mode);
      vi.stubEnv('PROD', production);
      vi.stubEnv('VITE_API_BASE_URL', 'http://127.0.0.1:8000');

      expect(() => buildApiUrl('/api/v1/menu')).toThrow(
        'The public API base URL is not valid.',
      );
    },
  );

  it('fails before fetch when production API base configuration is invalid', async () => {
    vi.stubEnv('MODE', 'production');
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_API_BASE_URL', '');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson('/api/v1/menu')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('uses the ten-second timeout when the build value is absent', () => {
    vi.stubEnv('VITE_API_TIMEOUT_MS', '');

    expect(resolveApiRequestTimeoutMs()).toBe(10_000);
  });

  it('accepts the bounded free-tier timeout', () => {
    vi.stubEnv('VITE_API_TIMEOUT_MS', '90000');

    expect(resolveApiRequestTimeoutMs()).toBe(90_000);
  });

  it.each(['0', '-1', '1.5', 'not-a-number', '90001'])(
    'rejects an invalid configured timeout: %s',
    (timeout) => {
      vi.stubEnv('VITE_API_TIMEOUT_MS', timeout);

      expect(() => resolveApiRequestTimeoutMs()).toThrow(
        'The API request timeout is not valid.',
      );
    },
  );

  it('lets an explicit bounded request timeout override build configuration', () => {
    vi.stubEnv('VITE_API_TIMEOUT_MS', 'not-a-number');

    expect(resolveApiRequestTimeoutMs(25)).toBe(25);
  });

  it('fails before fetch when the timeout configuration is invalid', async () => {
    vi.stubEnv('VITE_API_TIMEOUT_MS', '90001');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestJson('/api/v1/menu')).rejects.toMatchObject({
      kind: 'invalid-response',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('applies the free-tier timeout to an ordinary request', async () => {
    vi.stubEnv('MODE', 'test');
    vi.stubEnv('PROD', false);
    vi.stubEnv('VITE_API_TIMEOUT_MS', '90000');
    const timeoutSpy = vi.spyOn(window, 'setTimeout');
    installFetchStub({ json: { categories: [] } });

    await requestJson('/api/v1/menu');

    expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 90_000);
  });
});

describe('frontend container build-mode contract', () => {
  it('defaults Docker builds to an exact production or E2E mode allowlist', () => {
    const dockerfile = readFileSync(resolve(process.cwd(), 'Dockerfile'), 'utf8');
    const runtimeStageIndex = dockerfile.indexOf('\nFROM nginxinc/nginx-unprivileged:');

    expect(runtimeStageIndex).toBeGreaterThan(0);
    const runtimeStage = dockerfile.slice(runtimeStageIndex);
    expect(dockerfile).toContain('ARG VITE_BUILD_MODE=production');
    expect(dockerfile).toContain('production|e2e) ;;');
    expect(dockerfile).toContain('npm run build -- --mode "$VITE_BUILD_MODE"');
    expect(dockerfile).not.toMatch(/^ENV\s+VITE_BUILD_MODE=/mu);
    expect(runtimeStage).not.toContain('VITE_BUILD_MODE');
  });

  it('selects the literal E2E mode only in the frontend Compose overlay', () => {
    const composeOverlay = readFileSync(
      resolve(process.cwd(), '..', 'compose.e2e.yaml'),
      'utf8',
    );

    expect(composeOverlay).toMatch(
      / {2}frontend:\r?\n {4}build:\r?\n {6}args:\r?\n {8}VITE_BUILD_MODE: e2e\r?\n/u,
    );
    expect(composeOverlay.match(/VITE_BUILD_MODE:/gu)).toHaveLength(1);
    expect(composeOverlay).not.toContain('${VITE_BUILD_MODE');
    expect(composeOverlay).not.toContain('VITE_API_BASE_URL');
  });
});
