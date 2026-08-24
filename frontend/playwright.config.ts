import process from 'node:process';

import { defineConfig } from '@playwright/test';

import {
  assertE2EInvariant,
  createOwnedRuntimeDirectory,
  registerSuccessfulRunCleanup,
  requireEnvironmentValue,
  resolveRuntimeRunId,
  runtimeOutputDirectory,
  validateLoopbackBaseUrl,
} from './e2e/support/runtime';

const baseURL = validateLoopbackBaseUrl(
  requireEnvironmentValue('E2E_BASE_URL', process.env),
);
const runId = resolveRuntimeRunId(process.env.E2E_RUN_ID);
process.env.E2E_RUN_ID = runId;
const outputDir = runtimeOutputDirectory(runId);

const isRunnerProcess =
  process.send === undefined && process.env.TEST_WORKER_INDEX === undefined;
if (isRunnerProcess) {
  const ownedOutputDirectory = createOwnedRuntimeDirectory(runId);
  assertE2EInvariant(ownedOutputDirectory.path === outputDir);
  registerSuccessfulRunCleanup(ownedOutputDirectory);
}

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  tsconfig: './tsconfig.e2e.json',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  reporter: 'list',
  outputDir,
  preserveOutput: 'failures-only',
  use: {
    baseURL,
    browserName: 'chromium',
    screenshot: 'only-on-failure',
    trace: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        browserName: 'chromium',
      },
    },
  ],
});
