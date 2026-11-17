import { act, fireEvent, render, screen } from '@testing-library/react';

import HeroCarousel from './HeroCarousel';

function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({
      addEventListener: vi.fn(),
      matches,
      removeEventListener: vi.fn(),
    }),
  });
}

function preparePendingImage(
  image: HTMLImageElement,
  decode: () => Promise<void> = () => Promise.resolve(),
): void {
  Object.defineProperties(image, {
    complete: { configurable: true, value: false },
    decode: { configurable: true, value: vi.fn(decode) },
    naturalHeight: { configurable: true, value: 0 },
    naturalWidth: { configurable: true, value: 0 },
  });
}

async function loadPreparedImage(image: HTMLImageElement): Promise<void> {
  Object.defineProperties(image, {
    complete: { configurable: true, value: true },
    naturalHeight: { configurable: true, value: 640 },
    naturalWidth: { configurable: true, value: 1024 },
  });
  await act(async () => {
    fireEvent.load(image);
    await Promise.resolve();
  });
}

async function finishCrossfade(image: HTMLImageElement): Promise<void> {
  await loadPreparedImage(image);
  const slide = image.closest('figure');
  if (slide === null) {
    throw new Error('Expected the image to belong to a carousel slide.');
  }
  fireEvent.transitionEnd(slide, { propertyName: 'opacity' });
}

