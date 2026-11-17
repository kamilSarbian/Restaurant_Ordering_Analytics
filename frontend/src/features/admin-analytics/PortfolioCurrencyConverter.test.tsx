import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import { AUTH_STORAGE_KEY, resetAuthMemoryForTests } from '../auth/authStorage';
import PortfolioCurrencyConverter from './PortfolioCurrencyConverter';

const TOKEN = 'synthetic-converter-admin-token';
const ME = {
  email: 'converter-admin@example.test',
  id: '00000000-0000-4000-8000-000000000933',
  is_active: true,
  role: 'admin',
};

function renderConverter(): ReturnType<typeof render> {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [{ path: '/', element: <PortfolioCurrencyConverter /> }],
      },
    ],
    { initialEntries: ['/'] },
  );
  return render(<RouterProvider router={router} />);
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.unstubAllGlobals();
});

it('shows separate approximate EUR and PLN values with source and date', async () => {
  const stub = installFetchStub(
    { json: ME },
    {
      json: {
        base: 'EUR',
        nok_per_eur: '10.0000',
        pln_per_eur: '4.0000',
        reference_date: '2026-11-13',
        source: 'European Central Bank',
      },
    },
  );
  const user = userEvent.setup();
  renderConverter();

  await user.click(await screen.findByRole('button', { name: 'Load ECB rates' }));

  expect(await screen.findByText('EUR 10.00')).toBeVisible();
  expect(screen.getByText('PLN 40.00')).toBeVisible();
  expect(screen.getByText(/European Central Bank, reference date 2026-11-13/)).toBe(
    screen.getByText(/Approximate reference values only/),
  );
  expect(stub.calls).toHaveLength(2);
  expect(stub.calls[1]!.body).toBeNull();
  expect(stub.calls[1]!.method).toBe('GET');
});

it('rounds non-integer approximate conversions to two decimal places', async () => {
  installFetchStub(
    { json: ME },
    {
      json: {
        base: 'EUR',
        nok_per_eur: '3',
        pln_per_eur: '2',
        reference_date: '2026-11-13',
        source: 'European Central Bank',
      },
    },
  );
  const user = userEvent.setup();
  renderConverter();

  const amount = await screen.findByRole('textbox', { name: /Amount in NOK/ });
  await user.clear(amount);
  await user.type(amount, '10.01');
  await user.click(screen.getByRole('button', { name: 'Load ECB rates' }));

  expect(await screen.findByText('EUR 3.34')).toBeVisible();
  expect(screen.getByText('PLN 6.67')).toBeVisible();
});

it('shows a safe unavailable state without stale conversion values', async () => {
  installFetchStub({ json: ME }, { json: { detail: 'unavailable' }, status: 503 });
  const user = userEvent.setup();
  renderConverter();

  await user.click(await screen.findByRole('button', { name: 'Load ECB rates' }));

  expect(await screen.findByText('Current ECB rates are unavailable')).toBeVisible();
  expect(screen.queryByText(/Approximate EUR:/)).not.toBeInTheDocument();
});

it('aborts the rate request when the calculator unmounts', async () => {
  const stub = installFetchStub({ json: ME }, { waitForAbort: true });
  const user = userEvent.setup();
  const view = renderConverter();

  await user.click(await screen.findByRole('button', { name: 'Load ECB rates' }));
  await waitFor(() => expect(stub.calls).toHaveLength(2));
  expect(stub.calls[1]!.signal?.aborted).toBe(false);
  view.unmount();
  expect(stub.calls[1]!.signal?.aborted).toBe(true);
});
