import { afterEach, vi } from 'vitest';

import {
  ADMIN_AUTH_STORAGE_KEY,
  ADMIN_AUTH_STORAGE_VERSION,
  clearAdminAuth,
  loadAdminAuth,
  saveAdminAuth,
} from './adminAuthStorage';

const SYNTHETIC_TOKEN = 'test-admin-token';

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

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('administrator authentication storage', () => {
  it('writes and reads the exact versioned record under the exact key', () => {
    expect(saveAdminAuth(SYNTHETIC_TOKEN)).toBe(true);
    expect(loadAdminAuth()).toBe(SYNTHETIC_TOKEN);
    expect(JSON.parse(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY) ?? '')).toEqual({
      accessToken: SYNTHETIC_TOKEN,
      version: ADMIN_AUTH_STORAGE_VERSION,
    });
    expect(sessionStorage).toHaveLength(1);
  });

  it.each([
    '{broken',
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, version: 2 }),
    JSON.stringify({ accessToken: '', version: 1 }),
    JSON.stringify({ version: 1 }),
    JSON.stringify({ accessToken: SYNTHETIC_TOKEN, profile: {}, version: 1 }),
    JSON.stringify(['not', 'a', 'record']),
  ])('returns null for malformed or unexpected storage %s', (serialized) => {
    sessionStorage.setItem(ADMIN_AUTH_STORAGE_KEY, serialized);

    expect(loadAdminAuth()).toBeNull();
  });

  it('rejects an empty token without writing storage', () => {
    expect(saveAdminAuth('   ')).toBe(false);
    expect(sessionStorage).toHaveLength(0);
  });

  it('clears only the administrator authentication key', () => {
    sessionStorage.setItem(ADMIN_AUTH_STORAGE_KEY, 'admin');
    sessionStorage.setItem('unrelated', 'preserved');

    expect(clearAdminAuth()).toBe(true);
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('unrelated')).toBe('preserved');
  });

  it('handles SecurityError during read, write, and clear', () => {
    const blockedStorage = securityErrorStorage();

    expect(loadAdminAuth(blockedStorage)).toBeNull();
    expect(saveAdminAuth(SYNTHETIC_TOKEN, blockedStorage)).toBe(false);
    expect(clearAdminAuth(blockedStorage)).toBe(false);
  });

  it('never reads from or writes to localStorage', () => {
    const localGet = vi.spyOn(window.localStorage, 'getItem');
    const localSet = vi.spyOn(window.localStorage, 'setItem');
    const localRemove = vi.spyOn(window.localStorage, 'removeItem');

    saveAdminAuth(SYNTHETIC_TOKEN);
    loadAdminAuth();
    clearAdminAuth();

    expect(localGet).not.toHaveBeenCalled();
    expect(localSet).not.toHaveBeenCalled();
    expect(localRemove).not.toHaveBeenCalled();
  });

  it('persists no password, profile, expiry, or guest data', () => {
    saveAdminAuth(SYNTHETIC_TOKEN);

    const serialized = sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY) ?? '';
    expect(serialized).not.toMatch(/password|email|profile|expir|guest/i);
  });
});
