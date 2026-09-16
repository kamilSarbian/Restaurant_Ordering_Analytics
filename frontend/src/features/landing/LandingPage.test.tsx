import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { installFetchStub } from '../../test/fetchStub';
import { AuthProvider } from '../auth/AuthContext';
import {
  AUTH_STORAGE_KEY,
  LEGACY_AUTH_STORAGE_KEY,
  resetAuthMemoryForTests,
} from '../auth/authStorage';
import LandingPage from './LandingPage';

const TOKEN = 'synthetic-landing-token';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const LANDING_LOGO_IMAGE_SIZES = '(min-width: 48rem) 18rem, min(72vw, 18rem)';
const LANDING_HERO_IMAGE_SIZES =
  '(min-width: 76rem) calc(36rem - 1px), (min-width: 64rem) calc(50vw - 2rem - 1px), (min-width: 48rem) calc(100vw - 4rem - 2px), calc(100vw - 2rem - 2px)';
const LANDING_STORY_IMAGE_SIZES =
  '(min-width: 64rem) 28rem, (min-width: 48rem) 40vw, calc(100vw - 2rem)';

function currentUser(role: 'admin' | 'customer' | 'super_admin') {
  return {
    email: role + '@example.invalid',
    id: USER_ID,
    is_active: true,
    role,
  };
}

function storeToken(): void {
  sessionStorage.setItem(
    AUTH_STORAGE_KEY,
    JSON.stringify({ accessToken: TOKEN, version: 1 }),
  );
}

function renderLanding() {
  const router = createMemoryRouter(
    [
      {
        element: <AuthProvider />,
        children: [
          { path: '/', element: <LandingPage /> },
          { path: '/menu', element: <h1>Menu destination</h1> },
          { path: '/login', element: <h1>Login destination</h1> },
          { path: '/register', element: <h1>Register destination</h1> },
          { path: '/admin', element: <h1>Admin destination</h1> },
        ],
      },
    ],
    { initialEntries: ['/'] },
  );
  return { router, ...render(<RouterProvider router={router} />) };
}

afterEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  resetAuthMemoryForTests();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('LandingPage', () => {
  it('offers the public menu and account entry points without claiming an identity', () => {
    const fetchSpy = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchSpy);

    renderLanding();

    expect(
      screen.getByRole('heading', { level: 1, name: 'Fresh food, ordered your way' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'View menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login',
    );
    expect(screen.getByRole('link', { name: 'Create account' })).toHaveAttribute(
      'href',
      '/register',
    );
    expect(screen.queryByText(/my account/i)).not.toBeInTheDocument();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders a logical editorial hierarchy with restrained responsive branding', () => {
    const { container } = renderLanding();

    expect(container.querySelectorAll('h1')).toHaveLength(1);
    expect(
      screen
        .getAllByRole('heading', { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual([
      'A taste of the menu',
      'One clear path from menu to order',
      'Your next dish starts with the menu',
    ]);
    expect(
      [...container.querySelectorAll('h1, h2, h3')].map(
        (heading) => heading.textContent,
      ),
    ).toEqual([
      'Fresh food, ordered your way',
      'A taste of the menu',
      'Pan-Seared Cod',
      'Warm Apple Cake',
      'Cloudberry Spritz',
      'One clear path from menu to order',
      'Browse the menu',
      'Build your cart',
      'Follow your order',
      'Your next dish starts with the menu',
    ]);
    expect(
      screen.getByRole('region', { name: 'Fresh food, ordered your way' }),
    ).toBeVisible();
    expect(screen.getByRole('region', { name: 'A taste of the menu' })).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'One clear path from menu to order' }),
    ).toBeVisible();
    expect(
      screen.getByRole('region', { name: 'Your next dish starts with the menu' }),
    ).toBeVisible();
    const logo = screen.getByRole('img', { name: 'Nordic Hearth' });
    expect(logo).toBeVisible();
    expect(
      screen.queryByText('Nordic Hearth', { exact: true }),
    ).not.toBeInTheDocument();
    expect(screen.getByText('A Nordic-inspired table')).toBeVisible();
    const brandMarks = [...container.querySelectorAll('svg')];
    expect(brandMarks.length).toBeGreaterThan(0);
    for (const brandMark of brandMarks) {
      expect(brandMark).toHaveAttribute('aria-hidden', 'true');
      expect(brandMark).toHaveAttribute('focusable', 'false');
    }

    const previewItems = within(
      screen.getByRole('list', { name: 'Menu inspiration' }),
    ).getAllByRole('listitem');
    expect(previewItems).toHaveLength(3);
    for (const [index, expected] of [
      { category: 'Main Courses', name: 'Pan-Seared Cod' },
      { category: 'Desserts', name: 'Warm Apple Cake' },
      { category: 'Drinks', name: 'Cloudberry Spritz' },
    ].entries()) {
      const previewItem = previewItems[index];
      if (previewItem === undefined) {
        throw new Error('Expected editorial preview item is missing.');
      }
      expect(
        within(previewItem).getByRole('heading', {
          level: 3,
          name: expected.name,
        }),
      ).toBeVisible();
      expect(within(previewItem).getByText(expected.category)).toBeVisible();
    }

    expect(logo).toHaveAttribute('src', '/images/brand/logo/nordic-hearth-logo.png');
    expect(logo).toHaveAttribute('width', '2172');
    expect(logo).toHaveAttribute('height', '724');
    expect(logo).toHaveAttribute('decoding', 'async');
    expect(logo).toHaveAttribute('loading', 'eager');
    expect(logo).not.toHaveAttribute('fetchpriority');
    expect(logo).toHaveAttribute('sizes', LANDING_LOGO_IMAGE_SIZES);
    const logoSource = logo.closest('picture')?.querySelector('source');
    expect(logoSource).toHaveAttribute('type', 'image/webp');
    expect(logoSource).toHaveAttribute('sizes', LANDING_LOGO_IMAGE_SIZES);
    expect(logoSource).toHaveAttribute(
      'srcset',
      [
        '/images/brand/optimized/logo/nordic-hearth-logo-320w.webp 320w',
        '/images/brand/optimized/logo/nordic-hearth-logo-640w.webp 640w',
      ].join(', '),
    );

    const heroImage = screen.getByRole('img', {
      name: 'A candlelit dining table set with Nordic-inspired dishes',
    });
    expect(heroImage).toHaveAttribute('src', '/images/brand/hero/restaurant-hero.png');
    expect(heroImage).toHaveAttribute('width', '1672');
    expect(heroImage).toHaveAttribute('height', '941');
    expect(heroImage).toHaveAttribute('decoding', 'async');
    expect(heroImage).toHaveAttribute('loading', 'eager');
    expect(heroImage).toHaveAttribute('fetchpriority', 'high');
    expect(heroImage).toHaveAttribute('sizes', LANDING_HERO_IMAGE_SIZES);
    const heroSource = heroImage.closest('picture')?.querySelector('source');
    expect(heroSource).toHaveAttribute('type', 'image/webp');
    expect(heroSource).toHaveAttribute('sizes', LANDING_HERO_IMAGE_SIZES);
    expect(heroSource).toHaveAttribute(
      'srcset',
      [
        '/images/brand/optimized/hero/restaurant-hero-640w.webp 640w',
        '/images/brand/optimized/hero/restaurant-hero-1024w.webp 1024w',
        '/images/brand/optimized/hero/restaurant-hero-1600w.webp 1600w',
      ].join(', '),
    );

    const storyImage = screen.getByRole('img', {
      name: 'A cook plating cod with greens',
    });
    expect(storyImage).toHaveAttribute(
      'src',
      '/images/brand/story/chef-plating-cod.png',
    );
    expect(storyImage).toHaveAttribute('width', '1536');
    expect(storyImage).toHaveAttribute('height', '1024');
    expect(storyImage).toHaveAttribute('decoding', 'async');
    expect(storyImage).toHaveAttribute('loading', 'lazy');
    expect(storyImage).not.toHaveAttribute('fetchpriority');
    expect(storyImage).toHaveAttribute('sizes', LANDING_STORY_IMAGE_SIZES);
    const storySource = storyImage.closest('picture')?.querySelector('source');
    expect(storySource).toHaveAttribute('type', 'image/webp');
    expect(storySource).toHaveAttribute('sizes', LANDING_STORY_IMAGE_SIZES);
    expect(storySource).toHaveAttribute(
      'srcset',
      [
        '/images/brand/optimized/story/chef-plating-cod-640w.webp 640w',
        '/images/brand/optimized/story/chef-plating-cod-1024w.webp 1024w',
      ].join(', '),
    );

    expect(
      [...container.querySelectorAll('img')].map((image) => image.getAttribute('src')),
    ).toEqual([
      '/images/brand/logo/nordic-hearth-logo.png',
      '/images/brand/hero/restaurant-hero.png',
      '/images/brand/story/chef-plating-cod.png',
    ]);
    expect(container.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);
    expect(container.innerHTML).not.toMatch(
      /images\/brand\/(?:mockups|project-hero)\//u,
    );
    expect(container.innerHTML).not.toContain(
      '/images/brand/story/customer-mobile-ordering.png',
    );
  });

  it('uses the native hero link to open the existing menu route', async () => {
    const user = userEvent.setup();
    const { router } = renderLanding();

    await user.click(screen.getByRole('link', { name: 'View menu' }));

    expect(router.state.location.pathname).toBe('/menu');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Menu destination' }),
    ).toBeVisible();
  });

  it('contains no unsupported restaurant claims or technical customer copy', () => {
    const { container } = renderLanding();
    const visibleCopy = container.textContent ?? '';

    expect(visibleCopy).not.toMatch(
      /\b(?:api|authentic|award|backend|chef|database|delivery radius|founded|locally sourced|location|michelin|organic|rating|reservation|server|sustainable|testimonial|years)\b/iu,
    );
    expect(visibleCopy).not.toMatch(/\bopening hours\b/iu);
  });

  it('shows customer menu access and logout without anonymous or administrator actions', async () => {
    storeToken();
    installFetchStub({ json: currentUser('customer') });

    renderLanding();

    expect(await screen.findByText('customer@example.invalid')).toBeVisible();
    expect(screen.getByRole('link', { name: 'View menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.getByRole('button', { name: 'Log out' })).toBeEnabled();
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create account' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
    expect(screen.queryByText(/my account/i)).not.toBeInTheDocument();
  });

  it.each(['admin', 'super_admin'] as const)(
    'offers the administrator destination to %s',
    async (role) => {
      storeToken();
      installFetchStub({ json: currentUser(role) });

      renderLanding();

      expect(await screen.findByRole('link', { name: 'Admin' })).toHaveAttribute(
        'href',
        '/admin',
      );
    },
  );

  it('keeps menu access visible while a saved-session check is pending', async () => {
    storeToken();
    installFetchStub({ responsePromise: new Promise<Response>(() => undefined) });

    renderLanding();

    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checking your saved session',
    );
    expect(screen.getByRole('link', { name: 'View menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', { name: 'Create account' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Admin' })).not.toBeInTheDocument();
  });

  it('keeps an unavailable saved session retryable, clearable, and menu-safe', async () => {
    storeToken();
    const stub = installFetchStub({ status: 503 }, { json: currentUser('customer') });
    const user = userEvent.setup();

    renderLanding();

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Session validation is unavailable',
    );
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toContain(TOKEN);
    expect(screen.getByRole('link', { name: 'View menu' })).toHaveAttribute(
      'href',
      '/menu',
    );
    expect(screen.queryByRole('link', { name: 'Log in' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry validation' }));

    expect(await screen.findByText('customer@example.invalid')).toBeVisible();
    expect(stub.calls).toHaveLength(2);
  });

  it('logs out locally while preserving unrelated browser-session state', async () => {
    storeToken();
    sessionStorage.setItem(
      LEGACY_AUTH_STORAGE_KEY,
      JSON.stringify({ accessToken: 'synthetic-legacy-token', version: 1 }),
    );
    sessionStorage.setItem('restaurant-ordering:cart:v1', 'preserved-cart');
    installFetchStub({ json: currentUser('customer') });
    const user = userEvent.setup();

    renderLanding();
    await screen.findByText('customer@example.invalid');
    await user.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Log in' })).toBeVisible(),
    );
    expect(screen.getByRole('link', { name: 'View menu' })).toBeVisible();
    expect(sessionStorage.getItem(AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_AUTH_STORAGE_KEY)).toBeNull();
    expect(sessionStorage.getItem('restaurant-ordering:cart:v1')).toBe(
      'preserved-cart',
    );
  });
});