function getImageByAlt(name: string): HTMLImageElement {
  const image = screen.getByAltText(name);
  if (!(image instanceof HTMLImageElement)) {
    throw new Error(`Expected "${name}" to resolve to an image.`);
  }
  return image;
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

  it('prioritizes only the first image and exposes six labelled dot buttons', () => {
    const { container } = render(<HeroCarousel />);
    const images = container.querySelectorAll('img');
    const indicators = screen.getAllByRole('button', { name: /^Show image /u });

    expect(images).toHaveLength(6);
    expect(images[0]).toHaveAttribute('loading', 'eager');
    expect(images[0]).toHaveAttribute('fetchpriority', 'high');
    for (const image of [...images].slice(1)) {
      expect(image).toHaveAttribute('loading', 'lazy');
    }
    expect(container.querySelectorAll('img[fetchpriority=high]')).toHaveLength(1);
    expect(indicators).toHaveLength(6);
    expect(indicators[0]).toHaveAttribute('aria-current', 'true');
    for (const indicator of indicators.slice(1)) {
      expect(indicator).not.toHaveAttribute('aria-current');
    }
    expect(screen.queryByText('Reduced motion enabled')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /(?:Pause|Resume) slideshow/u }),
    ).not.toBeInTheDocument();
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

  it('keeps the current layer visible until a clicked image decodes and fades in', async () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const fourthImage = getImageByAlt(
      'A guest browsing a digital menu on a phone beside a plated meal',
    );
    const fourthIndicator = screen.getByRole('button', {
      name: 'Show image 4 of 6: The menu in your hand',
    });
    preparePendingImage(fourthImage);

    fourthIndicator.focus();
    fireEvent.click(fourthIndicator);

    expect(fourthIndicator).toHaveFocus();
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();
    expect(fourthImage.closest('figure')).toHaveAttribute(
      'data-carousel-slide-state',
      'pending',
    );
    await finishCrossfade(fourthImage);

    expect(screen.getByRole('group', { name: '4 of 6' })).toBeVisible();
    expect(fourthIndicator).toHaveAttribute('aria-current', 'true');
    expect(fourthIndicator).toHaveFocus();
  });

  it('starts a full five-second cycle after selection while focus stays on the dot', async () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const fourthImage = getImageByAlt(
      'A guest browsing a digital menu on a phone beside a plated meal',
    );
    const fifthImage = getImageByAlt(
      'A takeaway order in paper packaging ready at the restaurant counter',
    );
    const fourthIndicator = screen.getByRole('button', {
      name: 'Show image 4 of 6: The menu in your hand',
    });
    preparePendingImage(fourthImage);
    preparePendingImage(fifthImage);

    fourthIndicator.focus();
    fireEvent.click(fourthIndicator);
    await finishCrossfade(fourthImage);

    act(() => vi.advanceTimersByTime(4_999));
    expect(screen.getByRole('group', { name: '4 of 6' })).toBeVisible();
    expect(fifthImage.closest('figure')).toHaveAttribute('hidden');

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole('group', { name: '4 of 6' })).toBeVisible();
    expect(fifthImage.closest('figure')).toHaveAttribute(
      'data-carousel-slide-state',
      'pending',
    );
    await finishCrossfade(fifthImage);

    expect(screen.getByRole('group', { name: '5 of 6' })).toBeVisible();
    expect(fourthIndicator).toHaveFocus();
  });

  it('supports keyboard dot selection and keeps reduced motion manual-only', async () => {
    installMatchMedia(true);
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const sixthImage = getImageByAlt(
      'A red Norwegian cabin surrounded by autumn woodland',
    );
    const firstIndicator = screen.getByRole('button', {
      name: 'Show image 1 of 6: Care in every detail',
    });
    const sixthIndicator = screen.getByRole('button', {
      name: 'Show image 6 of 6: Inspired by Nordic seasons',
    });
    preparePendingImage(sixthImage);

    firstIndicator.focus();
    fireEvent.keyDown(firstIndicator, { key: 'End' });
    expect(sixthIndicator).toHaveFocus();
    await loadPreparedImage(sixthImage);

    expect(screen.getByRole('group', { name: '6 of 6' })).toBeVisible();
    act(() => vi.advanceTimersByTime(20_000));
    expect(screen.getByRole('group', { name: '6 of 6' })).toBeVisible();
    expect(sixthIndicator).toHaveAttribute('data-running', 'false');
  });

  it('lets the last rapid selection win after an earlier decode resolves', async () => {
    let resolveFourthDecode: (() => void) | undefined;
    const fourthDecode = new Promise<void>((resolve) => {
      resolveFourthDecode = resolve;
    });
    render(<HeroCarousel />);
    const fourthImage = getImageByAlt(
      'A guest browsing a digital menu on a phone beside a plated meal',
    );
    const fifthImage = getImageByAlt(
      'A takeaway order in paper packaging ready at the restaurant counter',
    );
    preparePendingImage(fourthImage, () => fourthDecode);
    preparePendingImage(fifthImage);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show image 4 of 6: The menu in your hand',
      }),
    );
    await loadPreparedImage(fourthImage);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show image 5 of 6: From kitchen to pickup',
      }),
    );
    await finishCrossfade(fifthImage);
    await act(async () => {
      resolveFourthDecode?.();
      await fourthDecode;
    });

    expect(screen.getByRole('group', { name: '5 of 6' })).toBeVisible();
  });

  it('keeps the displayed slide when the requested image fails', () => {
    render(<HeroCarousel />);
    const secondImage = getImageByAlt(
      'A candlelit Nordic dining room with a fireplace and set tables',
    );
    preparePendingImage(secondImage);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'Show image 2 of 6: A warm Nordic welcome',
      }),
    );
    fireEvent.error(secondImage);

    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();
    expect(secondImage.closest('figure')).toHaveAttribute('hidden');
  });

  it('pauses while the document is hidden and starts a fresh cycle when visible', async () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const secondImage = getImageByAlt(
      'A candlelit Nordic dining room with a fireplace and set tables',
    );
    preparePendingImage(secondImage);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(4_999));
    expect(secondImage.closest('figure')).toHaveAttribute('hidden');
    act(() => vi.advanceTimersByTime(1));
    await finishCrossfade(secondImage);
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();
  });

  it('pauses outside the viewport and disconnects its observer on unmount', async () => {
    vi.useFakeTimers();
    const observer = installIntersectionObserver();
    const { unmount } = render(<HeroCarousel />);
    const secondImage = getImageByAlt(
      'A candlelit Nordic dining room with a fireplace and set tables',
    );
    preparePendingImage(secondImage);

    expect(observer.observe).toHaveBeenCalledOnce();
    act(() => observer.emit(false));
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByRole('group', { name: '1 of 6' })).toBeVisible();

    act(() => observer.emit(true));
    act(() => vi.advanceTimersByTime(5_000));
    await finishCrossfade(secondImage);
    expect(screen.getByRole('group', { name: '2 of 6' })).toBeVisible();

    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
