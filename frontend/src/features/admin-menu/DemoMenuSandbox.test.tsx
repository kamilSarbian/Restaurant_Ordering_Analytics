import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import DemoMenuSandbox, { DemoMenuSandboxProvider } from './DemoMenuSandbox';

const PUBLIC_MENU = {
  categories: [
    {
      description: null,
      display_order: 1,
      id: '00000000-0000-4000-8000-000000000001',
      items: [
        {
          allergens: [],
          currency: 'NOK',
          description: 'Roasted root vegetables and barley.',
          display_order: 1,
          id: '00000000-0000-4000-8000-000000000011',
          image_url: null,
          is_available: true,
          name: 'Nordic bowl',
          price_amount: 18900,
        },
      ],
      name: 'Main dishes',
    },
  ],
};

function renderSandbox() {
  return render(
    <DemoMenuSandboxProvider>
      <DemoMenuSandbox />
    </DemoMenuSandboxProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DemoMenuSandbox', () => {
  it('edits, hides, adds, previews, and resets a public GET snapshot in memory', async () => {
    const stub = installFetchStub({ json: PUBLIC_MENU });
    const user = userEvent.setup();
    renderSandbox();

    const editor = await screen.findByRole('group', { name: 'Nordic bowl' });
    const preview = screen.getByRole('region', {
      name: 'Current browser preview',
    });
    expect(within(preview).getByText('Nordic bowl')).toBeVisible();

    const name = within(editor).getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Forest bowl');
    expect(within(preview).getByText('Forest bowl')).toBeVisible();

    const description = within(editor).getByLabelText('Description');
    await user.clear(description);
    await user.type(description, 'Local mushrooms and barley.');
    expect(within(preview).getByText('Local mushrooms and barley.')).toBeVisible();

    const price = within(editor).getByLabelText('Price (NOK)');
    await user.clear(price);
    await user.type(price, '201.50');
    expect(price).toHaveValue(201.5);
    expect(within(preview).getByText(/201[.,]50/u)).toBeVisible();

    await user.click(within(editor).getByLabelText('Available in preview'));
    expect(within(preview).queryByText('Forest bowl')).not.toBeInTheDocument();
    await user.click(within(editor).getByLabelText('Available in preview'));
    await user.click(within(editor).getByLabelText('Hide from preview'));
    expect(within(preview).queryByText('Forest bowl')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Add sample dish' }));
    expect(screen.getByRole('group', { name: 'Sample dish 1' })).toBeVisible();
    expect(within(preview).getByText('Sample dish 1')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Reset to original menu' }));
    expect(screen.getByRole('group', { name: 'Nordic bowl' })).toBeVisible();
    expect(
      screen.queryByRole('group', { name: 'Sample dish 1' }),
    ).not.toBeInTheDocument();
    expect(within(preview).getByText('Nordic bowl')).toBeVisible();

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toMatchObject({
      body: null,
      method: 'GET',
      url: '/api/v1/menu',
    });
  });

  it('offers a public-menu retry without sending a catalog mutation', async () => {
    const stub = installFetchStub({ status: 503 }, { json: PUBLIC_MENU });
    const user = userEvent.setup();
    renderSandbox();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Menu snapshot unavailable',
    );
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Retry public menu' }));
    expect(await screen.findByRole('group', { name: 'Nordic bowl' })).toBeVisible();

    await waitFor(() => expect(stub.calls).toHaveLength(2));
    expect(
      stub.calls.every(({ method, url }) => method === 'GET' && url === '/api/v1/menu'),
    ).toBe(true);
  });

  it('discards edits when the provider is unmounted and recreated', async () => {
    const stub = installFetchStub({ json: PUBLIC_MENU }, { json: PUBLIC_MENU });
    const user = userEvent.setup();
    const firstSession = renderSandbox();

    await screen.findByRole('group', { name: 'Nordic bowl' });
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Temporary browser dish');
    expect(screen.getByRole('group', { name: 'Temporary browser dish' })).toBeVisible();

    firstSession.unmount();
    renderSandbox();

    expect(await screen.findByRole('group', { name: 'Nordic bowl' })).toBeVisible();
    expect(screen.queryByText('Temporary browser dish')).not.toBeInTheDocument();
    expect(stub.calls.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: 'GET', url: '/api/v1/menu' },
      { method: 'GET', url: '/api/v1/menu' },
    ]);
  });
});
