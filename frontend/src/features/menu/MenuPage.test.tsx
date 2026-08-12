import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { CartProvider } from '../cart/CartContext';
import { CART_STORAGE_KEY } from '../cart/cartStorage';
import MenuPage from './MenuPage';

const MENU = {
  categories: [
    {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Main dishes',
      description: 'Prepared to order.',
      display_order: 10,
      items: [
        {
          id: '00000000-0000-4000-8000-000000000011',
          name: 'Seasonal bowl',
          description: 'Vegetables and grains.',
          image_url: 'https://images.example.test/seasonal-bowl.jpg',
          price_amount: 18900,
          currency: 'NOK',
          allergens: ['sesame'],
          display_order: 10,
          is_available: true,
        },
        {
          id: '00000000-0000-4000-8000-000000000012',
          name: 'Evening special',
          description: null,
          image_url: null,
          price_amount: 21900,
          currency: 'NOK',
          allergens: [],
          display_order: 20,
          is_available: false,
        },
      ],
    },
    {
      id: '00000000-0000-4000-8000-000000000002',
      name: 'Desserts',
      description: null,
      display_order: 20,
      items: [
        {
          id: '00000000-0000-4000-8000-000000000013',
          name: 'Apple cake',
          description: 'Served warm.',
          image_url: null,
          price_amount: 11900,
          currency: 'NOK',
          allergens: ['gluten', 'milk'],
          display_order: 10,
          is_available: true,
        },
      ],
    },
  ],
};

