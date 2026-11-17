import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type TransitionEvent,
} from 'react';

import styles from './HeroCarousel.module.css';

const SLIDE_INTERVAL_MS = 5_000;
const SLIDE_TRANSITION_MS = 300;
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

interface PendingSlide {
  index: number;
  requestId: number;
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
  const [displayedIndex, setDisplayedIndex] = useState(0);
  const [pendingSlide, setPendingSlide] = useState<PendingSlide | null>(null);
  const [revealedIndex, setRevealedIndex] = useState<number | null>(null);
  const [rotationEpoch, setRotationEpoch] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(prefersReducedMotion);
  const [carouselVisible, setCarouselVisible] = useState(true);
  const [documentVisible, setDocumentVisible] = useState(
    () => document.visibilityState !== 'hidden',
  );
  const carouselRef = useRef<HTMLElement>(null);
  const imageRefs = useRef<Array<HTMLImageElement | null>>([]);
  const indicatorRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const requestSequenceRef = useRef(0);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (mediaQuery === undefined) {
      return undefined;
    }
    const handleChange = (event: MediaQueryListEvent): void => {
      setReducedMotion(event.matches);
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

  const commitPendingSlide = useCallback((requestId: number, index: number): void => {
    if (requestSequenceRef.current !== requestId) {
      return;
    }
    setDisplayedIndex(index);
    setPendingSlide(null);
    setRevealedIndex(null);
    setRotationEpoch((current) => current + 1);
  }, []);

  const requestSlide = useCallback(
    (index: number): void => {
      const requestId = requestSequenceRef.current + 1;
      requestSequenceRef.current = requestId;
      setRevealedIndex(null);

      if (index === displayedIndex) {
        setPendingSlide(null);
        setRotationEpoch((current) => current + 1);
        return;
      }

      setPendingSlide({ index, requestId });
    },
    [displayedIndex],
  );

  useEffect(() => {
    if (pendingSlide === null) {
      return undefined;
    }

    const { index, requestId } = pendingSlide;
    const image = imageRefs.current[index];
    if (image === null || image === undefined) {
      return undefined;
    }

    let cancelled = false;
    let decodeStarted = false;

    const abandonPendingSlide = (): void => {
      if (cancelled || requestSequenceRef.current !== requestId) {
        return;
      }
      setPendingSlide(null);
      setRevealedIndex(null);
      setRotationEpoch((current) => current + 1);
    };

    const revealDecodedSlide = async (): Promise<void> => {
      if (decodeStarted) {
        return;
      }
      decodeStarted = true;

      try {
        if (typeof image.decode === 'function') {
          await image.decode();
        }
      } catch {
        abandonPendingSlide();
        return;
      }

      if (
        cancelled ||
        requestSequenceRef.current !== requestId ||
        image.naturalWidth <= 0 ||
        image.naturalHeight <= 0
      ) {
        abandonPendingSlide();
        return;
      }

      if (reducedMotion) {
        commitPendingSlide(requestId, index);
        return;
      }
      setRevealedIndex(index);
    };

    const handleLoad = (): void => {
      void revealDecodedSlide();
    };
    const handleError = (): void => abandonPendingSlide();

    image.addEventListener('load', handleLoad);
    image.addEventListener('error', handleError);
    if (image.complete) {
      if (image.naturalWidth > 0 && image.naturalHeight > 0) {
        void revealDecodedSlide();
      } else if (image.currentSrc !== '') {
        abandonPendingSlide();
      }
    }

    return () => {
      cancelled = true;
      image.removeEventListener('load', handleLoad);
      image.removeEventListener('error', handleError);
    };
  }, [commitPendingSlide, pendingSlide, reducedMotion]);

  useEffect(() => {
    if (pendingSlide === null || revealedIndex !== pendingSlide.index) {
      return undefined;
    }
    if (reducedMotion) {
      commitPendingSlide(pendingSlide.requestId, pendingSlide.index);
      return undefined;
    }

    const fallbackTimer = window.setTimeout(
      () => commitPendingSlide(pendingSlide.requestId, pendingSlide.index),
      SLIDE_TRANSITION_MS + 50,
    );
    return () => window.clearTimeout(fallbackTimer);
  }, [commitPendingSlide, pendingSlide, reducedMotion, revealedIndex]);

  const rotationActive =
    !reducedMotion &&
    documentVisible &&
    carouselVisible &&
    pendingSlide === null &&
    revealedIndex === null;

  useEffect(() => {
    if (!rotationActive) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      requestSlide((displayedIndex + 1) % HERO_SLIDES.length);
    }, SLIDE_INTERVAL_MS);
    return () => window.clearTimeout(timer);
  }, [displayedIndex, requestSlide, rotationActive, rotationEpoch]);

  const handleIndicatorKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ): void => {
    let targetIndex: number | null = null;
    if (event.key === 'ArrowLeft') {
      targetIndex = (index - 1 + HERO_SLIDES.length) % HERO_SLIDES.length;
    } else if (event.key === 'ArrowRight') {
      targetIndex = (index + 1) % HERO_SLIDES.length;
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = HERO_SLIDES.length - 1;
    }

    if (targetIndex === null) {
      return;
    }
    event.preventDefault();
    indicatorRefs.current[targetIndex]?.focus();
    requestSlide(targetIndex);
  };

  const handleTransitionEnd = (
    event: TransitionEvent<HTMLElement>,
    index: number,
  ): void => {
    if (
      event.propertyName !== 'opacity' ||
      pendingSlide === null ||
      pendingSlide.index !== index ||
      revealedIndex !== index
    ) {
      return;
    }
    commitPendingSlide(pendingSlide.requestId, index);
  };

  return (
    <section
      aria-label="Nordic Hearth highlights"
      aria-roledescription="carousel"
      className={styles.carousel}
      ref={carouselRef}
    >
      <div className={styles.slides} aria-live="off">
        {HERO_SLIDES.map((slide, index) => {
          const current = index === displayedIndex;
          const pending = index === pendingSlide?.index;
          const revealed = pending && index === revealedIndex;
          const mounted = current || pending;

          return (
            <figure
              aria-hidden={pending ? true : undefined}
              aria-label={`${index + 1} of ${HERO_SLIDES.length}`}
              aria-roledescription="slide"
              className={`${styles.slide} ${current ? styles.currentSlide : ''} ${pending ? styles.pendingSlide : ''} ${revealed ? styles.revealedSlide : ''}`}
              data-carousel-slide-state={
                current
                  ? 'current'
                  : revealed
                    ? 'revealed'
                    : pending
                      ? 'pending'
                      : 'idle'
              }
              hidden={!mounted}
              key={slide.src}
              onTransitionEnd={(event) => handleTransitionEnd(event, index)}
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
                  ref={(element) => {
                    imageRefs.current[index] = element;
                  }}
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
          );
        })}
      </div>
      <div
        aria-label="Choose carousel image"
        className={styles.indicators}
        role="group"
        style={INDICATOR_TIMING_STYLE}
      >
        {HERO_SLIDES.map((slide, index) => {
          const active = index === displayedIndex;
          return (
            <button
              aria-current={active ? 'true' : undefined}
              aria-describedby={`hero-slide-caption-${index}`}
              aria-label={`Show image ${index + 1} of ${HERO_SLIDES.length}: ${slide.title}`}
              className={styles.indicatorButton}
              data-active={active ? 'true' : 'false'}
              data-carousel-indicator="true"
              data-running={active && rotationActive ? 'true' : 'false'}
              key={slide.src}
              onClick={() => requestSlide(index)}
              onKeyDown={(event) => handleIndicatorKeyDown(event, index)}
              ref={(element) => {
                indicatorRefs.current[index] = element;
              }}
              type="button"
            >
              <span className={styles.indicator}>
                <span
                  className={styles.indicatorFill}
                  key={active ? `${slide.src}-${rotationEpoch}` : slide.src}
                />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
