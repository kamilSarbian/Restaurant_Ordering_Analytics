import { afterEach, vi } from 'vitest';

import { isCustomerDemoSessionEntryEnabled } from './customerDemoSession';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('customer demo-session build flag', () => {
  it('enables the entry only for the exact true string', () => {
    vi.stubEnv('VITE_ENABLE_CUSTOMER_DEMO_SESSION', 'true');
    expect(isCustomerDemoSessionEntryEnabled()).toBe(true);
  });

  it.each(['', 'false', 'TRUE', '1'])('keeps the entry hidden for %j', (value) => {
    vi.stubEnv('VITE_ENABLE_CUSTOMER_DEMO_SESSION', value);
    expect(isCustomerDemoSessionEntryEnabled()).toBe(false);
  });
});
