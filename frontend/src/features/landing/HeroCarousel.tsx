import { useEffect, useRef, useState } from 'react';

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
  const [activeIndex, setActiveIndex] = useState(0);
  const [playing, setPlaying] = useState(() => !prefersReducedMotion());
  const [focusPaused, setFocusPaused] = useState(false);
  const [pointerPaused, setPointerPaused] = useState(false);
  const [carouselVisible, setCarouselVisible] = useState(true);
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
    const carousel = carouselRef.current;
    if (carousel === null || typeof window.IntersectionObserver !== 'function') {
      return undefined;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        setCarouselVisible(entry?.isIntersecting ?? false);
      },
      { threshold: 0.01 },
    );
    observer.observe(carousel);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (
      !playing ||
      focusPaused ||
      pointerPaused ||
      !documentVisible ||
      !carouselVisible
    ) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % HERO_SLIDES.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [carouselVisible, documentVisible, focusPaused, playing, pointerPaused]);

  const togglePlayback = (): void => {
    // An explicit click or keyboard choice overrides passive hover/focus pauses.
    setFocusPaused(false);
    setPointerPaused(false);
    setPlaying((current) => !current);
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
            <figcaption className={styles.caption} id={`hero-slide-caption-${index}`}>
              <span>{slide.caption}</span>
              <strong>{slide.title}</strong>
            </figcaption>
          </figure>
        ))}
      </div>
      <button
        aria-describedby={`hero-slide-caption-${activeIndex}`}
        aria-label={playing ? 'Pause automatic slideshow' : 'Start automatic slideshow'}
        className={styles.mediaControl}
        type="button"
        onClick={togglePlayback}
      />
    </section>
  );
}
