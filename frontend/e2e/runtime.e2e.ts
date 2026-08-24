import { access, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { URL } from 'node:url';

import { expect, test } from '@playwright/test';

import {
  createUniqueRunName,
  E2ERuntimeError,
  requireEnvironmentValue,
  resolveRuntimeRunId,
  runtimeOutputDirectory,
  validateLoopbackBaseUrl,
  withTemporaryRuntimeDirectory,
} from './support/runtime';

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

test('uses the locked Chromium and artifact policy', async ({
  browserName,
}, testInfo) => {
  expect(browserName).toBe('chromium');
  expect(testInfo.project.name).toBe('chromium');
  expect(testInfo.config.workers).toBe(1);
  expect(testInfo.config.reporter.map(([name]) => name)).toEqual(['list']);
  expect(testInfo.project.retries).toBe(0);
  expect(testInfo.config.preserveOutput).toBe('failures-only');
  expect(testInfo.project.use.screenshot).toBe('only-on-failure');
  expect(testInfo.project.use.trace).toBe('off');
  expect(testInfo.project.use.video).toBe('off');
  expect(testInfo.project.use.storageState).toBeUndefined();
  expect(testInfo.project.use.contextOptions?.recordHar).toBeUndefined();
  expect(testInfo.attachments).toHaveLength(0);

  const runId = requireEnvironmentValue('E2E_RUN_ID');
  expect(testInfo.project.outputDir).toBe(runtimeOutputDirectory(runId));
});

test('rejects non-loopback base URLs without echoing input', () => {
  const sensitiveSentinel = 'sensitive-value.example.invalid';

  expect(() => validateLoopbackBaseUrl(`http://${sensitiveSentinel}:8443`)).toThrow(
    E2ERuntimeError,
  );

  try {
    validateLoopbackBaseUrl(`http://${sensitiveSentinel}:8443`);
  } catch (error: unknown) {
    expect(String(error)).toBe('E2ERuntimeError: E2E_BASE_URL_INVALID');
    expect(String(error)).not.toContain(sensitiveSentinel);
  }

  expect(() => validateLoopbackBaseUrl('http://127.1:41789')).toThrow(
    'E2E_BASE_URL_INVALID',
  );
  expect(() => validateLoopbackBaseUrl('https://127.0.0.1:41789')).toThrow(
    'E2E_BASE_URL_INVALID',
  );
  expect(validateLoopbackBaseUrl('http://127.0.0.1:41789/')).toBe(
    'http://127.0.0.1:41789',
  );
  expect(validateLoopbackBaseUrl('http://localhost:41789')).toBe(
    'http://localhost:41789',
  );
});

test('requires non-empty environment values and creates unique safe names', () => {
  expect(() => requireEnvironmentValue('E2E_RUN_ID', {})).toThrow(
    'E2E_ENVIRONMENT_VALUE_MISSING',
  );

  const first = createUniqueRunName();
  const second = createUniqueRunName();
  expect(first).not.toBe(second);
  expect(first).toMatch(/^roa-stage18-e2e-[a-f0-9]{12}$/u);
  expect(second).toMatch(/^roa-stage18-e2e-[a-f0-9]{12}$/u);
  expect(resolveRuntimeRunId()).toMatch(/^[a-f0-9]{16}$/u);
  expect(() => resolveRuntimeRunId('unsafe-run-id')).toThrow('E2E_RUN_ID_INVALID');
});

test('loads a controlled loopback page in Chromium', async ({ page }) => {
  await page.route('**/*', async (route) => {
    await route.fulfill({
      body: '<!doctype html><html><body><main><h1>Playwright runtime ready</h1></main></body></html>',
      contentType: 'text/html',
      status: 200,
    });
  });

  await page.goto('/');

  expect(new URL(page.url()).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/u);
  await expect(
    page.getByRole('heading', { name: 'Playwright runtime ready' }),
  ).toBeVisible();
});

test('removes its owned runtime directory after success', async () => {
  let ownedDirectory = '';

  await withTemporaryRuntimeDirectory(async (directory) => {
    ownedDirectory = directory;
    expect(basename(directory)).toMatch(/^roa-stage18-e2e-[a-f0-9]{12}-/u);
    await writeFile(`${directory}/smoke.txt`, 'runtime-only\n', { encoding: 'utf8' });
    expect(await pathExists(directory)).toBe(true);
  });

  expect(await pathExists(ownedDirectory)).toBe(false);
});
