export const ADMIN_AUTH_STORAGE_KEY = 'restaurant-ordering:admin-auth:v1';
export const ADMIN_AUTH_STORAGE_VERSION = 1;

interface StoredAdminAuth {
  accessToken: string;
  version: number;
}

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
  return typeof value === 'string' && value.trim().length > 0;
}

function resolveSessionStorage(storage?: Storage): Storage {
  return storage ?? window.sessionStorage;
}

/** Persist one opaque administrator token for the current browser tab. */
export function saveAdminAuth(accessToken: string, storage?: Storage): boolean {
  if (!isAccessToken(accessToken)) {
    return false;
  }

  const record: StoredAdminAuth = {
    accessToken,
    version: ADMIN_AUTH_STORAGE_VERSION,
  };
  try {
    resolveSessionStorage(storage).setItem(
      ADMIN_AUTH_STORAGE_KEY,
      JSON.stringify(record),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}

/** Load an exactly shaped administrator token record from session storage. */
export function loadAdminAuth(storage?: Storage): string | null {
  try {
    const serialized = resolveSessionStorage(storage).getItem(ADMIN_AUTH_STORAGE_KEY);
    if (serialized === null) {
      return null;
    }
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['accessToken', 'version']) ||
      value.version !== ADMIN_AUTH_STORAGE_VERSION ||
      !isAccessToken(value.accessToken)
    ) {
      return null;
    }
    return value.accessToken;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    return null;
  }
}

/** Remove only the administrator authentication record from session storage. */
export function clearAdminAuth(storage?: Storage): boolean {
  try {
    resolveSessionStorage(storage).removeItem(ADMIN_AUTH_STORAGE_KEY);
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}
