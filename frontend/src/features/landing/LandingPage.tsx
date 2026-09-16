import { Link } from 'react-router-dom';

import BrandMark from '../../components/branding/BrandMark';
import { useAuth } from '../auth/AuthContext';
import styles from './LandingPage.module.css';

const LANDING_LOGO_IMAGE_SIZES = '(min-width: 48rem) 18rem, min(72vw, 18rem)';
const LANDING_HERO_IMAGE_SIZES =
  '(min-width: 76rem) calc(36rem - 1px), (min-width: 64rem) calc(50vw - 2rem - 1px), (min-width: 48rem) calc(100vw - 4rem - 2px), calc(100vw - 2rem - 2px)';
const LANDING_STORY_IMAGE_SIZES =
  '(min-width: 64rem) 28rem, (min-width: 48rem) 40vw, calc(100vw - 2rem)';

const brandLogo = {
  height: 724,
  pngSrc: '/images/brand/logo/nordic-hearth-logo.png',
  webpSrcSet:
    '/images/brand/optimized/logo/nordic-hearth-logo-320w.webp 320w, /images/brand/optimized/logo/nordic-hearth-logo-640w.webp 640w',
  width: 2172,
} as const;

const heroImage = {
  height: 941,
  pngSrc: '/images/brand/hero/restaurant-hero.png',
  webpSrcSet:
    '/images/brand/optimized/hero/restaurant-hero-640w.webp 640w, /images/brand/optimized/hero/restaurant-hero-1024w.webp 1024w, /images/brand/optimized/hero/restaurant-hero-1600w.webp 1600w',
  width: 1672,
} as const;

const storyImage = {
  height: 1024,
  pngSrc: '/images/brand/story/chef-plating-cod.png',
  webpSrcSet:
    '/images/brand/optimized/story/chef-plating-cod-640w.webp 640w, /images/brand/optimized/story/chef-plating-cod-1024w.webp 1024w',
  width: 1536,
} as const;

const CURATED_MENU_PREVIEW = [
  { category: 'Main Courses', name: 'Pan-Seared Cod' },
  { category: 'Desserts', name: 'Warm Apple Cake' },
  { category: 'Drinks', name: 'Cloudberry Spritz' },
] as const;

