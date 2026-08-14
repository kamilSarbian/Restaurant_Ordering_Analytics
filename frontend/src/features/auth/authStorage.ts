export const AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
export const LEGACY_AUTH_STORAGE_KEY = 'restaurant-ordering:admin-auth:v1';
export const AUTH_STORAGE_VERSION = 1;

interface StoredAuthToken {
  accessToken: string;
  version: 1;
}

let authMemoryToken: string | null | undefined;
let legacyMemoryToken: string | null | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function isAccessToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/\s/.test(value);
}

function parseStoredToken(serialized: string): string | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['accessToken', 'version']) ||
      value.version !== AUTH_STORAGE_VERSION ||
      !isAccessToken(value.accessToken)
    ) {
      return null;
    }
    return value.accessToken;
  } catch (error: unknown) {
    if (error instanceof SyntaxError) {
      return null;
    }
    return null;
  }
}

function resolveSessionStorage(storage?: Storage): Storage {
  return storage ?? window.sessionStorage;
}

function removeStorageKey(key: string, storage?: Storage): boolean {
  try {
    resolveSessionStorage(storage).removeItem(key);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}

/** Load the canonical opaque token, falling back to current-module memory. */
export function loadAuthToken(storage?: Storage): string | null {
  if (authMemoryToken !== undefined) {
    return authMemoryToken;
  }

  let serialized: string | null;
  try {
    serialized = resolveSessionStorage(storage).getItem(AUTH_STORAGE_KEY);
  } catch (error: unknown) {
    if (error instanceof Error) {
      authMemoryToken = null;
      return null;
    }
    authMemoryToken = null;
    return null;
  }

  if (serialized === null) {
    authMemoryToken = null;
    return null;
  }
  const accessToken = parseStoredToken(serialized);
  if (accessToken === null) {
    authMemoryToken = null;
    removeStorageKey(AUTH_STORAGE_KEY, storage);
    return null;
  }
  authMemoryToken = accessToken;
  return accessToken;
}

/** Persist one opaque canonical token in session storage and module memory. */
export function saveAuthToken(accessToken: string, storage?: Storage): boolean {
  if (!isAccessToken(accessToken)) {
    return false;
  }

  authMemoryToken = accessToken;
  const record: StoredAuthToken = { accessToken, version: AUTH_STORAGE_VERSION };
  try {
    resolveSessionStorage(storage).setItem(AUTH_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return true;
    }
    return true;
  }
}

/** Clear only the canonical auth token from session storage and module memory. */
export function clearAuthToken(storage?: Storage): boolean {
  authMemoryToken = null;
  return removeStorageKey(AUTH_STORAGE_KEY, storage);
}

/** Load a strictly shaped legacy admin token as a migration candidate only. */
export function loadLegacyAuthToken(storage?: Storage): string | null {
  if (legacyMemoryToken !== undefined) {
    return legacyMemoryToken;
  }

  let serialized: string | null;
  try {
    serialized = resolveSessionStorage(storage).getItem(LEGACY_AUTH_STORAGE_KEY);
  } catch (error: unknown) {
    if (error instanceof Error) {
      legacyMemoryToken = null;
      return null;
    }
    legacyMemoryToken = null;
    return null;
  }

  if (serialized === null) {
    legacyMemoryToken = null;
    return null;
  }
  const accessToken = parseStoredToken(serialized);
  if (accessToken === null) {
    legacyMemoryToken = null;
    removeStorageKey(LEGACY_AUTH_STORAGE_KEY, storage);
    return null;
  }
  legacyMemoryToken = accessToken;
  return accessToken;
}

/** Remove the legacy admin-auth migration candidate without touching other state. */
export function clearLegacyAuthToken(storage?: Storage): boolean {
  legacyMemoryToken = null;
  return removeStorageKey(LEGACY_AUTH_STORAGE_KEY, storage);
}

/** Reset module-only fallback state to isolate authentication storage tests. */
export function resetAuthMemoryForTests(): void {
  authMemoryToken = undefined;
  legacyMemoryToken = undefined;
}
