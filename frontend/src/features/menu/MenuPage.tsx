import { type FocusEvent, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { ApiRequestError } from '../../api/client';
import { fetchMenu } from '../../api/customerApi';
import type { MenuResponse } from '../../api/types';
import AsyncNotice from '../../components/AsyncNotice';
import Button from '../../components/ui/Button';
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

function keepCategoryControlVisible(event: FocusEvent<HTMLButtonElement>): void {
  event.currentTarget.scrollIntoView?.({
    block: 'nearest',
    inline: 'nearest',
  });
}

/** Render the filterable public menu and assign one deterministic image priority. */
export default function MenuPage() {
  const { totalQuantity, uniqueItemCount } = useCart();
  const [loadState, setLoadState] = useState<MenuLoadState>({ status: 'loading' });
  const [requestVersion, setRequestVersion] = useState(0);
  const [selectedCategoryId, setSelectedCategoryId] = useState(ALL_CATEGORIES);
  const [availableOnly, setAvailableOnly] = useState(false);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const restoreRetryFocusRef = useRef(false);

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

  useEffect(() => {
    if (loadState.status === 'loading' || !restoreRetryFocusRef.current) {
      return;
    }

    if (loadState.status === 'error') {
      const activeElement = document.activeElement;
      if (activeElement === null || activeElement === document.body) {
        retryButtonRef.current?.focus();
      }
    }
    restoreRetryFocusRef.current = false;
  }, [loadState.status]);

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

  const menuItemCount =
    loadState.status === 'loaded'
      ? loadState.menu.categories.reduce(
          (total, category) =>
            total +
            category.items.filter((item) => !availableOnly || item.is_available).length,
          0,
        )
      : 0;

  const retry = () => {
    restoreRetryFocusRef.current = document.activeElement === retryButtonRef.current;
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
        <div className={styles.introCopy}>
          <p className={styles.eyebrow}>Restaurant menu</p>
          <h1 className={styles.pageTitle}>Our menu</h1>
          <p className={styles.introduction}>
            Explore the current selection by category, check availability, and add your
            choices to the cart.
          </p>
        </div>
        <aside className={styles.cartSummary} aria-label="Cart summary">
          <div className={styles.cartSummaryCopy}>
            <span className={styles.cartSummaryLabel}>Your cart</span>
            <strong>
              {totalQuantity} {totalQuantity === 1 ? 'item' : 'items'} in cart
            </strong>
            <small>
              {uniqueItemCount} {uniqueItemCount === 1 ? 'dish' : 'dishes'}
            </small>
          </div>
          <Link className={styles.cartLink} to="/cart">
            <span>View cart</span>
            <span aria-hidden="true">&rarr;</span>
          </Link>
        </aside>
      </header>

      {loadState.status === 'loading' && (
        <AsyncNotice title="Loading menu…">Fetching the menu.</AsyncNotice>
      )}

      {loadState.status === 'error' && (
        <AsyncNotice tone="error" title="Unable to load menu">
          <p>{loadState.message}</p>
          <Button
            ref={retryButtonRef}
            className={styles.noticeButton}
            type="button"
            onClick={retry}
          >
            Retry
          </Button>
        </AsyncNotice>
      )}

      {loadState.status === 'loaded' && loadState.menu.categories.length === 0 && (
        <AsyncNotice title="Menu unavailable">The menu is currently empty.</AsyncNotice>
      )}

      {loadState.status === 'loaded' && loadState.menu.categories.length > 0 && (
        <>
          <section className={styles.filters} aria-labelledby="menu-filters-heading">
            <div className={styles.filtersHeader}>
              <div>
                <p className={styles.filtersEyebrow}>Explore</p>
                <h2 id="menu-filters-heading" className={styles.filtersHeading}>
                  Browse categories
                </h2>
              </div>
              <label className={styles.availabilityFilter}>
                <input
                  type="checkbox"
                  checked={availableOnly}
                  onChange={(event) => setAvailableOnly(event.target.checked)}
                />
                Show available items only
              </label>
            </div>
            <nav className={styles.categoryNavigation} aria-label="Menu categories">
              <div className={styles.categoryControls}>
                <button
                  className={styles.filterButton}
                  type="button"
                  onFocus={keepCategoryControlVisible}
                  aria-pressed={selectedCategoryId === ALL_CATEGORIES}
                  aria-controls="menu-category-list"
                  onClick={() => setSelectedCategoryId(ALL_CATEGORIES)}
                >
                  <span>All</span>
                  <span className={styles.filterCount} aria-hidden="true">
                    {menuItemCount}
                  </span>
                </button>
                {loadState.menu.categories.map((category) => (
                  <button
                    className={styles.filterButton}
                    type="button"
                    onFocus={keepCategoryControlVisible}
                    aria-pressed={selectedCategoryId === category.id}
                    aria-controls="menu-category-list"
                    key={category.id}
                    onClick={() => setSelectedCategoryId(category.id)}
                  >
                    <span>{category.name}</span>
                    <span className={styles.filterCount} aria-hidden="true">
                      {
                        category.items.filter(
                          (item) => !availableOnly || item.is_available,
                        ).length
                      }
                    </span>
                  </button>
                ))}
              </div>
            </nav>
          </section>

          <div className={styles.categoryList} id="menu-category-list">
            {visibleCategories.length === 0 ? (
              <AsyncNotice title="No matching items">
                <p>No items match the current filters.</p>
                <Button variant="secondary" type="button" onClick={clearFilters}>
                  Clear filters
                </Button>
              </AsyncNotice>
            ) : (
              visibleCategories.map((category, categoryIndex) => (
                <MenuCategorySection
                  category={category}
                  prioritizeFirstItem={categoryIndex === 0}
                  key={category.id}
                />
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
