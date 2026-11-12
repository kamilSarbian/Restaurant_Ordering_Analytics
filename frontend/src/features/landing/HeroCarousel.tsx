import { useEffect, useRef, useState, type KeyboardEvent } from 'react';

import styles from './HeroCarousel.module.css';

const SLIDE_INTERVAL_MS = 7_000;

interface HeroSlide {
  alt: string;
  caption: string;
  height: number;
  src: string;
  srcSet: string;
  title: string;
  width: number;
}

const HERO_SLIDES: readonly HeroSlide[] = [
  {
    alt: 'A candlelit dining table set with Nordic-inspired dishes',
    caption: 'Seasonal dining',
    height: 941,
    src: '/images/brand/hero/restaurant-hero.png',
    srcSet:
      '/images/brand/optimized/hero/restaurant-hero-640w.webp 640w, /images/brand/optimized/hero/restaurant-hero-1024w.webp 1024w, /images/brand/optimized/hero/restaurant-hero-1600w.webp 1600w',
    title: 'Warmth at the table',
    width: 1672,
  },
  {
    alt: 'A chef finishing a Nordic plate',
    caption: 'Made with care',
    height: 1024,
    src: '/images/brand/story/chef-plating-cod.png',
    srcSet:
      '/images/brand/optimized/story/chef-plating-cod-640w.webp 640w, /images/brand/optimized/story/chef-plating-cod-1024w.webp 1024w',
    title: 'From kitchen to table',
    width: 1536,
  },
  {
    alt: 'A Nordic Hearth takeaway order ready for pickup',
    caption: 'Order with confidence',
    height: 1024,
    src: '/images/brand/story/order-ready-pickup.png',
    srcSet:
      '/images/brand/optimized/story/order-ready-pickup-640w.webp 640w, /images/brand/optimized/story/order-ready-pickup-1024w.webp 1024w',
    title: 'From cart to pickup',
    width: 1536,
  },
] as const;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Render an accessible, lightweight showcase of existing Nordic Hearth images. */
export default function HeroCarousel() {
  const reducedMotion = prefersReducedMotion();
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(reducedMotion);
  const [focusPaused, setFocusPaused] = useState(false);
  const [pointerPaused, setPointerPaused] = useState(false);
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  const carouselRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleVisibilityChange = (): void => {
      setDocumentVisible(document.visibilityState !== 'hidden');
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () =>
      document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (paused || focusPaused || pointerPaused || !documentVisible || reducedMotion) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % HERO_SLIDES.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [documentVisible, focusPaused, paused, pointerPaused, reducedMotion]);

  const showSlide = (index: number): void => {
    setActiveIndex((index + HERO_SLIDES.length) % HERO_SLIDES.length);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      showSlide(activeIndex - 1);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      showSlide(activeIndex + 1);
    }
  };

  return (
    <section
      aria-label="Nordic Hearth highlights"
      aria-roledescription="carousel"
      className={styles.carousel}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocusPaused(false);
        }
      }}
      onFocus={() => setFocusPaused(true)}
      onKeyDown={handleKeyDown}
      onMouseEnter={() => setPointerPaused(true)}
      onMouseLeave={() => setPointerPaused(false)}
      ref={carouselRef}
    >
      <div className={styles.slides} aria-live="off">
        {HERO_SLIDES.map((slide, index) => (
          <figure
            aria-label={`${index + 1} of ${HERO_SLIDES.length}`}
            aria-roledescription="slide"
            className={styles.slide}
            hidden={index !== activeIndex}
            key={slide.src}
            role="group"
          >
            <picture>
              <source
                sizes="(min-width: 64rem) 36rem, calc(100vw - 2rem)"
                srcSet={slide.srcSet}
                type="image/webp"
              />
              <img
                alt={slide.alt}
                className={styles.image}
                decoding="async"
                fetchPriority={index === 0 ? 'high' : undefined}
                height={slide.height}
                loading={index === 0 ? 'eager' : 'lazy'}
                sizes="(min-width: 64rem) 36rem, calc(100vw - 2rem)"
                src={slide.src}
                width={slide.width}
              />
            </picture>
            <figcaption className={styles.caption}>
              <span>{slide.caption}</span>
              <strong>{slide.title}</strong>
            </figcaption>
          </figure>
        ))}
      </div>
      <div className={styles.controls} aria-label="Slideshow controls">
        <button
          aria-label="Previous image"
          className={styles.control}
          type="button"
          onClick={() => showSlide(activeIndex - 1)}
        >
          Previous
        </button>
        <div className={styles.dots} aria-label="Choose image">
          {HERO_SLIDES.map((slide, index) => (
            <button
              aria-label={`Show image ${index + 1}: ${slide.title}`}
              aria-pressed={activeIndex === index}
              className={styles.dot}
              key={slide.src}
              type="button"
              onClick={() => showSlide(index)}
            >
              <span aria-hidden="true">{index + 1}</span>
            </button>
          ))}
        </div>
        <button
          aria-label="Next image"
          className={styles.control}
          type="button"
          onClick={() => showSlide(activeIndex + 1)}
        >
          Next
        </button>
        <button
          aria-label={reducedMotion ? 'Automatic slideshow disabled' : undefined}
          aria-pressed={reducedMotion ? undefined : paused}
          className={styles.control}
          disabled={reducedMotion}
          type="button"
          onClick={() => setPaused((current) => !current)}
        >
          {reducedMotion
            ? 'Reduced motion enabled'
            : paused
              ? 'Resume slideshow'
              : 'Pause slideshow'}
        </button>
      </div>
    </section>
  );
}
