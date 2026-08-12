import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import {
  buildAdminAwareDateRange,
  type AdminDateRangeSelection,
} from '../../components/admin/adminDateRange';
import { adminRoutes } from '../../routes/adminRoutes';
import { installFetchStub } from '../../test/fetchStub';
import { ADMIN_AUTH_STORAGE_KEY } from '../admin-auth/adminAuthStorage';
import { downloadCsvBlob } from './csvDownload';

vi.mock('./csvDownload', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./csvDownload')>();
  return { ...actual, downloadCsvBlob: vi.fn() };
});

const TOKEN = 'test-admin-token';
const ME = { email: 'exports-admin@example.test', is_active: true };
const CSV_HEADERS = {
  'Content-Disposition': 'attachment; filename="safe_backend_export.csv"',
  'Content-Type': 'text/csv; charset=utf-8',
};

function storeToken(): void {
  sessionStorage.setItem(
    ADMIN_AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function renderExports(): void {
  storeToken();
  const router = createMemoryRouter([adminRoutes], {
    initialEntries: ['/admin/exports'],
  });
  render(<RouterProvider router={router} />);
}

async function waitForExportsPage(): Promise<void> {
  expect(
    await screen.findByRole('heading', { level: 1, name: 'Exports' }),
  ).toBeVisible();
}

function requestQuery(url: string): URLSearchParams {
  return new URL(url, 'http://exports.test').searchParams;
}

function selectedRange(): AdminDateRangeSelection {
  return {
    endDate: (screen.getByLabelText('End date') as HTMLInputElement).value,
    startDate: (screen.getByLabelText('Start date') as HTMLInputElement).value,
  };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.mocked(downloadCsvBlob).mockReset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('administrator CSV export page', () => {
  it('uses the exact three authenticated GET contracts and selected Oslo filters', async () => {
    const stub = installFetchStub(
      { json: ME },
      { body: 'orders-bytes', headers: CSV_HEADERS },
      { body: 'product-bytes', headers: CSV_HEADERS },
      { body: 'payment-bytes', headers: CSV_HEADERS },
    );
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.type(screen.getByLabelText(/^Currency \(optional\)/), 'eur');
    await user.selectOptions(screen.getByLabelText('Status'), 'completed');
    await user.selectOptions(screen.getByLabelText('Order type'), 'dine_in');
    await user.click(screen.getByRole('button', { name: 'Download orders CSV' }));
    await user.click(
      await screen.findByRole('button', { name: 'Download product sales CSV' }),
    );
    await user.click(
      await screen.findByRole('button', { name: 'Download payments CSV' }),
    );

    await waitFor(() => expect(stub.calls).toHaveLength(4));
    const exportCalls = stub.calls.slice(1);
    expect(exportCalls.map((call) => new URL(call.url, 'http://x').pathname)).toEqual([
      '/api/v1/admin/exports/orders.csv',
      '/api/v1/admin/exports/product-sales.csv',
      '/api/v1/admin/exports/payments.csv',
    ]);
    expect(
      exportCalls.every(
        (call) =>
          call.method === 'GET' &&
          call.body === null &&
          call.headers.get('Authorization') === `Bearer ${TOKEN}` &&
          call.headers.get('Content-Type') === null,
      ),
    ).toBe(true);

    const aware = buildAdminAwareDateRange(selectedRange());
    for (const call of exportCalls) {
      const query = requestQuery(call.url);
      expect(query.get('start')).toBe(aware.start);
      expect(query.get('end')).toBe(aware.end);
      expect(query.get('currency')).toBe('EUR');
    }
    expect(requestQuery(exportCalls[0]!.url).get('status')).toBe('completed');
    expect(requestQuery(exportCalls[0]!.url).get('order_type')).toBe('dine_in');
    expect(requestQuery(exportCalls[1]!.url).has('status')).toBe(false);
    expect(requestQuery(exportCalls[1]!.url).has('order_type')).toBe(false);
    expect(requestQuery(exportCalls[2]!.url).has('status')).toBe(false);
    expect(requestQuery(exportCalls[2]!.url).has('order_type')).toBe(false);
    expect(downloadCsvBlob).toHaveBeenCalledTimes(3);
  });

  it('omits blank optional filters and downloads a header-only CSV', async () => {
    const stub = installFetchStub(
      { json: ME },
      { body: 'header-one,header-two\r\n', headers: CSV_HEADERS },
    );
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.click(screen.getByRole('button', { name: 'Download orders CSV' }));

    expect(await screen.findByText('Orders CSV download started.')).toBeVisible();
    const query = requestQuery(stub.calls[1]!.url);
    expect(query.has('currency')).toBe(false);
    expect(query.has('status')).toBe(false);
    expect(query.has('order_type')).toBe(false);
    expect(downloadCsvBlob).toHaveBeenCalledOnce();
    const blob = vi.mocked(downloadCsvBlob).mock.calls[0]![0];
    expect(await blob.text()).toBe('header-one,header-two\r\n');
  });

  it('blocks invalid currency and reversed dates before an export request', async () => {
    const stub = installFetchStub({ json: ME });
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.type(screen.getByLabelText(/^Currency \(optional\)/), 'N1');
    await user.click(screen.getByRole('button', { name: 'Download payments CSV' }));
    expect(screen.getByText(/three uppercase ASCII letters/i)).toBeVisible();
    await waitFor(() =>
      expect(screen.getByLabelText(/^Currency \(optional\)/)).toHaveFocus(),
    );

    await user.clear(screen.getByLabelText(/^Currency \(optional\)/));
    await user.clear(screen.getByLabelText('Start date'));
    await user.type(screen.getByLabelText('Start date'), '2026-08-20');
    await user.clear(screen.getByLabelText('End date'));
    await user.type(screen.getByLabelText('End date'), '2026-08-12');
    await user.click(screen.getByRole('button', { name: 'Download orders CSV' }));
    expect(screen.getByText(/same as or after start date/i)).toBeVisible();
    await waitFor(() => expect(screen.getByLabelText(/^End date/)).toHaveFocus());
    expect(stub.calls).toHaveLength(1);
  });

  it('prevents a duplicate request while the same export is pending', async () => {
    let resolveResponse!: (response: Response) => void;
    const responsePromise = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const stub = installFetchStub({ json: ME }, { responsePromise });
    renderExports();
    await waitForExportsPage();
    const button = screen.getByRole('button', { name: 'Download payments CSV' });

    fireEvent.click(button);
    fireEvent.click(button);

    expect(stub.calls).toHaveLength(2);
    expect(
      screen.getByRole('button', { name: 'Preparing payments CSV…' }),
    ).toBeDisabled();
    resolveResponse(new Response('bytes', { headers: CSV_HEADERS }));
    expect(await screen.findByText('Payments CSV download started.')).toBeVisible();
    expect(stub.calls).toHaveLength(2);
  });

  it.each([
    ['attachment; filename="orders_20260812_all.csv"', 'orders_20260812_all.csv'],
    [null, 'orders.csv'],
    ['attachment; filename="../private.csv"', 'orders.csv'],
    ['attachment; filename=unquoted.csv', 'orders.csv'],
  ])(
    'uses safe filename metadata or fallback for %s',
    async (disposition, expected) => {
      installFetchStub(
        { json: ME },
        {
          body: 'bytes',
          headers: {
            ...(disposition === null ? {} : { 'Content-Disposition': disposition }),
            'Content-Type': 'TEXT/CSV; charset=UTF-8',
          },
        },
      );
      const user = userEvent.setup();
      renderExports();
      await waitForExportsPage();

      await user.click(screen.getByRole('button', { name: 'Download orders CSV' }));

      await waitFor(() => expect(downloadCsvBlob).toHaveBeenCalledOnce());
      expect(vi.mocked(downloadCsvBlob).mock.calls[0]![1]).toBe(expected);
    },
  );

  it('rejects a successful non-CSV response without starting a download', async () => {
    installFetchStub(
      { json: ME },
      { body: '{"unexpected":true}', headers: { 'Content-Type': 'application/json' } },
    );
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.click(
      screen.getByRole('button', { name: 'Download product sales CSV' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid CSV response/i);
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it('expires the administrator session after an export 401', async () => {
    installFetchStub({ json: ME }, { status: 401 });
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.click(screen.getByRole('button', { name: 'Download payments CSV' }));

    expect(
      await screen.findByRole('heading', { name: 'Administrator sign-in' }),
    ).toBeVisible();
    expect(sessionStorage.getItem(ADMIN_AUTH_STORAGE_KEY)).toBeNull();
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it.each([
    [422, /filters were not accepted/i],
    [503, /temporarily unavailable/i],
    [500, /temporarily unavailable/i],
  ])('shows a safe retry-only message for HTTP %s', async (status, message) => {
    installFetchStub({ json: ME }, { status });
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.click(screen.getByRole('button', { name: 'Download payments CSV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it('shows a safe network failure without an automatic retry', async () => {
    const stub = installFetchStub({ json: ME }, { error: new TypeError('offline') });
    const user = userEvent.setup();
    renderExports();
    await waitForExportsPage();

    await user.click(screen.getByRole('button', { name: 'Download orders CSV' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach/i);
    expect(stub.calls).toHaveLength(2);
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });

  it('reports the shared 30-second Blob timeout without retrying', async () => {
    vi.useFakeTimers();
    const stub = installFetchStub({ json: ME }, { waitForAbort: true });
    renderExports();
    expect(
      screen.getByRole('heading', { name: 'Checking your session' }),
    ).toBeVisible();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
    });
    expect(screen.getByRole('heading', { level: 1, name: 'Exports' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Download payments CSV' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.resolve();
    });

    expect(screen.getByRole('alert')).toHaveTextContent(/timed out/i);
    expect(stub.calls).toHaveLength(2);
    expect(downloadCsvBlob).not.toHaveBeenCalled();
  });
});
