import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, rmSync } from 'node:fs';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';

const SAFE_ENVIRONMENT_NAMES = new Set(['E2E_BASE_URL', 'E2E_RUN_ID']);
const RUN_NAME_PREFIX_PATTERN = /^[a-z][a-z0-9-]{2,39}$/u;
const RUN_ID_PATTERN = /^[a-f0-9]{16}$/u;
const LOOPBACK_URL_PATTERN =
  /^http:\/\/(?:127\.0\.0\.1|localhost):([1-9][0-9]{0,4})\/?$/iu;

export type E2ERuntimeErrorCode =
  | 'E2E_BASE_URL_INVALID'
  | 'E2E_ENVIRONMENT_NAME_INVALID'
  | 'E2E_ENVIRONMENT_VALUE_MISSING'
  | 'E2E_INVARIANT_FAILED'
  | 'E2E_RUN_ID_INVALID'
  | 'E2E_RUN_NAME_PREFIX_INVALID'
  | 'E2E_TEMP_CLEANUP_FAILED'
  | 'E2E_TEMP_SETUP_FAILED';

/** An OS-temp directory whose cleanup target cannot be supplied by a caller. */
export interface OwnedRuntimeDirectory {
  readonly path: string;
  cleanup: () => void;
}

/** Error with an allowlisted message that cannot echo runtime input. */
export class E2ERuntimeError extends Error {
  readonly code: E2ERuntimeErrorCode;

  constructor(code: E2ERuntimeErrorCode) {
    super(code);
    this.name = 'E2ERuntimeError';
    this.code = code;
  }
}

/** Return a required environment value without logging its contents. */
export function requireEnvironmentValue(
  name: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (!SAFE_ENVIRONMENT_NAMES.has(name)) {
    throw new E2ERuntimeError('E2E_ENVIRONMENT_NAME_INVALID');
  }

  const value = environment[name];
  if (value === undefined || value.trim().length === 0) {
    throw new E2ERuntimeError('E2E_ENVIRONMENT_VALUE_MISSING');
  }

  return value;
}

/** Validate and normalize an HTTP loopback origin for isolated browser tests. */
export function validateLoopbackBaseUrl(value: string): string {
  const match = LOOPBACK_URL_PATTERN.exec(value);
  if (match === null) {
    throw new E2ERuntimeError('E2E_BASE_URL_INVALID');
  }

  let candidate: URL;
  try {
    candidate = new URL(value);
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      throw new E2ERuntimeError('E2E_BASE_URL_INVALID');
    }
    throw error;
  }

  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new E2ERuntimeError('E2E_BASE_URL_INVALID');
  }

  return candidate.origin;
}

/** Create a collision-resistant name using a non-sensitive validated prefix. */
export function createUniqueRunName(prefix = 'roa-stage18-e2e'): string {
  if (!RUN_NAME_PREFIX_PATTERN.test(prefix)) {
    throw new E2ERuntimeError('E2E_RUN_NAME_PREFIX_INVALID');
  }

  const nonce = randomUUID().replaceAll('-', '').slice(0, 12);
  return `${prefix}-${nonce}`;
}

/** Resolve a caller-supplied safe run ID or generate a new cryptographic ID. */
export function resolveRuntimeRunId(value?: string): string {
  const runId = value ?? randomUUID().replaceAll('-', '').slice(0, 16);
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new E2ERuntimeError('E2E_RUN_ID_INVALID');
  }
  return runId;
}

/** Derive the stable Playwright output path for a validated run ID. */
export function runtimeOutputDirectory(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new E2ERuntimeError('E2E_RUN_ID_INVALID');
  }

  const temporaryRoot = resolve(tmpdir());
  const directory = resolve(temporaryRoot, `roa-stage18-playwright-${runId}`);
  if (dirname(directory) !== temporaryRoot) {
    throw new E2ERuntimeError('E2E_RUN_ID_INVALID');
  }
  return directory;
}

/** Fail with a fixed error code instead of rendering assertion input. */
export function assertE2EInvariant(
  condition: unknown,
  code: E2ERuntimeErrorCode = 'E2E_INVARIANT_FAILED',
): asserts condition {
  if (!condition) {
    throw new E2ERuntimeError(code);
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

/** Create the stable output directory owned by one validated Playwright run. */
export function createOwnedRuntimeDirectory(runId: string): OwnedRuntimeDirectory {
  const directory = runtimeOutputDirectory(runId);
  try {
    mkdirSync(directory, { mode: 0o700, recursive: false });
  } catch (error: unknown) {
    void error;
    throw new E2ERuntimeError('E2E_TEMP_SETUP_FAILED');
  }
  let cleaned = false;

  return Object.freeze({
    path: directory,
    cleanup: () => {
      if (cleaned) {
        return;
      }

      try {
        if (lstatSync(directory).isSymbolicLink()) {
          throw new E2ERuntimeError('E2E_TEMP_CLEANUP_FAILED');
        }
        rmSync(directory, {
          force: true,
          maxRetries: 3,
          recursive: true,
          retryDelay: 50,
        });
        cleaned = true;
      } catch (error: unknown) {
        if (isMissingPathError(error)) {
          cleaned = true;
          return;
        }
        if (error instanceof E2ERuntimeError) {
          throw error;
        }
        throw new E2ERuntimeError('E2E_TEMP_CLEANUP_FAILED');
      }
    },
  });
}

/** Remove owned Playwright output on success while retaining failure artifacts for diagnosis. */
export function registerSuccessfulRunCleanup(directory: OwnedRuntimeDirectory): void {
  process.once('exit', (exitCode) => {
    if (exitCode !== 0) {
      return;
    }

    try {
      directory.cleanup();
    } catch (error: unknown) {
      void error;
      process.stderr.write('E2E_TEMP_CLEANUP_FAILED\n');
      process.exitCode = 1;
    }
  });
}

/** Run an action in an owned OS temp directory and always remove that directory. */
export async function withTemporaryRuntimeDirectory<T>(
  action: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), `${createUniqueRunName()}-`));
  let outcome: { error: unknown; ok: false } | { ok: true; value: T };

  try {
    outcome = { ok: true, value: await action(directory) };
  } catch (error: unknown) {
    outcome = { error, ok: false };
  }

  try {
    if ((await lstat(directory)).isSymbolicLink()) {
      throw new E2ERuntimeError('E2E_TEMP_CLEANUP_FAILED');
    }
    await rm(directory, {
      force: true,
      maxRetries: 3,
      recursive: true,
      retryDelay: 50,
    });
  } catch (error: unknown) {
    if (!isMissingPathError(error)) {
      if (error instanceof E2ERuntimeError) {
        throw error;
      }
      throw new E2ERuntimeError('E2E_TEMP_CLEANUP_FAILED');
    }
  }

  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}
