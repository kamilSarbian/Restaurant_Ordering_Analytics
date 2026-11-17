import { useEffect, useRef, useState, type CSSProperties } from 'react';

import styles from './HeroCarousel.module.css';

const SLIDE_INTERVAL_MS = 5_000;
const HERO_IMAGE_SIZES = '(min-width: 64rem) 34rem, calc(100vw - 2rem)';
const INDICATOR_TIMING_STYLE = {
  '--carousel-indicator-duration': `${SLIDE_INTERVAL_MS}ms`,
} as CSSProperties;

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
    alt: 'A chef plating seared cod with herbs in a warm restaurant kitchen',
    caption: 'Kitchen craft',
    height: 887,
    src: '/images/brand/carousel/chef-plating-at-pass.png',
    srcSet:
      '/images/brand/optimized/carousel/chef-plating-at-pass-640w.webp 640w, /images/brand/optimized/carousel/chef-plating-at-pass-1024w.webp 1024w, /images/brand/optimized/carousel/chef-plating-at-pass-1774w.webp 1774w',
    title: 'Care in every detail',
    width: 1774,
  },
  {
    alt: 'A candlelit Nordic dining room with a fireplace and set tables',
    caption: 'Evening atmosphere',
    height: 887,
    src: '/images/brand/carousel/candlelit-dining-room.png',
    srcSet:
      '/images/brand/optimized/carousel/candlelit-dining-room-640w.webp 640w, /images/brand/optimized/carousel/candlelit-dining-room-1024w.webp 1024w, /images/brand/optimized/carousel/candlelit-dining-room-1774w.webp 1774w',
    title: 'A warm Nordic welcome',
    width: 1774,
  },
  {
    alt: 'A Nordic-inspired meal arranged with a cloudberry drink on an oak table',
    caption: 'Gather around',
    height: 887,
    src: '/images/brand/carousel/nordic-oak-table-feast.png',
    srcSet:
      '/images/brand/optimized/carousel/nordic-oak-table-feast-640w.webp 640w, /images/brand/optimized/carousel/nordic-oak-table-feast-1024w.webp 1024w, /images/brand/optimized/carousel/nordic-oak-table-feast-1774w.webp 1774w',
    title: 'A table made for sharing',
    width: 1774,
  },
  {
    alt: 'A guest browsing a digital menu on a phone beside a plated meal',
    caption: 'Browse at your pace',
    height: 1024,
    src: '/images/brand/story/customer-mobile-ordering.png',
    srcSet:
      '/images/brand/optimized/carousel/customer-mobile-ordering-640w.webp 640w, /images/brand/optimized/carousel/customer-mobile-ordering-1024w.webp 1024w, /images/brand/optimized/carousel/customer-mobile-ordering-1536w.webp 1536w',
    title: 'The menu in your hand',
    width: 1536,
  },
  {
    alt: 'A takeaway order in paper packaging ready at the restaurant counter',
    caption: 'Ready when you are',
    height: 1024,
    src: '/images/brand/story/order-ready-pickup.png',
    srcSet:
      '/images/brand/optimized/carousel/order-ready-pickup-640w.webp 640w, /images/brand/optimized/carousel/order-ready-pickup-1024w.webp 1024w, /images/brand/optimized/carousel/order-ready-pickup-1536w.webp 1536w',
    title: 'From kitchen to pickup',
    width: 1536,
  },
  {
    alt: 'A red Norwegian cabin surrounded by autumn woodland',
    caption: 'Rooted in Norway',
    height: 1024,
    src: '/images/brand/story/norwegian-hytte.png',
    srcSet:
      '/images/brand/optimized/carousel/norwegian-hytte-640w.webp 640w, /images/brand/optimized/carousel/norwegian-hytte-1024w.webp 1024w, /images/brand/optimized/carousel/norwegian-hytte-1536w.webp 1536w',
    title: 'Inspired by Nordic seasons',
    width: 1536,
  },
] as const;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}

/** Render an automatically rotating showcase of Nordic Hearth imagery. */
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
    const mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (mediaQuery === undefined) {
      return undefined;
    }
    const handleChange = (event: MediaQueryListEvent): void => {
      if (event.matches) {
        setPlaying(false);
      }
    };
    mediaQuery.addEventListener?.('change', handleChange);
    return () => mediaQuery.removeEventListener?.('change', handleChange);
  }, []);

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

  const rotationActive =
    playing && !focusPaused && !pointerPaused && documentVisible && carouselVisible;

  useEffect(() => {
    if (!rotationActive) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % HERO_SLIDES.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [rotationActive]);

  const togglePlayback = (): void => {
    // An explicit choice overrides passive pointer and focus pauses.
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
                sizes={HERO_IMAGE_SIZES}
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
                sizes={HERO_IMAGE_SIZES}
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
      <div
        aria-hidden="true"
        className={styles.indicators}
        style={INDICATOR_TIMING_STYLE}
      >
        {HERO_SLIDES.map((slide, index) => {
          const active = index === activeIndex;
          return (
            <span
              className={styles.indicator}
              data-active={active ? 'true' : 'false'}
              data-carousel-indicator="true"
              data-running={active && rotationActive ? 'true' : 'false'}
              key={slide.src}
            >
              <span className={styles.indicatorFill} />
            </span>
          );
        })}
      </div>
      <button
        aria-describedby={`hero-slide-caption-${activeIndex}`}
        className={styles.mediaControl}
        onClick={togglePlayback}
        type="button"
      >
        {playing ? 'Pause slideshow' : 'Resume slideshow'}
      </button>
    </section>
  );
}
