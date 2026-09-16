import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { CartProvider } from '../cart/CartContext';
import { CART_STORAGE_KEY } from '../cart/cartStorage';
import {
  MENU_IMAGE_CATALOG,
  MENU_IMAGE_SIZES,
  getCatalogMenuImageAsset,
  getCatalogMenuImageUrl,
  getSafeMenuImageUrl,
  isSafeLocalMenuImageUrl,
  resolveMenuImage,
  resolveMenuImageUrl,
} from './menuImageCatalog';
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

const EXPECTED_MENU_IMAGE_CATALOG = {
  '372b82fc-dd0c-465e-ae9a-7b585d03f7c7':
    '/images/menu/starters/Roasted-Root-Vegetable-Soup.png',
  '9a5225fd-c749-4d26-99d6-965267b0ce26':
    '/images/menu/starters/Smoked-Salmon-Toast.png',
  '90bec893-ece6-40bb-886e-45e1a640f980':
    '/images/menu/starters/Crispy-Cauliflower.png',
  'e3fd81c3-0fe6-4e7a-8e1d-2fdf413222ff':
    '/images/menu/main_courses/Pan-Seared-Cod.png',
  'f870c8df-510e-43a4-8b69-e8b6d5e5db2c':
    '/images/menu/main_courses/Nordic-Chicken-Plate.png',
  'a10c4ba3-57a3-43da-8be7-c2d52ab1e7fa':
    '/images/menu/main_courses/Mushroom-Barley-Bowl.png',
  '9933957b-7f5d-47d8-84c3-ba8ad21b2d8c':
    '/images/menu/burgers/Classic-Beef-Burger.png',
  '34157d9d-2123-4e75-acde-4f513da73bcb': '/images/menu/burgers/Fjord-Fish-Burger.png',
  'e7aafb70-8bbd-4280-bdba-bd503dc884ac': '/images/menu/burgers/Plant-Burger.png',
  '95abd9ff-dea5-48fa-aa81-0632fb5caef7': '/images/menu/desserts/Warm-Apple-Cake.png',
  'c0ec6110-60ab-49bf-bc6f-13eda579fb1a':
    '/images/menu/desserts/Dark-Chocolate-Mousse.png',
  'f6448f8c-db21-4096-903a-facafc5a729c':
    '/images/menu/desserts/Vanilla-Panna-Cotta.png',
  'c496b9cc-268c-4549-9e36-e8225e57561f':
    '/images/menu/non_alcohol_drinks/Cloudberry-Spritz.png',
  '99655656-bab2-4844-8557-6d73d1d4c07a':
    '/images/menu/non_alcohol_drinks/Norwegian-Apple-Juice.png',
  'a80988ed-27ae-4470-a768-25109a16963a':
    '/images/menu/non_alcohol_drinks/Sparkling-Water.png',
};

const FULL_MENU_CATEGORY_NAMES = [
  'Starters',
  'Main courses',
  'Burgers',
  'Desserts',
  'Non-alcoholic drinks',
];

const FULL_MENU_ITEM_NAMES = [
  'Roasted Root Vegetable Soup',
  'Smoked Salmon Toast',
  'Crispy Cauliflower',
  'Pan Seared Cod',
  'Nordic Chicken Plate',
  'Mushroom Barley Bowl',
  'Classic Beef Burger',
  'Fjord Fish Burger',
  'Plant Burger',
  'Warm Apple Cake',
  'Dark Chocolate Mousse',
  'Vanilla Panna Cotta',
  'Cloudberry Spritz',
  'Norwegian Apple Juice',
  'Sparkling Water',
];

