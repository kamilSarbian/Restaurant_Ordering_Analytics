import { useEffect, useMemo, useRef, useState } from 'react';

import { AdminApiRequestError } from '../../api/adminApi';
import {
  fetchPortfolioExchangeRates,
  type PortfolioExchangeRates,
} from '../../api/exchangeRateApi';
import Button from '../../components/ui/Button';
import Notice from '../../components/ui/Notice';
import { useAuth } from '../auth/AuthContext';
import styles from './PortfolioCurrencyConverter.module.css';

const NOK_AMOUNT_PATTERN = /^(?:0|[1-9]\d{0,6})(?:[.,]\d{1,2})?$/;
const MAX_NOK_AMOUNT = 1_000_000;

type RateState = 'idle' | 'loading' | 'ready' | 'unavailable';

function parseNokAmount(value: string): number | null {
  const normalized = value.trim().replace(',', '.');
  if (!NOK_AMOUNT_PATTERN.test(normalized)) return null;
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 && amount <= MAX_NOK_AMOUNT
    ? amount
    : null;
}

function formatApproximateAmount(amount: number, currency: 'EUR' | 'PLN'): string {
  return new Intl.NumberFormat('en', {
    currency,
    currencyDisplay: 'code',
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
    style: 'currency',
  }).format(amount);
}

export default function PortfolioCurrencyConverter() {
  const { getAuthenticatedSession, invalidateSessionIfCurrent, logout } = useAuth();
  const [amount, setAmount] = useState('100');
  const [rates, setRates] = useState<PortfolioExchangeRates | null>(null);
  const [state, setState] = useState<RateState>('idle');
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(
    () => () => {
      mountedRef.current = false;
      generationRef.current += 1;
      controllerRef.current?.abort();
      controllerRef.current = null;
    },
    [],
  );

  const parsedAmount = parseNokAmount(amount);
  const conversion = useMemo(() => {
    if (rates === null || parsedAmount === null) return null;
    const nokPerEur = Number(rates.nokPerEur);
    const plnPerEur = Number(rates.plnPerEur);
    return {
      eur: formatApproximateAmount(parsedAmount / nokPerEur, 'EUR'),
      pln: formatApproximateAmount((parsedAmount * plnPerEur) / nokPerEur, 'PLN'),
    };
  }, [parsedAmount, rates]);

  const loadRates = async () => {
    if (state === 'loading') return;
    const authSession = getAuthenticatedSession();
    if (authSession === null) {
      logout();
      return;
    }
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    generationRef.current += 1;
    const generation = generationRef.current;
    setState('loading');
    try {
      const nextRates = await fetchPortfolioExchangeRates(
        authSession.accessToken,
        controller.signal,
      );
      if (!mountedRef.current || generationRef.current !== generation) return;
      setRates(nextRates);
      setState('ready');
    } catch (error: unknown) {
      if (
        error instanceof AdminApiRequestError &&
        (error.kind === 'aborted' || controller.signal.aborted)
      ) {
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (!mountedRef.current || generationRef.current !== generation) return;
      setRates(null);
      setState('unavailable');
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
    }
  };

  return (
    <section
      className={styles.converter}
      aria-labelledby="portfolio-currency-converter-heading"
    >
      <div className={styles.heading}>
        <div>
          <p className={styles.eyebrow}>Reference calculator</p>
          <h2 id="portfolio-currency-converter-heading">Approximate NOK conversion</h2>
        </div>
        <Button
          loading={state === 'loading'}
          loadingLabel="Loading ECB rates"
          size="md"
          type="button"
          variant="secondary"
          onClick={() => void loadRates()}
        >
          {rates === null ? 'Load ECB rates' : 'Refresh ECB rates'}
        </Button>
      </div>

      <p className={styles.explanation}>
        Convert a display amount without changing analytics filters, CSV exports,
        orders, or payments.
      </p>
      <label className={styles.amountField}>
        Amount in NOK
        <input
          aria-describedby="portfolio-converter-amount-hint"
          aria-invalid={amount !== '' && parsedAmount === null}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.currentTarget.value)}
        />
        <span id="portfolio-converter-amount-hint">
          Enter more than 0 and no more than 1,000,000 NOK.
        </span>
      </label>

      {state === 'unavailable' ? (
        <Notice title="Current ECB rates are unavailable" variant="warning">
          The reference feed could not provide a current, validated rate pair. No
          conversion is shown.
        </Notice>
      ) : null}
      {rates !== null && conversion !== null ? (
        <div className={styles.result} aria-live="polite">
          <p>
            <strong>Approximate EUR:</strong> {conversion.eur}
          </p>
          <p>
            <strong>Approximate PLN:</strong> {conversion.pln}
          </p>
          <p className={styles.source}>
            Source: {rates.source}, reference date {rates.referenceDate}, base{' '}
            {rates.base}. Approximate reference values only.
          </p>
        </div>
      ) : null}
    </section>
  );
}