/** Present the public ordering entry point without assuming an auth identity. */
export default function LandingPage() {
  const { logout, phase, retrySession, user } = useAuth();
  const canOpenAdmin = user?.role === 'admin' || user?.role === 'super_admin';

  return (
    <div className={styles.page}>
      <section className={styles.hero} aria-labelledby={'landing-heading'}>
        <div className={styles.heroCopy}>
          <div className={styles.brandLockup}>
            <picture className={styles.logoPicture}>
              <source
                sizes={LANDING_LOGO_IMAGE_SIZES}
                srcSet={brandLogo.webpSrcSet}
                type={'image/webp'}
              />
              <img
                alt={'Nordic Hearth'}
                className={styles.fullLogo}
                decoding={'async'}
                height={brandLogo.height}
                loading={'eager'}
                sizes={LANDING_LOGO_IMAGE_SIZES}
                src={brandLogo.pngSrc}
                width={brandLogo.width}
              />
            </picture>
            <span className={styles.brandDescriptor}>A Nordic-inspired table</span>
          </div>

          <div className={styles.copy}>
            <p className={styles.eyebrow}>Norwegian-inspired seasonal dishes</p>
            <h1 className={styles.heroTitle} id={'landing-heading'}>
              Fresh food, ordered your way
            </h1>
            <p className={styles.introduction}>
              Explore starters, main courses, burgers, desserts, and non-alcoholic
              drinks, then order in a few clear steps.
            </p>
          </div>

          <nav className={styles.actions} aria-label={'Start ordering'}>
            <Link className={styles.primaryAction} to={'/menu'}>
              View menu
            </Link>
            {phase === 'unauthenticated' && (
              <>
                <Link className={styles.secondaryAction} to={'/login'}>
                  Log in
                </Link>
                <Link className={styles.tertiaryAction} to={'/register'}>
                  Create account
                </Link>
              </>
            )}
          </nav>

          {phase === 'checking-session' && (
            <div className={styles.sessionNotice} role={'status'} aria-live={'polite'}>
              <strong>Checking your saved session</strong>
              <span>Your account options will appear after validation.</span>
            </div>
          )}

          {phase === 'temporarily-unavailable' && (
            <div
              className={styles.sessionNotice}
              role={'alert'}
              aria-live={'assertive'}
            >
              <strong>Session validation is unavailable</strong>
              <span>Your saved session has not been removed.</span>
              <div className={styles.accountActions}>
                <button
                  className={styles.secondaryButton}
                  type={'button'}
                  onClick={() => void retrySession()}
                >
                  Retry validation
                </button>
                <button
                  className={styles.tertiaryButton}
                  type={'button'}
                  onClick={logout}
                >
                  Clear session
                </button>
              </div>
            </div>
          )}

          {phase === 'authenticated' && user !== null && (
            <div className={styles.authenticatedActions}>
              <p>
                Signed in as <strong>{user.email}</strong>
              </p>
              <div className={styles.accountActions}>
                {canOpenAdmin && (
                  <Link className={styles.secondaryAction} to={'/admin'}>
                    Admin
                  </Link>
                )}
                <button
                  className={styles.tertiaryButton}
                  type={'button'}
                  onClick={logout}
                >
                  Log out
                </button>
              </div>
            </div>
          )}
        </div>

        <figure className={styles.heroMedia}>
          <picture className={styles.heroPicture}>
            <source
              sizes={LANDING_HERO_IMAGE_SIZES}
              srcSet={heroImage.webpSrcSet}
              type={'image/webp'}
            />
            <img
              alt={'A candlelit dining table set with Nordic-inspired dishes'}
              className={styles.heroImage}
              decoding={'async'}
              fetchPriority={'high'}
              height={heroImage.height}
              loading={'eager'}
              sizes={LANDING_HERO_IMAGE_SIZES}
              src={heroImage.pngSrc}
              width={heroImage.width}
            />
          </picture>
          <figcaption className={styles.heroCaption}>
            <span>Nordic atmosphere</span>
            <strong>Warmth at the table</strong>
            <span>Seasonal dining</span>
          </figcaption>
        </figure>
      </section>

      <section className={styles.menuStory} aria-labelledby={'menu-story-heading'}>
        <div className={styles.sectionCopy}>
          <p className={styles.eyebrow}>A seasonal glimpse</p>
          <h2 id={'menu-story-heading'}>A taste of the menu</h2>
          <p>
            A small editorial selection introduces the range of dishes. Open the menu to
            see the full current selection.
          </p>
          <Link className={styles.textAction} to={'/menu'}>
            Explore the full menu <span aria-hidden={true}>→</span>
          </Link>
          <picture className={styles.storyPicture}>
            <source
              sizes={LANDING_STORY_IMAGE_SIZES}
              srcSet={storyImage.webpSrcSet}
              type={'image/webp'}
            />
            <img
              alt={'A cook plating cod with greens'}
              className={styles.storyImage}
              decoding={'async'}
              height={storyImage.height}
              loading={'lazy'}
              sizes={LANDING_STORY_IMAGE_SIZES}
              src={storyImage.pngSrc}
              width={storyImage.width}
            />
          </picture>
        </div>

        <ul className={styles.menuPreview} aria-label={'Menu inspiration'}>
          {CURATED_MENU_PREVIEW.map((dish, index) => (
            <li key={dish.name}>
              <span className={styles.previewNumber} aria-hidden={true}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <div>
                <h3>{dish.name}</h3>
                <p>{dish.category}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className={styles.orderingStory} aria-labelledby={'ordering-heading'}>
        <div className={styles.sectionCopy}>
          <p className={styles.eyebrow}>Simple by design</p>
          <h2 id={'ordering-heading'}>One clear path from menu to order</h2>
          <p>
            Take your time with the menu, keep your choices together, and follow the
            order from one familiar place.
          </p>
        </div>

        <ol className={styles.steps}>
          <li>
            <span aria-hidden={true}>01</span>
            <div>
              <h3>Browse the menu</h3>
              <p>Move through each category and see what is currently available.</p>
            </div>
          </li>
          <li>
            <span aria-hidden={true}>02</span>
            <div>
              <h3>Build your cart</h3>
              <p>Add the dishes you want and review your choices before ordering.</p>
            </div>
          </li>
          <li>
            <span aria-hidden={true}>03</span>
            <div>
              <h3>Follow your order</h3>
              <p>Place the order and return to its status as it moves forward.</p>
            </div>
          </li>
        </ol>
      </section>

      <section className={styles.finalCta} aria-labelledby={'final-cta-heading'}>
        <BrandMark className={styles.finalMark} size={48} />
        <div>
          <p className={styles.inverseEyebrow}>Ready to choose?</p>
          <h2 id={'final-cta-heading'}>Your next dish starts with the menu</h2>
          <p>Explore the full selection and build an order at your own pace.</p>
        </div>
        <Link className={styles.finalAction} to={'/menu'}>
          Open the menu
        </Link>
      </section>
    </div>
  );
}