const FULL_MENU = {
  categories: FULL_MENU_CATEGORY_NAMES.map((categoryName, categoryIndex) => ({
    id: '10000000-0000-4000-8000-' + String(categoryIndex + 1).padStart(12, '0'),
    name: categoryName,
    description: 'Synthetic category description.',
    display_order: (categoryIndex + 1) * 10,
    items: Object.keys(EXPECTED_MENU_IMAGE_CATALOG)
      .slice(categoryIndex * 3, categoryIndex * 3 + 3)
      .map((itemId, itemIndex) => {
        const absoluteItemIndex = categoryIndex * 3 + itemIndex;
        return {
          id: itemId,
          name: FULL_MENU_ITEM_NAMES[absoluteItemIndex],
          description:
            absoluteItemIndex === 4
              ? 'A deliberately long synthetic description that proves menu copy remains readable and contained inside the card at every supported viewport.'
              : 'Synthetic menu description.',
          image_url: null,
          price_amount:
            absoluteItemIndex === 13 ? 99_999_900 : 10000 + absoluteItemIndex * 137,
          currency: 'NOK',
          allergens: absoluteItemIndex % 2 === 0 ? [] : ['milk', 'gluten'],
          display_order: (itemIndex + 1) * 10,
          is_available: absoluteItemIndex !== 14,
        };
      }),
  })),
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

describe('menu image catalog', () => {
  it('contains the exact deeply immutable 15-item responsive UUID mapping', () => {
    expect(Object.keys(MENU_IMAGE_CATALOG)).toEqual(
      Object.keys(EXPECTED_MENU_IMAGE_CATALOG),
    );
    expect(Object.keys(MENU_IMAGE_CATALOG)).toHaveLength(15);
    expect(Object.isFrozen(MENU_IMAGE_CATALOG)).toBe(true);

    for (const [menuItemId, pngSrc] of Object.entries(EXPECTED_MENU_IMAGE_CATALOG)) {
      const asset = getCatalogMenuImageAsset(menuItemId);
      if (asset === null) {
        throw new Error(`Missing catalog asset for ${menuItemId}`);
      }
      const relativeStem = pngSrc.slice('/images/menu/'.length).replace(/\.png$/u, '');
      const optimizedBase = `/images/menu/optimized/${relativeStem}`;
      const webp480Src = `${optimizedBase}-480w.webp`;
      const webp720Src = `${optimizedBase}-720w.webp`;
      const webp1080Src = `${optimizedBase}-1080w.webp`;

      expect(asset).toEqual({
        aspectRatio: '4 / 3',
        height: 1086,
        pngSrc,
        webp1080Src,
        webp480Src,
        webp720Src,
        webpSrcSet: `${webp480Src} 480w, ${webp720Src} 720w, ${webp1080Src} 1080w`,
        width: 1448,
      });
      expect(Object.isFrozen(asset)).toBe(true);
      expect(getCatalogMenuImageUrl(menuItemId)).toBe(pngSrc);
    }
  });

  it('returns no catalog image for unknown or inherited property names', () => {
    expect(getCatalogMenuImageAsset('00000000-0000-4000-8000-000000000099')).toBeNull();
    expect(getCatalogMenuImageAsset('constructor')).toBeNull();
    expect(getCatalogMenuImageAsset('__proto__')).toBeNull();
    expect(getCatalogMenuImageUrl('00000000-0000-4000-8000-000000000099')).toBeNull();
    expect(getCatalogMenuImageUrl('constructor')).toBeNull();
    expect(getCatalogMenuImageUrl('__proto__')).toBeNull();
  });

  it.each([
    'https://images.example.test/api-dish.jpg',
    'http://images.example.test/api-dish.jpg',
  ])('keeps the valid API URL ahead of the local catalog: %s', (imageUrl) => {
    expect(resolveMenuImageUrl('372b82fc-dd0c-465e-ae9a-7b585d03f7c7', imageUrl)).toBe(
      imageUrl,
    );
    expect(resolveMenuImage('372b82fc-dd0c-465e-ae9a-7b585d03f7c7', imageUrl)).toEqual({
      kind: 'single',
      src: imageUrl,
    });
  });

  it('uses the catalog for a missing or invalid API URL', () => {
    const menuItemId = '372b82fc-dd0c-465e-ae9a-7b585d03f7c7';
    const catalogUrl = '/images/menu/starters/Roasted-Root-Vegetable-Soup.png';

    expect(resolveMenuImageUrl(menuItemId, null)).toBe(catalogUrl);
    expect(resolveMenuImageUrl(menuItemId, 'javascript:alert(1)')).toBe(catalogUrl);
    expect(resolveMenuImage(menuItemId, 'javascript:alert(1)')).toEqual({
      asset: MENU_IMAGE_CATALOG[menuItemId],
      kind: 'responsive',
    });
  });

  it('uses responsive delivery only for the UUID matching its exact catalog PNG', () => {
    const menuItemId = '372b82fc-dd0c-465e-ae9a-7b585d03f7c7';
    const catalogUrl = '/images/menu/starters/Roasted-Root-Vegetable-Soup.png';
    const otherSafeLocalUrl = '/images/menu/starters/Seasonal-Dish.png';
    const otherCatalogUrl = '/images/menu/starters/Smoked-Salmon-Toast.png';

    expect(resolveMenuImage(menuItemId, catalogUrl)).toEqual({
      asset: MENU_IMAGE_CATALOG[menuItemId],
      kind: 'responsive',
    });
    expect(resolveMenuImage(menuItemId, otherSafeLocalUrl)).toEqual({
      kind: 'single',
      src: otherSafeLocalUrl,
    });
    expect(resolveMenuImage(menuItemId, otherCatalogUrl)).toEqual({
      kind: 'single',
      src: otherCatalogUrl,
    });
  });

  it('accepts only confined same-origin local menu paths', () => {
    const imageUrl = '/images/menu/starters/Seasonal-Dish.png';

    expect(isSafeLocalMenuImageUrl(imageUrl)).toBe(true);
    expect(getSafeMenuImageUrl(imageUrl)).toBe(imageUrl);
    expect(resolveMenuImageUrl('00000000-0000-4000-8000-000000000099', imageUrl)).toBe(
      imageUrl,
    );
    expect(resolveMenuImage('00000000-0000-4000-8000-000000000099', imageUrl)).toEqual({
      kind: 'single',
      src: imageUrl,
    });
  });

  it.each([
    ['empty menu path', '/images/menu/'],
    ['path traversal', '/images/menu/../private.png'],
    ['encoded traversal', '/images/menu/%2e%2e/private.png'],
    ['double-encoded traversal', '/images/menu/%252e%252e/private.png'],
    ['protocol-relative URL', '//images/menu/starters/dish.png'],
    ['backslash', '/images/menu/starters\\dish.png'],
    ['query string', '/images/menu/starters/dish.png?size=large'],
    ['fragment', '/images/menu/starters/dish.png#detail'],
    ['outside root', '/images/private/dish.png'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['data scheme', 'data:image/png;base64,AAAA'],
    ['blob scheme', 'blob:https://example.test/id'],
    ['file scheme', 'file:///images/menu/starters/dish.png'],
  ])('rejects an unsafe local image URL: %s', (_label, imageUrl) => {
    expect(isSafeLocalMenuImageUrl(imageUrl)).toBe(false);
    expect(getSafeMenuImageUrl(imageUrl)).toBeNull();
  });
});

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
    ).toEqual(['Browse categories', 'Main dishes', 'Desserts']);
    expect(
      screen
        .getAllByRole('article')
        .map(
          (article) => within(article).getByRole('heading', { level: 3 }).textContent,
        ),
    ).toEqual(['Seasonal bowl', 'Evening special', 'Apple cake']);
  });

  it('renders the complete 15-item menu hierarchy and presentation contracts', async () => {
    installFetchStub({ json: FULL_MENU });

    renderMenu();

    await screen.findByRole('heading', {
      level: 3,
      name: FULL_MENU_ITEM_NAMES[0],
    });

    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(['Browse categories', ...FULL_MENU_CATEGORY_NAMES]);
    expect(screen.getAllByRole('article')).toHaveLength(15);

    for (const categoryName of FULL_MENU_CATEGORY_NAMES) {
      const heading = screen.getByRole('heading', { level: 2, name: categoryName });
      const section = heading.closest('section');
      expect(section).not.toBeNull();
      if (section === null) {
        throw new Error('Category heading must belong to its labelled section.');
      }
      expect(section).toHaveAttribute('aria-labelledby', heading.id);
      expect(within(section).getAllByRole('article')).toHaveLength(3);
      expect(within(section).getAllByRole('heading', { level: 3 })).toHaveLength(3);
    }

    const categoryNavigation = screen.getByRole('navigation', {
      name: 'Menu categories',
    });
    expect(within(categoryNavigation).getAllByRole('button')).toHaveLength(6);
    expect(
      within(categoryNavigation).getByRole('button', { name: 'All' }),
    ).toHaveAttribute('aria-pressed', 'true');

    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(15);
    expect(images.map((image) => image.getAttribute('alt'))).toEqual(
      FULL_MENU_ITEM_NAMES,
    );
    expect(document.querySelectorAll('picture > img')).toHaveLength(15);
    expect(document.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);
    expect(images[0]).toHaveAttribute('loading', 'eager');
    for (const image of images.slice(1)) {
      expect(image).toHaveAttribute('loading', 'lazy');
      expect(image).not.toHaveAttribute('fetchpriority');
    }

    expect(screen.getByText(/^100,00\s+kr$/u)).toBeInTheDocument();
    const widePriceCard = screen.getByRole('article', {
      name: 'Norwegian Apple Juice',
    });
    expect(within(widePriceCard).getByText(/^999\s999,00\s+kr$/u)).toBeInTheDocument();

    const unavailableCard = screen.getByRole('article', {
      name: 'Sparkling Water',
    });
    expect(within(unavailableCard).getByText('Temporarily unavailable')).toBeVisible();
    expect(
      within(unavailableCard).getByRole('button', { name: 'Unavailable' }),
    ).toBeDisabled();
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
    const stub = installFetchStub({ json: MENU });
    renderMenu();
    await screen.findByRole('heading', { level: 2, name: 'Main dishes' });

    const categoryNavigation = screen.getByRole('navigation', {
      name: 'Menu categories',
    });
    const allButton = within(categoryNavigation).getByRole('button', { name: 'All' });
    const dessertsButton = within(categoryNavigation).getByRole('button', {
      name: 'Desserts',
    });
    expect(allButton).toHaveAttribute('aria-pressed', 'true');
    expect(dessertsButton).toHaveAttribute('aria-controls', 'menu-category-list');

    dessertsButton.focus();
    expect(dessertsButton).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Main dishes' }),
    ).not.toBeInTheDocument();
    expect(dessertsButton).toHaveAttribute('aria-pressed', 'true');

    await user.click(allButton);
    expect(
      screen.getByRole('heading', { level: 2, name: 'Main dishes' }),
    ).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: 'Desserts' })).toBeVisible();
    expect(stub.calls).toHaveLength(1);
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

  it.each([
    'https://images.example.test/roasted-soup.jpg',
    '/images/menu/starters/Seasonal-Dish.png',
  ])('keeps a valid API image as one non-responsive img: %s', async (imageUrl) => {
    const apiImageMenu = structuredClone(MENU);
    Object.assign(apiImageMenu.categories[0]!.items[0]!, {
      id: '372b82fc-dd0c-465e-ae9a-7b585d03f7c7',
      image_url: imageUrl,
      name: 'Roasted Root Vegetable Soup',
    });
    installFetchStub({ json: apiImageMenu });

    renderMenu();

    const image = await screen.findByRole('img', {
      name: 'Roasted Root Vegetable Soup',
    });
    expect(image).toHaveAttribute('src', imageUrl);
    expect(image.closest('picture')).toBeNull();
    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveAttribute('fetchpriority', 'high');
  });

  it('assigns priority only to the first rendered card and updates after filtering', async () => {
    const user = userEvent.setup();
    const imageMenu = structuredClone(MENU);
    imageMenu.categories[0]!.items[1]!.image_url =
      'https://images.example.test/evening-special.jpg';
    Object.assign(imageMenu.categories[1]!.items[0]!, {
      id: '95abd9ff-dea5-48fa-aa81-0632fb5caef7',
      image_url: null,
    });
    installFetchStub({ json: imageMenu });
    renderMenu();

    const firstImage = await screen.findByRole('img', { name: 'Seasonal bowl' });
    const secondImage = screen.getByRole('img', { name: 'Evening special' });
    const thirdImage = screen.getByRole('img', { name: 'Apple cake' });

    expect(firstImage).toHaveAttribute('loading', 'eager');
    expect(firstImage).toHaveAttribute('fetchpriority', 'high');
    for (const image of [secondImage, thirdImage]) {
      expect(image).toHaveAttribute('loading', 'lazy');
      expect(image).not.toHaveAttribute('fetchpriority');
    }
    expect(thirdImage.closest('picture')).not.toBeNull();
    expect(document.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Desserts' }));

    const filteredFirstImage = screen.getByRole('img', { name: 'Apple cake' });
    expect(filteredFirstImage).toHaveAttribute('loading', 'eager');
    expect(filteredFirstImage).toHaveAttribute('fetchpriority', 'high');
    expect(document.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);
    expect(screen.queryByAltText('Seasonal bowl')).not.toBeInTheDocument();
  });

  it('renders a responsive catalog picture with exact sources and PNG fallback', async () => {
    const localImageMenu = structuredClone(MENU);
    Object.assign(localImageMenu.categories[0]!.items[0]!, {
      id: '372b82fc-dd0c-465e-ae9a-7b585d03f7c7',
      image_url: 'javascript:alert(1)',
      name: 'Roasted Root Vegetable Soup',
    });
    installFetchStub({ json: localImageMenu });

    renderMenu();

    const image = await screen.findByRole('img', {
      name: 'Roasted Root Vegetable Soup',
    });
    expect(image).toHaveAttribute(
      'src',
      '/images/menu/starters/Roasted-Root-Vegetable-Soup.png',
    );
    expect(image).toHaveAttribute('width', '1448');
    expect(image).toHaveAttribute('height', '1086');
    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveAttribute('fetchpriority', 'high');
    expect(image).toHaveAttribute('decoding', 'async');

    const picture = image.closest('picture');
    const source = picture?.querySelector('source') ?? null;
    expect(picture).not.toBeNull();
    expect(source).toHaveAttribute('type', 'image/webp');
    expect(source).toHaveAttribute(
      'srcset',
      '/images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-480w.webp 480w, /images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-720w.webp 720w, /images/menu/optimized/starters/Roasted-Root-Vegetable-Soup-1080w.webp 1080w',
    );
    expect(MENU_IMAGE_SIZES).toBe(
      '(min-width: 76rem) calc(23.167rem - 2px), (min-width: 64rem) calc(33.333vw - 2.167rem - 2px), (min-width: 48rem) calc(50vw - 2.625rem - 2px), (min-width: 40rem) calc(50vw - 1.625rem - 2px), calc(100vw - 2rem - 2px)',
    );
    expect(source).toHaveAttribute('sizes', MENU_IMAGE_SIZES);

    fireEvent.error(image);
    expect(
      screen.getByRole('img', {
        name: 'Roasted Root Vegetable Soup image unavailable',
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByAltText('Roasted Root Vegetable Soup'),
    ).not.toBeInTheDocument();
  });

  it('replaces a broken HTTP image with the local placeholder', async () => {
    installFetchStub({ json: MENU });
    renderMenu();
    const image = await screen.findByRole('img', { name: 'Seasonal bowl' });

    expect(image).toHaveAttribute('loading', 'eager');
    expect(image).toHaveAttribute('fetchpriority', 'high');
    fireEvent.error(image);

    expect(
      screen.getByRole('img', { name: 'Seasonal bowl image unavailable' }),
    ).toBeInTheDocument();
    expect(screen.queryByAltText('Seasonal bowl')).not.toBeInTheDocument();
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
      'Seasonal bowl added to cart. Quantity is 1.',
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
    expect(within(card).getByRole('status')).toHaveTextContent(
      'Seasonal bowl added to cart. Quantity is 2.',
    );
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

    const cartLinks = await screen.findAllByRole('link', { name: 'View cart' });
    expect(cartLinks).toHaveLength(1);
    expect(cartLinks[0]).toHaveAttribute('href', '/cart');
  });
});
