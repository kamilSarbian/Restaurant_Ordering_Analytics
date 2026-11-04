import { afterEach, vi } from 'vitest';

import { isDemoSessionEntryEnabled } from './demoSession';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('demo-session entry configuration', () => {
  it('enables the entry only for the exact explicit true value', () => {
    vi.stubEnv('VITE_ENABLE_DEMO_SESSION', 'true');

    expect(isDemoSessionEntryEnabled()).toBe(true);
  });

  it.each(['', 'false', 'TRUE', '1', ' true '])(
    'keeps the entry disabled for %j',
    (value) => {
      vi.stubEnv('VITE_ENABLE_DEMO_SESSION', value);

      expect(isDemoSessionEntryEnabled()).toBe(false);
    },
  );
});
