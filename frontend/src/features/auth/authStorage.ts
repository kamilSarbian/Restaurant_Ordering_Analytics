export const AUTH_STORAGE_KEY = 'restaurant-ordering:auth:v1';
export const DEMO_SESSION_STORAGE_KEY = 'restaurant-ordering:demo-session:v1';
export const LEGACY_AUTH_STORAGE_KEY = 'restaurant-ordering:admin-auth:v1';
export const AUTH_STORAGE_VERSION = 1;

interface StoredAuthToken {
  accessToken: string;
  version: 1;
}

let authMemoryToken: string | null | undefined;
export type DemoSessionKind = 'admin' | 'customer';

let demoSessionMemory: DemoSessionKind | null | undefined;
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

function parseDemoSessionMarker(serialized: string): DemoSessionKind | null {
  try {
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['sessionKind', 'version']) ||
      value.version !== AUTH_STORAGE_VERSION
    ) {
      return null;
    }
    if (value.sessionKind === 'demo' || value.sessionKind === 'admin') {
      return 'admin';
    }
    return value.sessionKind === 'customer' ? 'customer' : null;
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

/** Load the typed presentation-only demo-session marker from current-tab storage. */
export function loadDemoSessionKind(storage?: Storage): DemoSessionKind | null {
  if (demoSessionMemory !== undefined) {
    return demoSessionMemory;
  }

  let serialized: string | null;
  try {
    serialized = resolveSessionStorage(storage).getItem(DEMO_SESSION_STORAGE_KEY);
  } catch (error: unknown) {
    if (error instanceof Error) {
      demoSessionMemory = null;
      return null;
    }
    demoSessionMemory = null;
    return null;
  }

  if (serialized === null) {
    demoSessionMemory = null;
    return null;
  }
  const kind = parseDemoSessionMarker(serialized);
  if (kind === null) {
    demoSessionMemory = null;
    removeStorageKey(DEMO_SESSION_STORAGE_KEY, storage);
    return null;
  }
  demoSessionMemory = kind;
  return kind;
}

/** Return whether any presentation-only demo marker is present. */
export function loadDemoSessionMarker(storage?: Storage): boolean {
  return loadDemoSessionKind(storage) !== null;
}

/** Persist a typed presentation-only demo-session marker in current-tab storage. */
export function saveDemoSessionMarker(
  kind: DemoSessionKind = 'admin',
  storage?: Storage,
): boolean {
  demoSessionMemory = kind;
  try {
    resolveSessionStorage(storage).setItem(
      DEMO_SESSION_STORAGE_KEY,
      JSON.stringify({ sessionKind: kind, version: AUTH_STORAGE_VERSION }),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return true;
    }
    return true;
  }
}

/** Clear the presentation-only demo-session marker without touching other state. */
export function clearDemoSessionMarker(storage?: Storage): boolean {
  demoSessionMemory = null;
  return removeStorageKey(DEMO_SESSION_STORAGE_KEY, storage);
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
  demoSessionMemory = undefined;
  legacyMemoryToken = undefined;
}
