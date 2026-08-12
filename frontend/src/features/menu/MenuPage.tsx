import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiRequestError } from '../../api/client';
import { fetchMenu } from '../../api/customerApi';
import type { MenuResponse } from '../../api/types';
import AsyncNotice from '../../components/AsyncNotice';
import { useCart } from '../cart/CartContext';
import MenuCategorySection from './MenuCategorySection';
import styles from './MenuPage.module.css';

const ALL_CATEGORIES = 'all';

type MenuLoadState =
  | { status: 'error'; message: string }
  | { status: 'loaded'; menu: MenuResponse }
  | { status: 'loading' };

function getSafeErrorMessage(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.kind === 'timeout') {
      return 'The menu request took too long. Please try again.';
    }
    if (error.kind === 'network') {
      return 'We could not connect to the menu service. Check your connection and try again.';
    }
  }
  return 'We could not load the menu. Please try again.';
}

export default function MenuPage() {
  const { totalQuantity, uniqueItemCount } = useCart();
  const [loadState, setLoadState] = useState<MenuLoadState>({ status: 'loading' });
  const [requestVersion, setRequestVersion] = useState(0);
  const [selectedCategoryId, setSelectedCategoryId] = useState(ALL_CATEGORIES);
  const [availableOnly, setAvailableOnly] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    void fetchMenu(controller.signal)
      .then((menu) => {
        setSelectedCategoryId((currentCategoryId) => {
          if (
            currentCategoryId !== ALL_CATEGORIES &&
            !menu.categories.some((category) => category.id === currentCategoryId)
          ) {
            return ALL_CATEGORIES;
          }
          return currentCategoryId;
        });
        setLoadState({ menu, status: 'loaded' });
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setLoadState({ message: getSafeErrorMessage(error), status: 'error' });
        }
      });

    return () => controller.abort();
  }, [requestVersion]);

  const visibleCategories = useMemo(() => {
    if (loadState.status !== 'loaded') {
      return [];
    }

    const selectedCategories =
      selectedCategoryId === ALL_CATEGORIES
        ? loadState.menu.categories
        : loadState.menu.categories.filter(
            (category) => category.id === selectedCategoryId,
          );

    return selectedCategories
      .map((category) => ({
        ...category,
        items: availableOnly
          ? category.items.filter((item) => item.is_available)
          : category.items,
      }))
      .filter((category) => category.items.length > 0);
  }, [availableOnly, loadState, selectedCategoryId]);

  const retry = () => {
    setLoadState({ status: 'loading' });
    setRequestVersion((version) => version + 1);
  };

  const clearFilters = () => {
    setSelectedCategoryId(ALL_CATEGORIES);
    setAvailableOnly(false);
  };

  return (
    <div className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <p className={styles.eyebrow}>Freshly prepared</p>
          <h1>Our menu</h1>
          <p className={styles.introduction}>
            Browse every active dish. Temporarily unavailable items remain visible so
            you can see the full offering.
          </p>
        </div>
        <aside className={styles.cartSummary} aria-label="Cart summary">
          <span>
            {totalQuantity} {totalQuantity === 1 ? 'item' : 'items'} in cart
          </span>
          <small>
            {uniqueItemCount} {uniqueItemCount === 1 ? 'dish' : 'dishes'}
          </small>
          <Link className={styles.cartLink} to="/cart">
            View cart
          </Link>
        </aside>
      </header>

      {loadState.status === 'loading' && (
        <AsyncNotice title="Loading menu…">Fetching today&apos;s dishes.</AsyncNotice>
      )}

      {loadState.status === 'error' && (
        <AsyncNotice tone="error" title="Unable to load menu">
          <p>{loadState.message}</p>
          <button className={styles.primaryButton} type="button" onClick={retry}>
            Retry
          </button>
        </AsyncNotice>
      )}

      {loadState.status === 'loaded' && loadState.menu.categories.length === 0 && (
        <AsyncNotice title="Menu unavailable">The menu is currently empty.</AsyncNotice>
      )}

      {loadState.status === 'loaded' && loadState.menu.categories.length > 0 && (
        <>
          <section className={styles.filters} aria-labelledby="menu-filters-heading">
            <h2 id="menu-filters-heading" className={styles.filtersHeading}>
              Filter menu
            </h2>
            <fieldset className={styles.filterGroup}>
              <legend>Category</legend>
              <div className={styles.categoryControls}>
                <button
                  className={styles.filterButton}
                  type="button"
                  aria-pressed={selectedCategoryId === ALL_CATEGORIES}
                  onClick={() => setSelectedCategoryId(ALL_CATEGORIES)}
                >
                  All
                </button>
                {loadState.menu.categories.map((category) => (
                  <button
                    className={styles.filterButton}
                    type="button"
                    aria-pressed={selectedCategoryId === category.id}
                    key={category.id}
                    onClick={() => setSelectedCategoryId(category.id)}
                  >
                    {category.name}
                  </button>
                ))}
              </div>
            </fieldset>
            <label className={styles.availabilityFilter}>
              <input
                type="checkbox"
                checked={availableOnly}
                onChange={(event) => setAvailableOnly(event.target.checked)}
              />
              Show available items only
            </label>
          </section>

          {visibleCategories.length === 0 ? (
            <AsyncNotice title="No matching items">
              <p>No items match the current filters.</p>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={clearFilters}
              >
                Clear filters
              </button>
            </AsyncNotice>
          ) : (
            <div className={styles.categoryList}>
              {visibleCategories.map((category) => (
                <MenuCategorySection category={category} key={category.id} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
