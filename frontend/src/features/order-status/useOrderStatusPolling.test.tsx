import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

import { ApiRequestError } from '../../api/client';
import { fetchOrderStatus } from '../../api/customerApi';
import type { OrderStatus, OrderStatusResponse } from '../../api/types';
import { useOrderStatusPolling } from './useOrderStatusPolling';

vi.mock('../../api/customerApi', () => ({ fetchOrderStatus: vi.fn() }));

const PUBLIC_ORDER_NUMBER = 'ROA-23456789ABCD';
const SECOND_PUBLIC_ORDER_NUMBER = 'ROA-BCDEFGHJKLMN';
const TOKEN = 'private-guest-token';
const AUTH_TOKEN = 'private-auth-token';

const VALID_STATUS: OrderStatusResponse = {
  created_at: '2026-08-11T15:00:00Z',
  currency: 'NOK',
  items: [
    {
      line_total_amount: 500,
      menu_item_id: '00000000-0000-4000-8000-000000000010',
      name: 'Historical item',
      quantity: 1,
      unit_price_amount: 500,
    },
  ],
  order_type: 'takeaway',
  public_order_number: PUBLIC_ORDER_NUMBER,
  status: 'created',
  subtotal_amount: 500,
  table_number: null,
  total_amount: 500,
  updated_at: '2026-08-11T15:05:00Z',
};

let hidden = false;
let online = true;

function statusResponse(
  status: OrderStatus,
  publicOrderNumber = PUBLIC_ORDER_NUMBER,
): OrderStatusResponse {
  return { ...VALID_STATUS, public_order_number: publicOrderNumber, status };
}

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  hidden = false;
  online = true;
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => hidden,
  });
  Object.defineProperty(navigator, 'onLine', {
    configurable: true,
    get: () => online,
  });
  vi.mocked(fetchOrderStatus).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  Reflect.deleteProperty(document, 'hidden');
  Reflect.deleteProperty(navigator, 'onLine');
});

