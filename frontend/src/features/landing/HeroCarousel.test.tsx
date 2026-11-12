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

  it('prioritizes only the first image without visible slideshow controls', () => {
    const { container } = render(<HeroCarousel />);
    const images = container.querySelectorAll('img');

    expect(images).toHaveLength(3);
    expect(images[0]).toHaveAttribute('loading', 'eager');
    expect(images[0]).toHaveAttribute('fetchpriority', 'high');
    expect(images[1]).toHaveAttribute('loading', 'lazy');
    expect(images[2]).toHaveAttribute('loading', 'lazy');
    expect(
      screen.queryByRole('button', { name: 'Previous image' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Next image' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText('Reduced motion enabled')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Pause automatic slideshow' }),
    ).toBeVisible();
  });

  it('keeps all three image and caption contracts stable', () => {
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
        alt: 'A candlelit dining table set with Nordic-inspired dishes',
        height: '941',
        width: '1672',
      },
      { alt: 'A chef finishing a Nordic plate', height: '1024', width: '1536' },
      {
        alt: 'A Nordic Hearth takeaway order ready for pickup',
        height: '1024',
        width: '1536',
      },
    ]);
    expect(container.querySelectorAll('figcaption')).toHaveLength(3);
    expect(container).toHaveTextContent('Seasonal dining');
    expect(container).toHaveTextContent('Warmth at the table');
    expect(container).toHaveTextContent('Made with care');
    expect(container).toHaveTextContent('From kitchen to table');
    expect(container).toHaveTextContent('Order with confidence');
    expect(container).toHaveTextContent('From cart to pickup');
  });

  it('rotates every seven seconds and lets the image pause or resume it', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);

    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic slideshow' }));
    act(() => vi.advanceTimersByTime(14_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Start automatic slideshow' }));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '3 of 3' })).toBeVisible();
  });

  it('resumes actual rotation from the hidden control while the pointer remains inside', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const carousel = screen.getByRole('region', {
      name: 'Nordic Hearth highlights',
    });

    fireEvent.mouseEnter(carousel);
    fireEvent.click(screen.getByRole('button', { name: 'Pause automatic slideshow' }));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Start automatic slideshow' }));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
  });

  it('starts static for reduced motion and honors explicit keyboard start and pause', async () => {
    installMatchMedia(true);
    const intervalSpy = vi.spyOn(window, 'setInterval');
    const user = userEvent.setup();
    render(<HeroCarousel />);

    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();
    expect(intervalSpy).not.toHaveBeenCalled();

    const control = screen.getByRole('button', {
      name: 'Start automatic slideshow',
    });
    act(() => control.focus());
    await user.keyboard('{Enter}');
    expect(control).toHaveFocus();
    expect(intervalSpy).toHaveBeenCalledWith(expect.any(Function), 7_000);
    const intervalCallback = intervalSpy.mock.calls.at(-1)?.[0];
    if (typeof intervalCallback !== 'function') {
      throw new Error('Expected the slideshow interval callback to be registered.');
    }
    act(() => intervalCallback());
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();

    await user.keyboard('[Space]');
    expect(
      screen.getByRole('button', { name: 'Start automatic slideshow' }),
    ).toHaveFocus();
  });

  it('pauses automatic movement during pointer interaction', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const carousel = screen.getByRole('region', {
      name: 'Nordic Hearth highlights',
    });

    fireEvent.mouseEnter(carousel);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.mouseLeave(carousel);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
  });

  it('pauses automatic movement while keyboard focus remains inside', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const control = screen.getByRole('button', {
      name: 'Pause automatic slideshow',
    });

    fireEvent.focus(control);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.blur(control, { relatedTarget: null });
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
  });

  it('stays paused when the pointer leaves while focus remains inside', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const carousel = screen.getByRole('region', {
      name: 'Nordic Hearth highlights',
    });
    const control = screen.getByRole('button', {
      name: 'Pause automatic slideshow',
    });

    fireEvent.mouseEnter(carousel);
    fireEvent.focus(control);
    fireEvent.mouseLeave(carousel);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.blur(control, { relatedTarget: null });
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
  });

  it('pauses while the document is hidden and resumes when visible', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    fireEvent(document, new Event('visibilitychange'));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
  });

  it('pauses outside the viewport and disconnects its observer on unmount', () => {
    vi.useFakeTimers();
    const observer = installIntersectionObserver();
    const { unmount } = render(<HeroCarousel />);

    expect(observer.observe).toHaveBeenCalledOnce();
    act(() => observer.emit(false));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    act(() => observer.emit(true));
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();

    unmount();
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
});
