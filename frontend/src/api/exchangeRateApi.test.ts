import { afterEach, expect, it, vi } from 'vitest';

import { installFetchStub } from '../test/fetchStub';
import { fetchPortfolioExchangeRates } from './exchangeRateApi';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('loads the exact authenticated read-only ECB contract', async () => {
  const stub = installFetchStub({
    json: {
      base: 'EUR',
      nok_per_eur: '11.7000',
      pln_per_eur: '4.2500',
      reference_date: '2026-11-13',
      source: 'European Central Bank',
    },
  });

  await expect(fetchPortfolioExchangeRates('safe-token')).resolves.toEqual({
    base: 'EUR',
    nokPerEur: '11.7000',
    plnPerEur: '4.2500',
    referenceDate: '2026-11-13',
    source: 'European Central Bank',
  });
  expect(stub.calls).toHaveLength(1);
  expect(new URL(stub.calls[0]!.url, 'http://exchange.test').pathname).toBe(
    '/api/v1/admin/exchange-rates/ecb',
  );
  expect(stub.calls[0]).toMatchObject({ body: null, method: 'GET' });
  expect(stub.calls[0]!.headers.get('Authorization')).toBe('Bearer safe-token');
});

it.each([
  { base: 'USD' },
  { nok_per_eur: 'NaN' },
  { pln_per_eur: '0' },
  { reference_date: '2026-02-30' },
  { source: 'Unknown source' },
  { extra: true },
])('rejects malformed or expanded responses: %j', async (override) => {
  installFetchStub({
    json: {
      base: 'EUR',
      nok_per_eur: '11.7000',
      pln_per_eur: '4.2500',
      reference_date: '2026-11-13',
      source: 'European Central Bank',
      ...override,
    },
  });

  await expect(fetchPortfolioExchangeRates('safe-token')).rejects.toThrow(
    'The exchange-rate response is not valid.',
  );
});