afterEach(() => {
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

function renderMenu() {
  return render(
    <MemoryRouter>
      <CartProvider>
        <MenuPage />
      </CartProvider>
    </MemoryRouter>,
  );
}

describe('MenuPage', () => {
  it('announces the loading state while the menu request is pending', () => {
    installFetchStub({ waitForAbort: true });

    renderMenu();

    expect(screen.getByRole('status')).toHaveTextContent('Loading menu…');
  });

  it('renders categories and items in backend order', async () => {
    installFetchStub({ json: MENU });

    renderMenu();

    await screen.findByRole('heading', { level: 3, name: 'Seasonal bowl' });
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Filter menu', 'Main dishes', 'Desserts']);
    expect(
      screen
        .getAllByRole('article')
        .map(
          (article) => within(article).getByRole('heading', { level: 3 }).textContent,
        ),
    ).toEqual(['Seasonal bowl', 'Evening special', 'Apple cake']);
  });

  it('shows unavailable items and explicit availability text by default', async () => {
    installFetchStub({ json: MENU });

    renderMenu();

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Evening special' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Temporarily unavailable')).toBeInTheDocument();
    expect(screen.getAllByText('Available')).toHaveLength(2);
  });

  it('filters unavailable items locally without another fetch', async () => {
    const user = userEvent.setup();
    const stub = installFetchStub({ json: MENU });
    renderMenu();
    await screen.findByRole('heading', { level: 3, name: 'Evening special' });

    await user.click(
      screen.getByRole('checkbox', { name: 'Show available items only' }),
    );

    expect(
      screen.queryByRole('heading', { level: 3, name: 'Evening special' }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('heading', { level: 3, name: 'Seasonal bowl' }),
    ).toBeVisible();
    expect(stub.calls).toHaveLength(1);
  });

  it('filters by category and All restores the original categories', async () => {
    const user = userEvent.setup();
    installFetchStub({ json: MENU });
    renderMenu();
    await screen.findByRole('heading', { level: 2, name: 'Main dishes' });

    await user.click(screen.getByRole('button', { name: 'Desserts' }));
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Main dishes' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Desserts' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(
      screen.getByRole('heading', { level: 2, name: 'Main dishes' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Desserts' })).toBeVisible();
  });

  it('shows a distinct global empty-menu state', async () => {
    installFetchStub({ json: { categories: [] } });

    renderMenu();

    expect(await screen.findByText('The menu is currently empty.')).toBeInTheDocument();
    expect(
      screen.queryByText('No items match the current filters.'),
    ).not.toBeInTheDocument();
  });

  it('shows a filtered-empty state and clears filters without refetching', async () => {
    const user = userEvent.setup();
    const unavailableMenu = {
      categories: [{ ...MENU.categories[0]!, items: [MENU.categories[0]!.items[1]!] }],
    };
    const stub = installFetchStub({ json: unavailableMenu });
    renderMenu();
    await screen.findByRole('heading', { level: 3, name: 'Evening special' });

    await user.click(
      screen.getByRole('checkbox', { name: 'Show available items only' }),
    );
    expect(screen.getByText('No items match the current filters.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(
      screen.getByRole('heading', { level: 3, name: 'Evening special' }),
    ).toBeVisible();
    expect(
      screen.getByRole('checkbox', { name: 'Show available items only' }),
    ).not.toBeChecked();
    expect(stub.calls).toHaveLength(1);
  });

  it('shows a safe error without leaking network details', async () => {
    installFetchStub({ error: new TypeError('private socket details') });

    renderMenu();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'We could not connect to the menu service.',
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/private socket details/i)).not.toBeInTheDocument();
  });

  it('retries once when the customer requests it', async () => {
    const user = userEvent.setup();
    const stub = installFetchStub({ error: new TypeError('offline') }, { json: MENU });
    renderMenu();
    await screen.findByRole('button', { name: 'Retry' });

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(
      await screen.findByRole('heading', { level: 3, name: 'Seasonal bowl' }),
    ).toBeVisible();
    expect(stub.calls).toHaveLength(2);
  });

  it('renders Unicode customer data without internal fields', async () => {
    const unicodeMenu = structuredClone(MENU);
    unicodeMenu.categories[0]!.name = 'Grønnsaker';
    unicodeMenu.categories[0]!.items[0]!.name = 'Kjøtt og løk';
    unicodeMenu.categories[0]!.items[0]!.allergens = ['Łódź fixture'];
    installFetchStub({ json: unicodeMenu });

    renderMenu();

    expect(
      await screen.findByRole('heading', { level: 2, name: 'Grønnsaker' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Kjøtt og løk')).toBeInTheDocument();
    expect(screen.getByText('Łódź fixture')).toBeInTheDocument();
    expect(screen.queryByText(/cost_amount/i)).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Add to cart' })).toHaveLength(2);
  });

  it('uses a local placeholder for an unsafe image protocol', async () => {
    const unsafeImageMenu = structuredClone(MENU);
    unsafeImageMenu.categories[0]!.items[0]!.image_url = 'javascript:alert(1)';
    installFetchStub({ json: unsafeImageMenu });

    renderMenu();

    expect(
      await screen.findByRole('img', { name: 'Seasonal bowl image unavailable' }),
    ).toHaveTextContent('Image unavailable');
    expect(screen.queryByAltText('Seasonal bowl')).not.toBeInTheDocument();
  });

  it('replaces a broken HTTP image with the local placeholder', async () => {
    installFetchStub({ json: MENU });
    renderMenu();
    const image = await screen.findByRole('img', { name: 'Seasonal bowl' });

    expect(image).toHaveAttribute('loading', 'lazy');
    fireEvent.error(image);

    expect(
      screen.getByRole('img', { name: 'Seasonal bowl image unavailable' }),
    ).toBeInTheDocument();
  });

  it('adds an available item and updates the cart count', async () => {
    const user = userEvent.setup();
    installFetchStub({ json: MENU });
    renderMenu();
    const card = await screen.findByRole('article', { name: 'Seasonal bowl' });

    await user.click(within(card).getByRole('button', { name: 'Add to cart' }));

    expect(screen.getByText('1 item in cart')).toBeInTheDocument();
    expect(within(card).getByText('1 in cart')).toBeInTheDocument();
    expect(within(card).getByRole('status')).toHaveTextContent(
      'Seasonal bowl added to cart.',
    );
  });

  it('merges repeated adds into one line with an incremented quantity', async () => {
    const user = userEvent.setup();
    installFetchStub({ json: MENU });
    renderMenu();
    const card = await screen.findByRole('article', { name: 'Seasonal bowl' });
    const addButton = within(card).getByRole('button', { name: 'Add to cart' });

    await user.click(addButton);
    await user.click(addButton);

    expect(screen.getByText('2 items in cart')).toBeInTheDocument();
    expect(screen.getByText('1 dish')).toBeInTheDocument();
    expect(within(card).getByText('2 in cart')).toBeInTheDocument();
  });

  it('does not allow an unavailable item to be added', async () => {
    installFetchStub({ json: MENU });
    renderMenu();
    const card = await screen.findByRole('article', { name: 'Evening special' });

    expect(within(card).getByRole('button', { name: 'Unavailable' })).toBeDisabled();
    expect(screen.getByText('0 items in cart')).toBeInTheDocument();
  });

  it('announces the quantity limit without mutating the cart', async () => {
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        items: [{ menuItemId: MENU.categories[0]!.items[0]!.id, quantity: 99 }],
        version: 1,
      }),
    );
    const user = userEvent.setup();
    installFetchStub({ json: MENU });
    renderMenu();
    const card = await screen.findByRole('article', { name: 'Seasonal bowl' });

    await user.click(within(card).getByRole('button', { name: 'Add to cart' }));

    expect(within(card).getByRole('status')).toHaveTextContent(
      'maximum quantity of 99',
    );
    expect(screen.getByText('99 items in cart')).toBeInTheDocument();
  });

  it('announces the 50-item limit without adding a 51st line', async () => {
    sessionStorage.setItem(
      CART_STORAGE_KEY,
      JSON.stringify({
        items: Array.from({ length: 50 }, (_, index) => ({
          menuItemId: `00000000-0000-4000-8000-${(index + 100)
            .toString(16)
            .padStart(12, '0')}`,
          quantity: 1,
        })),
        version: 1,
      }),
    );
    const user = userEvent.setup();
    installFetchStub({ json: MENU });
    renderMenu();
    const card = await screen.findByRole('article', { name: 'Seasonal bowl' });

    await user.click(within(card).getByRole('button', { name: 'Add to cart' }));

    expect(within(card).getByRole('status')).toHaveTextContent(
      'maximum of 50 different items',
    );
    expect(screen.getByText('50 dishes')).toBeInTheDocument();
  });

  it('links the cart summary to the cart route', async () => {
    installFetchStub({ json: MENU });
    renderMenu();

    expect(await screen.findByRole('link', { name: 'View cart' })).toHaveAttribute(
      'href',
      '/cart',
    );
  });
});
