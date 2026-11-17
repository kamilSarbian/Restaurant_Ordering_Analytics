import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import HeroCarousel from './HeroCarousel';

function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches }),
  });
}

function installIntersectionObserver() {
  let callback: IntersectionObserverCallback | null = null;
  const disconnect = vi.fn();
  const observe = vi.fn();

  class MockIntersectionObserver {
    constructor(nextCallback: IntersectionObserverCallback) {
      callback = nextCallback;
    }

    disconnect = disconnect;
    observe = observe;
    takeRecords = vi.fn().mockReturnValue([]);
    unobserve = vi.fn();
  }

  vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);

  return {
    disconnect,
    emit(isIntersecting: boolean): void {
      if (callback === null) {
        throw new Error('Expected the carousel observer to be registered.');
      }
      callback(
        [{ isIntersecting } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    },
    observe,
  };
}

describe('HeroCarousel', () => {
  beforeEach(() => installMatchMedia(false));

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('prioritizes only the first image and exposes one visible playback control', () => {
    const { container } = render(<HeroCarousel />);
    const images = container.querySelectorAll('img');

    expect(images).toHaveLength(6);
    expect(images[0]).toHaveAttribute('loading', 'eager');
    expect(images[0]).toHaveAttribute('fetchpriority', 'high');
    for (const image of [...images].slice(1)) {
      expect(image).toHaveAttribute('loading', 'lazy');
    }
    expect(container.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'Previous image' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Next image' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Reduced motion enabled')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause slideshow' })).toBeVisible();
    expect(container.querySelectorAll('button, a')).toHaveLength(1);
    expect(container.querySelectorAll('[data-carousel-indicator]')).toHaveLength(6);
  });

  it('keeps the first slide responsive image candidates and sizing contract stable', () => {
    const { container } = render(<HeroCarousel />);
    const firstImage = screen.getByRole('img', {
      name: 'A chef plating seared cod with herbs in a warm restaurant kitchen',
    });
    const firstSource = firstImage.closest('picture')?.querySelector('source');
    const expectedSizes = '(min-width: 64rem) 34rem, calc(100vw - 2rem)';

    expect(firstImage).toHaveAttribute(
      'src',
      '/images/brand/carousel/chef-plating-at-pass.png',
    );
    expect(firstImage).toHaveAttribute('sizes', expectedSizes);
    expect(firstImage).toHaveAttribute('width', '1774');
    expect(firstImage).toHaveAttribute('height', '887');
    expect(firstSource).toHaveAttribute('type', 'image/webp');
    expect(firstSource).toHaveAttribute('sizes', expectedSizes);
    expect(firstSource).toHaveAttribute(
      'srcset',
      [
        '/images/brand/optimized/carousel/chef-plating-at-pass-640w.webp 640w',
        '/images/brand/optimized/carousel/chef-plating-at-pass-1024w.webp 1024w',
        '/images/brand/optimized/carousel/chef-plating-at-pass-1774w.webp 1774w',
      ].join(', '),
    );
    expect(container.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);
  });

  it('keeps all six image and truthful caption contracts stable', () => {
    const { container } = render(<HeroCarousel />);
    const images = [...container.querySelectorAll('img')];

    expect(
      images.map((image) => ({
        alt: image.getAttribute('alt'),
        height: image.getAttribute('height'),
        width: image.getAttribute('width'),
      })),
    ).toEqual([
      {
        alt: 'A chef plating seared cod with herbs in a warm restaurant kitchen',
        height: '887',
        width: '1774',
      },
      {
        alt: 'A candlelit Nordic dining room with a fireplace and set tables',
        height: '887',
        width: '1774',
      },
      {
        alt: 'A Nordic-inspired meal arranged with a cloudberry drink on an oak table',
        height: '887',
        width: '1774',
      },
      {
        alt: 'A guest browsing a digital menu on a phone beside a plated meal',
        height: '1024',
        width: '1536',
      },
      {
        alt: 'A takeaway order in paper packaging ready at the restaurant counter',
        height: '1024',
        width: '1536',
      },
      {
        alt: 'A red Norwegian cabin surrounded by autumn woodland',
        height: '1024',
        width: '1536',
      },
    ]);
    expect(container.querySelectorAll('figcaption')).toHaveLength(6);
    for (const text of [
      'Kitchen craft',
      'Care in every detail',
      'Evening atmosphere',
      'A warm Nordic welcome',
      'Gather around',
      'A table made for sharing',
      'Browse at your pace',
      'The menu in your hand',
      'Ready when you are',
      'From kitchen to pickup',
      'Rooted in Norway',
      'Inspired by Nordic seasons',
    ]) {
      expect(container).toHaveTextContent(text);
    }
  });

  it('rotates every five seconds and advances the active progress dot', () => {
    vi.useFakeTimers();
    const { container } = render(<HeroCarousel />);
    const indicators = container.querySelectorAll('[data-carousel-indicator]');
    const indicatorGroup = container.querySelector<HTMLElement>('[aria-hidden="true"]');

    expect(
      indicatorGroup?.style.getPropertyValue('--carousel-indicator-duration'),
    ).toBe('5000ms');
    expect(indicators[0]).toHaveAttribute('data-active', 'true');
    expect(indicators[0]).toHaveAttribute('data-running', 'true');
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();
    expect(indicators[0]).toHaveAttribute('data-active', 'false');
    expect(indicators[1]).toHaveAttribute('data-active', 'true');
    expect(indicators[1]).toHaveAttribute('data-running', 'true');
  });

  it('keeps a manual pause after pointer exit and resumes while still hovered', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const carousel = screen.getByRole('region', {
      name: 'Nordic Hearth highlights',
    });

    fireEvent.mouseEnter(carousel);
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Pause slideshow' }));
    fireEvent.mouseLeave(carousel);
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();

    fireEvent.mouseEnter(carousel);
    fireEvent.click(screen.getByRole('button', { name: 'Resume slideshow' }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();
  });

  it('supports keyboard pause and resume while focus remains inside', async () => {
    const user = userEvent.setup();
    render(<HeroCarousel />);

    await user.tab();
    expect(screen.getByRole('button', { name: 'Pause slideshow' })).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Resume slideshow' })).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Pause slideshow' })).toHaveFocus();
  });

  it('starts paused for reduced motion and rotates only after explicit resume', () => {
    installMatchMedia(true);
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const { container } = render(<HeroCarousel />);

    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();
    expect(intervalSpy).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-carousel-indicator][data-active=true]'),
    ).toHaveAttribute('data-running', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Resume slideshow' }));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();
  });

  it('pauses while the document is hidden and resumes when visible', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();
  });

  it('pauses outside the viewport and disconnects its observer on unmount', () => {
    vi.useFakeTimers();
    const observer = installIntersectionObserver();
    const { unmount } = render(<HeroCarousel />);

    expect(observer.observe).toHaveBeenCalledOnce();
    act(() => observer.emit(false));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();

    act(() => observer.emit(true));
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();

    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
