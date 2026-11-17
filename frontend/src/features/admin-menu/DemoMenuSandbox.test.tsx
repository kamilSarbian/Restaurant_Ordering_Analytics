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
          image_url: 'https://images.example.test/nordic-bowl.jpg',
          is_available: true,
          name: 'Nordic bowl',
          price_amount: 18900,
        },
      ],
      name: 'Main dishes',
    },
    {
      description: null,
      display_order: 2,
      id: '00000000-0000-4000-8000-000000000002',
      items: [
        {
          allergens: ['gluten'],
          currency: 'NOK',
          description: 'Warm apples and vanilla cream.',
          display_order: 1,
          id: '00000000-0000-4000-8000-000000000012',
          image_url: null,
          is_available: true,
          name: 'Warm apple cake',
          price_amount: 12900,
        },
      ],
      name: 'Desserts',
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

function installObjectUrlStub(objectUrls: string[]) {
  const nativeUrl = URL;
  const availableUrls = [...objectUrls];
  const createObjectURL = vi.fn(() => {
    const objectUrl = availableUrls.shift();
    if (objectUrl === undefined) throw new Error('No synthetic object URL remains.');
    return objectUrl;
  });
  const revokeObjectURL = vi.fn();
  const stubUrl = Object.assign(class extends nativeUrl {}, {
    createObjectURL,
    revokeObjectURL,
  });
  vi.stubGlobal('URL', stubUrl);
  return { createObjectURL, revokeObjectURL };
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
    expect(screen.getAllByRole('img', { name: 'Nordic bowl preview' })).toHaveLength(2);
    expect(
      screen.getAllByRole('img', { name: 'Warm apple cake image unavailable' }),
    ).toHaveLength(2);

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

    await user.click(screen.getByRole('button', { name: 'Add dish to Main dishes' }));
    expect(screen.getByRole('group', { name: 'Sample dish 1' })).toBeVisible();
    expect(within(preview).getByText('Sample dish 1')).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Add dish to Desserts' }));
    const desserts = screen
      .getByRole('heading', { name: 'Desserts' })
      .closest('section');
    expect(desserts).not.toBeNull();
    expect(
      within(desserts as HTMLElement).getByRole('group', { name: 'Sample dish 2' }),
    ).toBeVisible();

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

  it('keeps selected images in memory and revokes them on replacement and reset', async () => {
    installFetchStub({ json: PUBLIC_MENU });
    const { createObjectURL, revokeObjectURL } = installObjectUrlStub([
      'blob:local-first',
      'blob:local-second',
    ]);
    const user = userEvent.setup();
    renderSandbox();

    const editor = await screen.findByRole('group', { name: 'Nordic bowl' });
    const fileInput = within(editor).getByLabelText(
      'Local preview image for Nordic bowl',
    );
    await user.upload(
      fileInput,
      new File(['first image'], 'first.png', { type: 'image/png' }),
    );

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(screen.getAllByRole('img', { name: 'Nordic bowl preview' })).toHaveLength(2);
    for (const image of screen.getAllByRole('img', { name: 'Nordic bowl preview' })) {
      expect(image).toHaveAttribute('src', 'blob:local-first');
    }

    await user.upload(
      fileInput,
      new File(['second image'], 'second.webp', { type: 'image/webp' }),
    );
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-first');
    for (const image of screen.getAllByRole('img', { name: 'Nordic bowl preview' })) {
      expect(image).toHaveAttribute('src', 'blob:local-second');
    }

    await user.click(screen.getByRole('button', { name: 'Reset to original menu' }));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:local-second');
    for (const image of screen.getAllByRole('img', { name: 'Nordic bowl preview' })) {
      expect(image).toHaveAttribute(
        'src',
        'https://images.example.test/nordic-bowl.jpg',
      );
    }
  });

  it('rejects unsupported and oversized local files without replacing a valid image', async () => {
    installFetchStub({ json: PUBLIC_MENU });
    const { createObjectURL, revokeObjectURL } = installObjectUrlStub(['blob:valid']);
    const user = userEvent.setup({ applyAccept: false });
    renderSandbox();

    const editor = await screen.findByRole('group', { name: 'Nordic bowl' });
    const fileInput = within(editor).getByLabelText(
      'Local preview image for Nordic bowl',
    );
    await user.upload(
      fileInput,
      new File(['not an image'], 'notes.txt', { type: 'text/plain' }),
    );
    expect(within(editor).getByRole('alert')).toHaveTextContent(
      'Choose a JPEG, PNG, or WebP image.',
    );
    expect(createObjectURL).not.toHaveBeenCalled();

    await user.upload(
      fileInput,
      new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'large.jpg', {
        type: 'image/jpeg',
      }),
    );
    expect(within(editor).getByRole('alert')).toHaveTextContent(
      'Choose an image no larger than 5 MiB.',
    );
    expect(createObjectURL).not.toHaveBeenCalled();

    await user.upload(
      fileInput,
      new File(['valid image'], 'valid.jpg', { type: 'image/jpeg' }),
    );
    expect(within(editor).queryByRole('alert')).not.toBeInTheDocument();
    expect(createObjectURL).toHaveBeenCalledOnce();

    await user.upload(
      fileInput,
      new File(['still not an image'], 'notes-again.txt', { type: 'text/plain' }),
    );
    expect(within(editor).getByRole('alert')).toHaveTextContent(
      'Choose a JPEG, PNG, or WebP image.',
    );
    expect(revokeObjectURL).not.toHaveBeenCalled();
    for (const image of screen.getAllByRole('img', { name: 'Nordic bowl preview' })) {
      expect(image).toHaveAttribute('src', 'blob:valid');
    }
  });

  it('revokes selected image URLs when the browser-only provider unmounts', async () => {
    installFetchStub({ json: PUBLIC_MENU });
    const { revokeObjectURL } = installObjectUrlStub(['blob:unmounted']);
    const user = userEvent.setup();
    const session = renderSandbox();

    const editor = await screen.findByRole('group', { name: 'Nordic bowl' });
    await user.upload(
      within(editor).getByLabelText('Local preview image for Nordic bowl'),
      new File(['image'], 'local.jpeg', { type: 'image/jpeg' }),
    );
    session.unmount();

    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:unmounted');
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

    const editor = await screen.findByRole('group', { name: 'Nordic bowl' });
    const name = within(editor).getByLabelText('Name');
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
