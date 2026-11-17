import { adminRequestJson } from './adminApi';

const EXCHANGE_RATE_TIMEOUT_MS = 5_000;
const DECIMAL_RATE_PATTERN = /^(?:0|[1-9]\d{0,4})(?:\.\d{1,12})?$/;

export interface PortfolioExchangeRates {
  readonly base: 'EUR';
  readonly nokPerEur: string;
  readonly plnPerEur: string;
  readonly referenceDate: string;
  readonly source: 'European Central Bank';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function isValidRate(value: unknown): value is string {
  if (typeof value !== 'string' || !DECIMAL_RATE_PATTERN.test(value)) return false;
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0 && rate <= 10_000;
}

function parsePortfolioExchangeRates(value: unknown): PortfolioExchangeRates {
  if (!isRecord(value) || Object.keys(value).length !== 5) {
    throw new TypeError('The exchange-rate response is not valid.');
  }
  if (
    value.source !== 'European Central Bank' ||
    value.base !== 'EUR' ||
    !isValidDateOnly(value.reference_date) ||
    !isValidRate(value.nok_per_eur) ||
    !isValidRate(value.pln_per_eur)
  ) {
    throw new TypeError('The exchange-rate response is not valid.');
  }
  return {
    base: 'EUR',
    nokPerEur: value.nok_per_eur,
    plnPerEur: value.pln_per_eur,
    referenceDate: value.reference_date,
    source: 'European Central Bank',
  };
}

/** Load the read-only ECB reference rates for the portfolio calculator. */
export async function fetchPortfolioExchangeRates(
  accessToken: string,
  signal?: AbortSignal,
): Promise<PortfolioExchangeRates> {
  const response = await adminRequestJson('/api/v1/admin/exchange-rates/ecb', {
    accessToken,
    signal,
    timeoutMs: EXCHANGE_RATE_TIMEOUT_MS,
  });
  return parsePortfolioExchangeRates(response);
}
