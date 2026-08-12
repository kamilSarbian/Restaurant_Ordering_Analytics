import { useCallback, useEffect, useRef, useState } from 'react';

import { ApiRequestError } from '../../api/client';
import { fetchOrderStatus } from '../../api/customerApi';
import type { OrderStatusResponse } from '../../api/types';

const NORMAL_POLL_DELAY_MS = 8_000;
const TRANSIENT_RETRY_DELAYS_MS = [8_000, 16_000, 30_000] as const;

export type OrderStatusPollingErrorKind = 'access' | 'contract' | 'transient';

export interface OrderStatusPollingError {
  kind: OrderStatusPollingErrorKind;
  message: string;
  retryable: boolean;
}

export interface OrderStatusPollingResult {
  data: OrderStatusResponse | null;
  error: OrderStatusPollingError | null;
  isLoading: boolean;
  isPaused: boolean;
  isRefreshing: boolean;
  isStopped: boolean;
  retryNow: () => void;
}

interface PollingState {
  data: OrderStatusResponse | null;
  error: OrderStatusPollingError | null;
  isLoading: boolean;
  isPaused: boolean;
  isRefreshing: boolean;
  isStopped: boolean;
}

function isTerminalStatus(status: OrderStatusResponse['status']): boolean {
  return status === 'completed' || status === 'cancelled';
}

function classifyPollingError(error: unknown): OrderStatusPollingError {
  if (error instanceof ApiRequestError) {
    if (error.kind === 'http' && error.status === 404) {
      return {
        kind: 'access',
        message: 'We could not access this order from this session.',
        retryable: false,
      };
    }
    if (
      error.kind === 'invalid-response' ||
      (error.kind === 'http' && error.status === 422)
    ) {
      return {
        kind: 'contract',
        message: 'The order status response could not be safely read.',
        retryable: false,
      };
    }
    if (
      error.kind === 'network' ||
      error.kind === 'timeout' ||
      error.kind === 'aborted' ||
      (error.kind === 'http' && error.status !== null && error.status >= 500)
    ) {
      return {
        kind: 'transient',
        message: 'Order status is temporarily unavailable. We will retry safely.',
        retryable: true,
      };
    }
  }
  return {
    kind: 'contract',
    message: 'The order status request could not be completed safely.',
    retryable: false,
  };
}

function environmentIsAvailable(): boolean {
  return !document.hidden && navigator.onLine;
}

/** Poll one protected order snapshot without overlapping or background requests. */
export function useOrderStatusPolling(
  publicOrderNumber: string,
  token: string | null,
  enabled: boolean,
): OrderStatusPollingResult {
  const [state, setState] = useState<PollingState>({
    data: null,
    error: null,
    isLoading: enabled && token !== null,
    isPaused: enabled && token !== null && !environmentIsAvailable(),
    isRefreshing: false,
    isStopped: !enabled || token === null,
  });
  const requestRef = useRef<() => void>(() => undefined);

  const retryNow = useCallback(() => requestRef.current(), []);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let stopped = !enabled || token === null;
    let suspended = !environmentIsAvailable();
    let consecutiveFailures = 0;
    let latestData: OrderStatusResponse | null = null;
    let timerId: number | null = null;
    let controller: AbortController | null = null;

    const clearTimer = (): void => {
      if (timerId !== null) {
        window.clearTimeout(timerId);
        timerId = null;
      }
    };

    let requestStatus = (): void => undefined;

    const schedule = (delayMs: number): void => {
      clearTimer();
      if (!active || stopped || suspended) {
        return;
      }
      timerId = window.setTimeout(() => {
        timerId = null;
        requestStatus();
      }, delayMs);
    };

    requestStatus = (): void => {
      if (!active || stopped || suspended || inFlight || token === null || !enabled) {
        return;
      }
      clearTimer();
      inFlight = true;
      controller = new AbortController();
      setState((current) => ({
        ...current,
        error: null,
        isLoading: latestData === null,
        isRefreshing: latestData !== null,
        isStopped: false,
      }));

      void fetchOrderStatus(publicOrderNumber, token, controller.signal)
        .then((response) => {
          if (!active) {
            return;
          }
          latestData = response;
          consecutiveFailures = 0;
          stopped = isTerminalStatus(response.status);
          setState({
            data: response,
            error: null,
            isLoading: false,
            isPaused: suspended,
            isRefreshing: false,
            isStopped: stopped,
          });
          if (!stopped) {
            schedule(NORMAL_POLL_DELAY_MS);
          }
        })
        .catch((error: unknown) => {
          if (!active || controller?.signal.aborted === true) {
            return;
          }
          const pollingError = classifyPollingError(error);
          stopped = !pollingError.retryable;
          setState({
            data: latestData,
            error: pollingError,
            isLoading: false,
            isPaused: suspended,
            isRefreshing: false,
            isStopped: stopped,
          });
          if (pollingError.retryable) {
            consecutiveFailures += 1;
            const delayIndex = Math.min(
              consecutiveFailures - 1,
              TRANSIENT_RETRY_DELAYS_MS.length - 1,
            );
            schedule(TRANSIENT_RETRY_DELAYS_MS[delayIndex]!);
          }
        })
        .finally(() => {
          inFlight = false;
          controller = null;
        });
    };

    requestRef.current = () => {
      clearTimer();
      if (!active || suspended || inFlight || token === null || !enabled) {
        return;
      }
      stopped = false;
      requestStatus();
    };

    const handleEnvironmentChange = (): void => {
      const nextSuspended = !environmentIsAvailable();
      if (nextSuspended === suspended) {
        return;
      }
      suspended = nextSuspended;
      setState((current) => ({ ...current, isPaused: suspended }));
      if (suspended) {
        clearTimer();
      } else if (!stopped) {
        requestStatus();
      }
    };

    if (enabled && token !== null) {
      document.addEventListener('visibilitychange', handleEnvironmentChange);
      window.addEventListener('online', handleEnvironmentChange);
      window.addEventListener('offline', handleEnvironmentChange);
    }

    window.queueMicrotask(() => {
      if (!active) {
        return;
      }
      setState({
        data: null,
        error: null,
        isLoading: enabled && token !== null && !suspended,
        isPaused: enabled && token !== null && suspended,
        isRefreshing: false,
        isStopped: stopped,
      });
      if (enabled && token !== null && !suspended) {
        requestStatus();
      }
    });

    return () => {
      active = false;
      requestRef.current = () => undefined;
      clearTimer();
      controller?.abort();
      document.removeEventListener('visibilitychange', handleEnvironmentChange);
      window.removeEventListener('online', handleEnvironmentChange);
      window.removeEventListener('offline', handleEnvironmentChange);
    };
  }, [enabled, publicOrderNumber, token]);

  return { ...state, retryNow };
}