describe('useOrderStatusPolling', () => {
  it('starts with one immediate fetch and schedules the next after eight seconds', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(VALID_STATUS);
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );

    await flushPromises();
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
    expect(fetchOrderStatus).toHaveBeenCalledWith(
      PUBLIC_ORDER_NUMBER,
      expect.objectContaining({
        guestAccessToken: TOKEN,
        signal: expect.any(AbortSignal),
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_999);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('never overlaps a status request while the previous request is pending', async () => {
    let resolveRequest: ((value: OrderStatusResponse) => void) | undefined;
    vi.mocked(fetchOrderStatus).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
    resolveRequest?.(VALID_STATUS);
    await flushPromises();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('forwards canonical bearer and guest capability together', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(VALID_STATUS);

    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        accessToken: AUTH_TOKEN,
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    expect(fetchOrderStatus).toHaveBeenCalledWith(
      PUBLIC_ORDER_NUMBER,
      expect.objectContaining({
        accessToken: AUTH_TOKEN,
        guestAccessToken: TOKEN,
      }),
    );
  });

  it('supports bearer-only owner polling', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(VALID_STATUS);

    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        accessToken: AUTH_TOKEN,
        enabled: true,
      }),
    );
    await flushPromises();

    expect(fetchOrderStatus).toHaveBeenCalledWith(
      PUBLIC_ORDER_NUMBER,
      expect.objectContaining({ accessToken: AUTH_TOKEN }),
    );
    expect(vi.mocked(fetchOrderStatus).mock.calls[0]?.[1]).not.toHaveProperty(
      'guestAccessToken',
    );
  });

  it('does not start while mixed authentication is unresolved', async () => {
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: false,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    expect(fetchOrderStatus).not.toHaveBeenCalled();
  });

  it('stops an authenticated 401 without an anonymous retry', async () => {
    const onUnauthorized = vi.fn();
    vi.mocked(fetchOrderStatus).mockRejectedValue(
      new ApiRequestError('http', 'unauthorized', { status: 401 }),
    );
    const { result } = renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        accessToken: AUTH_TOKEN,
        enabled: true,
        guestAccessToken: TOKEN,
        onUnauthorized,
      }),
    );
    await flushPromises();

    expect(result.current.error).toMatchObject({ kind: 'access', retryable: false });
    expect(result.current.isStopped).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'cancelled'] as const)(
    'stops immediately after terminal status %s',
    async (status) => {
      vi.mocked(fetchOrderStatus).mockResolvedValue(statusResponse(status));
      const { result } = renderHook(() =>
        useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
          enabled: true,
          guestAccessToken: TOKEN,
        }),
      );

      await flushPromises();
      expect(result.current.isStopped).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
    },
  );

  it('continues polling after ready', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(statusResponse('ready'));
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );

    await flushPromises();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('uses bounded 8, 16, and 30 second transient retry delays', async () => {
    vi.mocked(fetchOrderStatus).mockRejectedValue(
      new ApiRequestError('network', 'offline'),
    );
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);

    for (const [delay, expectedCalls] of [
      [8_000, 2],
      [16_000, 3],
      [30_000, 4],
      [30_000, 5],
    ] as const) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delay - 1);
      });
      expect(fetchOrderStatus).toHaveBeenCalledTimes(expectedCalls - 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(fetchOrderStatus).toHaveBeenCalledTimes(expectedCalls);
    }
  });

  it('resets the delay to eight seconds after a successful response', async () => {
    vi.mocked(fetchOrderStatus)
      .mockRejectedValueOnce(new ApiRequestError('timeout', 'slow'))
      .mockResolvedValue(VALID_STATUS);
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(3);
  });

  it.each([
    new ApiRequestError('http', 'not found', { status: 404 }),
    new ApiRequestError('invalid-response', 'invalid'),
  ])('stops automatic polling after a non-transient error', async (error) => {
    vi.mocked(fetchOrderStatus).mockRejectedValue(error);
    const { result } = renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );

    await flushPromises();
    expect(result.current.isStopped).toBe(true);
    expect(result.current.error?.retryable).toBe(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('supports one immediate manual retry and cancels the pending timer', async () => {
    vi.mocked(fetchOrderStatus)
      .mockRejectedValueOnce(new ApiRequestError('network', 'offline'))
      .mockResolvedValue(VALID_STATUS);
    const { result } = renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    act(() => result.current.retryNow());
    await flushPromises();

    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7_999);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and refreshes immediately when visible', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(VALID_STATUS);
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);

    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await flushPromises();
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('pauses while offline and refreshes immediately when online', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(VALID_STATUS);
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);

    online = true;
    act(() => window.dispatchEvent(new Event('online')));
    await flushPromises();
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('waits for both visible and online without duplicate resume requests', async () => {
    vi.mocked(fetchOrderStatus).mockResolvedValue(VALID_STATUS);
    renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();

    hidden = true;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    online = false;
    act(() => window.dispatchEvent(new Event('offline')));
    hidden = false;
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);

    online = true;
    act(() => {
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await flushPromises();
    expect(fetchOrderStatus).toHaveBeenCalledTimes(2);
  });

  it('aborts the active request and removes work on unmount', async () => {
    vi.mocked(fetchOrderStatus).mockImplementation(
      (_number, options) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          );
        }),
    );
    const { unmount } = renderHook(() =>
      useOrderStatusPolling(PUBLIC_ORDER_NUMBER, {
        enabled: true,
        guestAccessToken: TOKEN,
      }),
    );
    await flushPromises();
    const signal = vi.mocked(fetchOrderStatus).mock.calls[0]?.[1].signal;

    unmount();

    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchOrderStatus).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale response after the order and token change', async () => {
    let resolveFirst: ((value: OrderStatusResponse) => void) | undefined;
    let resolveSecond: ((value: OrderStatusResponse) => void) | undefined;
    vi.mocked(fetchOrderStatus)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecond = resolve;
          }),
      );
    const { rerender, result } = renderHook(
      ({ number, token }) =>
        useOrderStatusPolling(number, {
          enabled: true,
          guestAccessToken: token,
        }),
      { initialProps: { number: PUBLIC_ORDER_NUMBER, token: TOKEN } },
    );
    await flushPromises();

    rerender({ number: SECOND_PUBLIC_ORDER_NUMBER, token: 'second-token' });
    await flushPromises();
    resolveSecond?.(statusResponse('accepted', SECOND_PUBLIC_ORDER_NUMBER));
    await flushPromises();
    resolveFirst?.(statusResponse('completed'));
    await flushPromises();

    expect(result.current.data?.public_order_number).toBe(SECOND_PUBLIC_ORDER_NUMBER);
    expect(result.current.data?.status).toBe('accepted');
  });
});
