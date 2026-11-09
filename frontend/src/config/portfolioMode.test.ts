import { afterEach, vi } from 'vitest';

import { isPortfolioModeEnabled } from './portfolioMode';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('portfolio-mode configuration', () => {
  it('enables portfolio presentation only for the exact explicit true value', () => {
    vi.stubEnv('VITE_PORTFOLIO_MODE', 'true');

    expect(isPortfolioModeEnabled()).toBe(true);
  });

  it.each(['', 'false', 'TRUE', '1', ' true '])(
    'keeps normal presentation for %j',
    (value) => {
      vi.stubEnv('VITE_PORTFOLIO_MODE', value);

      expect(isPortfolioModeEnabled()).toBe(false);
    },
  );
});
