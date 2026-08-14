import { afterEach, vi } from 'vitest';

import {
  AUTH_STORAGE_KEY,
  AUTH_STORAGE_VERSION,
  LEGACY_AUTH_STORAGE_KEY,
  clearAuthToken,
  clearLegacyAuthToken,
  loadAuthToken,
  loadLegacyAuthToken,
  resetAuthMemoryForTests,
  saveAuthToken,
} from './authStorage';

const SYNTHETIC_TOKEN = 'synthetic-canonical-token';
const LEGACY_SYNTHETIC_TOKEN = 'synthetic-legacy-token';

function securityErrorStorage(): Storage {
  return {
    clear: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
    getItem: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
    key: () => null,
    get length() {
      return 0;
    },
    removeItem: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
    setItem: () => {
      throw new DOMException('Blocked', 'SecurityError');
    },
  };
}

function writeFailureStorage(): Storage {
  const values = new Map<string, string>();
  return {
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
    removeItem: (key) => values.delete(key),
    setItem: () => {
      throw new DOMException('Blocked', 'QuotaExceededError');
    },
  };
}

afterEach(() => {
  resetAuthMemoryForTests();
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('canonical authentication storage', () => {
  it('returns null when neither persisted nor memory state exists', () => {
    expect(loadAuthToken()).toBeNull();
    expect(loadLegacyAuthToken()).toBeNull();
  });

  it('writes and reads the exact canonical versioned record', () => {
    expect(saveAuthToken(SYNTHETIC_TOKEN)).toBe(true);

    expect(loadAuthToken()).toBe(SYNTHETIC_TOKEN);
    expect(JSON.parse(sessionStorage.getItem(AUTH_STORAGE_KEY) ?? '')).toEqual({
      accessToken: SYNTHETIC_TOKEN,
      version: AUTH_STORAGE_VERSION,
    });
    expect(sessionStorage).toHaveLength(1);
  });

  it('clears the canonical record while preserving unrelated state', () => {
    saveAuthToken(SYNTHETIC_TOKEN);
    sessionStorage.setItem('restaurant-ordering:cart:v1', 'preserved');

    expect(clearAuthToken()).toBe(true);
    expect(loadAuthToken()).toBeNull();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe('preserved');
  });

  it.each([
    '{broken',
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 2 }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ accessToken: '', version: 1 }),
    JSON.stringify({ accessToken: ' token ', version: 1 }),
    JSON.stringify({
      accessToken: SYNTHETIC_TOKEN,
      email: 'user@example.test',
      version: 1,
    }),
    JSON.stringify(['not', 'a', 'record']),
  ])('clears malformed canonical storage %s', (serialized) => {
    sessionStorage.setItem(AUTH_STORAGE_KEY, serialized);

    expect(loadAuthToken()).toBeNull();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
  });

  it('rejects an empty token without changing current state', () => {
    saveAuthToken(SYNTHETIC_TOKEN);

    expect(saveAuthToken('   ')).toBe(false);
    expect(loadAuthToken()).toBe(SYNTHETIC_TOKEN);
  });

  it('uses memory after sessionStorage write failure', () => {
    const storage = writeFailureStorage();

    expect(saveAuthToken(SYNTHETIC_TOKEN, storage)).toBe(true);
    expect(loadAuthToken(storage)).toBe(SYNTHETIC_TOKEN);
    expect(storage).toHaveLength(0);
  });

  it('keeps a newly saved memory token authoritative over an old persisted record', () => {
    const getItem = vi.fn(() =>
      JSON.stringify({ accessToken: 'old-token', version: 1 }),
    );
    const storage = {
      ...writeFailureStorage(),
      getItem,
    };

    expect(saveAuthToken(SYNTHETIC_TOKEN, storage)).toBe(true);
    expect(loadAuthToken(storage)).toBe(SYNTHETIC_TOKEN);
    expect(getItem).not.toHaveBeenCalled();
  });

  it('uses previously established memory when sessionStorage read fails', () => {
    saveAuthToken(SYNTHETIC_TOKEN);

    expect(loadAuthToken(securityErrorStorage())).toBe(SYNTHETIC_TOKEN);
  });

  it('returns null without throwing when the first sessionStorage read fails', () => {
    expect(loadAuthToken(securityErrorStorage())).toBeNull();
    expect(loadLegacyAuthToken(securityErrorStorage())).toBeNull();
  });

  it('clears memory even when sessionStorage removal fails', () => {
    saveAuthToken(SYNTHETIC_TOKEN);
    const blockedStorage = securityErrorStorage();

    expect(clearAuthToken(blockedStorage)).toBe(false);
    expect(loadAuthToken(blockedStorage)).toBeNull();
  });

  it('does not resurrect the current-runtime token after failed removal', () => {
    const staleRecordStorage: Storage = {
      ...writeFailureStorage(),
      getItem: () => JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 1 }),
      removeItem: () => {
        throw new DOMException('Blocked', 'SecurityError');
      },
    };
    saveAuthToken(SYNTHETIC_TOKEN);

    expect(clearAuthToken(staleRecordStorage)).toBe(false);
    expect(loadAuthToken(staleRecordStorage)).toBeNull();
  });

  it('loads and removes one valid legacy migration candidate', () => {
    sessionStorage.setItem(
      LEGACY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: LEGACY_SYNTHETIC_TOKEN, version: 1 }),
    );

    expect(loadLegacyAuthToken()).toBe(LEGACY_SYNTHETIC_TOKEN);
    expect(clearLegacyAuthToken()).toBe(true);
    expect(loadLegacyAuthToken()).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
  });

  it.each([
    '{broken',
    JSON.stringify({ accessToken: '', version: 1 }),
    JSON.stringify({ accessToken: LEGACY_SYNTHETIC_TOKEN, version: 2 }),
  ])('clears malformed legacy candidate %s', (serialized) => {
    sessionStorage.setItem(LEGACY_AUTH_STORAGE_KEY, serialized);

    expect(loadLegacyAuthToken()).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
  });

  it('keeps canonical and legacy identities separate for canonical priority', () => {
    saveAuthToken(SYNTHETIC_TOKEN);
    sessionStorage.setItem(
      LEGACY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: LEGACY_SYNTHETIC_TOKEN, version: 1 }),
    );

    expect(loadAuthToken()).toBe(SYNTHETIC_TOKEN);
    expect(loadLegacyAuthToken()).toBe(LEGACY_SYNTHETIC_TOKEN);
  });

  it('never reads, writes, or removes localStorage', () => {
    const localGet = vi.spyOn(window.localStorage, 'getItem');
    const localSet = vi.spyOn(window.localStorage, 'setItem');
    const localRemove = vi.spyOn(window.localStorage, 'removeItem');

    saveAuthToken(SYNTHETIC_TOKEN);
    loadAuthToken();
    clearAuthToken();
    loadLegacyAuthToken();
    clearLegacyAuthToken();

    expect(localGet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(localRemove).not.toHaveBeenCalled();
  });

  it('persists no identity profile, role, password, expiry, or guest data', () => {
    saveAuthToken(SYNTHETIC_TOKEN);

    const serialized = sessionStorage.getItem(AUTH_STORAGE_KEY) ?? '';
    expect(serialized).not.toMatch(/email|role|password|expir|guest/i);
  });
});
