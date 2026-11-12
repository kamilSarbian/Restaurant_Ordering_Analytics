import { act, fireEvent, render, screen } from '@testing-library/react';

import HeroCarousel from './HeroCarousel';

function installMatchMedia(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockReturnValue({ matches }),
  });
}

describe('HeroCarousel', () => {
  beforeEach(() => installMatchMedia(false));

  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    vi.useRealTimers();
  });

  it('prioritizes only the first image and exposes manual controls', () => {
    const { container } = render(<HeroCarousel />);
    const images = container.querySelectorAll('img');

    expect(images).toHaveLength(3);
    expect(images[0]).toHaveAttribute('loading', 'eager');
    expect(images[0]).toHaveAttribute('fetchpriority', 'high');
    expect(images[1]).toHaveAttribute('loading', 'lazy');
    expect(images[2]).toHaveAttribute('loading', 'lazy');

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByRole('group', { name: '2 of 3', hidden: false })).toBeVisible();
  });

  it('supports arrow-key navigation and pauses automatic movement', () => {
    render(<HeroCarousel />);
    const carousel = screen.getByRole('region', {
      name: 'Nordic Hearth highlights',
    });

    fireEvent.keyDown(carousel, { key: 'ArrowRight' });
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
    fireEvent.keyDown(carousel, { key: 'ArrowLeft' });
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    const pause = screen.getByRole('button', { name: 'Pause slideshow' });
    fireEvent.click(pause);
    expect(screen.getByRole('button', { name: 'Resume slideshow' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('keeps automatic motion disabled when reduced motion is requested', () => {
    vi.useFakeTimers();
    installMatchMedia(true);
    render(<HeroCarousel />);

    const automaticControl = screen.getByRole('button', {
      name: 'Automatic slideshow disabled',
    });
    expect(automaticControl).toBeDisabled();
    act(() => vi.advanceTimersByTime(14_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Next image' }));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
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
    const next = screen.getByRole('button', { name: 'Next image' });

    fireEvent.focus(next);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.blur(next, { relatedTarget: null });
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '2 of 3' })).toBeVisible();
  });

  it('stays paused when the pointer leaves while focus remains inside', () => {
    vi.useFakeTimers();
    render(<HeroCarousel />);
    const carousel = screen.getByRole('region', {
      name: 'Nordic Hearth highlights',
    });
    const next = screen.getByRole('button', { name: 'Next image' });

    fireEvent.mouseEnter(carousel);
    fireEvent.focus(next);
    fireEvent.mouseLeave(carousel);
    act(() => vi.advanceTimersByTime(7_000));
    expect(screen.getByRole('group', { name: '1 of 3' })).toBeVisible();

    fireEvent.blur(next, { relatedTarget: null });
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
});
