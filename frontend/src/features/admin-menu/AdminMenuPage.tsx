import { type Ref, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AdminApiRequestError } from '../../api/adminApi';
import AsyncNotice, { type AsyncNoticeTone } from '../../components/AsyncNotice';
import Button from '../../components/ui/Button';
import StatusBadge from '../../components/ui/StatusBadge';
import { useAuth } from '../auth/AuthContext';
import { resolveMenuImageUrl } from '../menu/menuImageCatalog';
import {
  type AdminCategory,
  type AdminCategoryCreatePayload,
  type AdminCategoryListResponse,
  type AdminCategoryUpdatePayload,
  type AdminMenuItem,
  type AdminMenuItemCreatePayload,
  type AdminMenuItemListResponse,
  type AdminMenuItemUpdatePayload,
  createAdminCategory,
  createAdminMenuItem,
  fetchAdminCategories,
  fetchAdminMenuItems,
  fetchAllAdminCategories,
  formatAdminMenuDate,
  updateAdminCategory,
  updateAdminMenuItem,
} from './adminMenuApi';
import styles from './AdminMenuPage.module.css';
import CategoryForm from './CategoryForm';
import MenuItemForm, { formatNokMinorUnits } from './MenuItemForm';

const PAGE_LIMIT = 50;

type LoadState<T> =
  | { kind: 'error'; message: string }
  | { kind: 'loading' }
  | { data: T; kind: 'success' };

interface Notice {
  message: string;
  title: string;
  tone: AsyncNoticeTone;
}

interface CollectionFocusIntent {
  readonly kind: 'pagination' | 'retry';
  readonly origin: HTMLElement | null;
}

function restoreFocusIfAbandoned(
  target: HTMLElement | null,
  origin: HTMLElement | null = null,
): void {
  if (target === null || !target.isConnected) return;
  const activeElement = document.activeElement;
  if (
    activeElement === origin ||
    activeElement === null ||
    activeElement === document.body ||
    !activeElement.isConnected ||
    (activeElement instanceof HTMLButtonElement && activeElement.disabled)
  ) {
    target.focus();
  }
}

function MenuImagePreview({ item }: { item: AdminMenuItem }) {
  const [failedImageUrl, setFailedImageUrl] = useState<string | null>(null);
  const imageUrl = resolveMenuImageUrl(item.id, item.imageUrl);
  const failed = imageUrl !== null && failedImageUrl === imageUrl;

  return (
    <span className={styles.itemImageFrame}>
      {imageUrl !== null && !failed ? (
        <img
          alt=""
          className={styles.itemImage}
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          src={imageUrl}
          onError={() => setFailedImageUrl(imageUrl)}
        />
      ) : (
        <span
          aria-label={failed ? 'Image preview unavailable' : 'No safe image preview'}
          className={styles.itemImageFallback}
          role="img"
        >
          No image
        </span>
      )}
    </span>
  );
}

type CategoryOptionsState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { categories: AdminCategory[]; kind: 'success' }
  | { kind: 'error'; message: string };

function getListErrorMessage(
  resource: 'categories' | 'menu items',
  error: unknown,
): string {
  if (!(error instanceof AdminApiRequestError)) {
    return `The ${resource} could not be loaded. Check your connection and try again.`;
  }
  if (error.kind === 'network' || error.kind === 'timeout') {
    return `The ${resource} service could not be reached. Check your connection and try again.`;
  }
  if (error.kind === 'invalid-response') {
    return `The ${resource} service returned an unexpected response. Try again later.`;
  }
  if (error.status === 422) {
    return `The ${resource} page request was not valid. Return to the first page and retry.`;
  }
  if (error.status === 503 || (error.status !== null && error.status >= 500)) {
    return `The ${resource} service is temporarily unavailable. Try again later.`;
  }
  return `The ${resource} could not be loaded. Try again.`;
}

function isAmbiguousMutation(error: AdminApiRequestError): boolean {
  return (
    error.kind === 'network' ||
    error.kind === 'timeout' ||
    error.kind === 'invalid-response' ||
    (error.status !== null && error.status >= 500)
  );
}

function getCategoryMutationNotice(error: unknown): Notice {
  if (error instanceof AdminApiRequestError) {
    if (error.status === 409) {
      return {
        message: 'A category with this name already exists.',
        title: 'Category was not saved',
        tone: 'error',
      };
    }
    if (error.status === 422) {
      return {
        message: 'Review the category fields and try again.',
        title: 'Category validation failed',
        tone: 'error',
      };
    }
    if (isAmbiguousMutation(error)) {
      return {
        message:
          'The result could not be confirmed. Refresh categories before deliberately submitting again.',
        title: 'Category result is uncertain',
        tone: 'error',
      };
    }
  }
  return {
    message: 'The category could not be saved. Review the form and try again.',
    title: 'Category was not saved',
    tone: 'error',
  };
}

function getItemMutationNotice(error: unknown): Notice {
  if (error instanceof AdminApiRequestError) {
    if (error.status === 409) {
      return {
        message: 'A menu item with this name already exists in the selected category.',
        title: 'Menu item was not saved',
        tone: 'error',
      };
    }
    if (error.status === 422) {
      return {
        message: 'Review the menu-item fields and try again.',
        title: 'Menu-item validation failed',
        tone: 'error',
      };
    }
    if (isAmbiguousMutation(error)) {
      return {
        message:
          'The result could not be confirmed. Refresh menu items before deliberately submitting again.',
        title: 'Menu-item result is uncertain',
        tone: 'error',
      };
    }
  }
  return {
    message: 'The menu item could not be saved. Review the form and try again.',
    title: 'Menu item was not saved',
    tone: 'error',
  };
}

function StatePanel({
  actionRef,
  heading,
  message,
  onRetry,
}: {
  actionRef?: Ref<HTMLButtonElement>;
  heading: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className={styles.statePanel} role={onRetry ? 'alert' : undefined}>
      <h3>{heading}</h3>
      <p>{message}</p>
      {onRetry ? (
        <Button ref={actionRef} variant="secondary" onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function Pagination({
  label,
  limit,
  offset,
  pageItems,
  total,
  onOffsetChange,
}: {
  label: string;
  limit: number;
  offset: number;
  pageItems: number;
  total: number;
  onOffsetChange: (offset: number, origin: HTMLButtonElement) => void;
}) {
  return (
    <nav className={styles.pagination} aria-label={`${label} pagination`}>
      <Button
        variant="secondary"
        disabled={offset === 0}
        onClick={(event) =>
          onOffsetChange(Math.max(0, offset - limit), event.currentTarget)
        }
      >
        Previous
      </Button>
      <span aria-current="page">Page {Math.floor(offset / limit) + 1}</span>
      <Button
        variant="secondary"
        disabled={offset + pageItems >= total}
        onClick={(event) => onOffsetChange(offset + limit, event.currentTarget)}
      >
        Next
      </Button>
    </nav>
  );
}

function CategoryResults({
  data,
  onEdit,
  summaryRef,
}: {
  data: AdminCategoryListResponse;
  onEdit: (category: AdminCategory, trigger: HTMLButtonElement) => void;
  summaryRef: Ref<HTMLParagraphElement>;
}) {
  return (
    <>
      <p
        ref={summaryRef}
        className={styles.resultSummary}
        tabIndex={-1}
        aria-live="polite"
      >
        Showing {data.offset + 1}–{data.offset + data.items.length} of {data.total}
      </p>
      <div className={styles.tableWrapper}>
        <table className={[styles.table, styles.categoryTable].join(' ')}>
          <caption>Administrator categories in backend order</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
              <th scope="col">Display order</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">Updated</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((category) => (
              <tr key={category.id}>
                <th scope="row">{category.name}</th>
                <td>{category.description ?? 'No description'}</td>
                <td>{category.displayOrder}</td>
                <td>
                  <StatusBadge variant={category.isActive ? 'success' : 'neutral'}>
                    {category.isActive ? 'Active' : 'Inactive'}
                  </StatusBadge>
                </td>
                <td>
                  <time dateTime={category.updatedAt}>
                    {formatAdminMenuDate(category.updatedAt)}
                  </time>
                </td>
                <td>
                  <Button
                    className={styles.compactButton}
                    size="sm"
                    variant="secondary"
                    onClick={(event) => onEdit(category, event.currentTarget)}
                  >
                    Edit <span className={styles.visuallyHidden}>{category.name}</span>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.cards} aria-label="Administrator categories">
        {data.items.map((category) => (
          <li className={styles.card} key={category.id}>
            <article>
              <h3>{category.name}</h3>
              <p>{category.description ?? 'No description'}</p>
              <dl className={styles.cardDetails}>
                <div>
                  <dt>Display order</dt>
                  <dd>{category.displayOrder}</dd>
                </div>
                <div>
                  <dt>Lifecycle</dt>
                  <dd>
                    <StatusBadge variant={category.isActive ? 'success' : 'neutral'}>
                      {category.isActive ? 'Active' : 'Inactive'}
                    </StatusBadge>
                  </dd>
                </div>
                <div>
                  <dt>Updated</dt>
                  <dd>
                    <time dateTime={category.updatedAt}>
                      {formatAdminMenuDate(category.updatedAt)}
                    </time>
                  </dd>
                </div>
              </dl>
              <Button
                variant="secondary"
                onClick={(event) => onEdit(category, event.currentTarget)}
              >
                Edit category{' '}
                <span className={styles.visuallyHidden}>{category.name}</span>
              </Button>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

function ItemResults({
  categoryNames,
  items,
  summary,
  onEdit,
  summaryRef,
}: {
  categoryNames: Map<string, string>;
  items: AdminMenuItem[];
  summary: string;
  onEdit: (item: AdminMenuItem, trigger: HTMLButtonElement) => void;
  summaryRef: Ref<HTMLParagraphElement>;
}) {
  const categoryName = (id: string) => categoryNames.get(id) ?? 'Category not loaded';
  return (
    <>
      <p
        ref={summaryRef}
        className={styles.resultSummary}
        tabIndex={-1}
        aria-live="polite"
      >
        {summary}
      </p>
      <div className={styles.tableWrapper}>
        <table className={[styles.table, styles.itemTable].join(' ')}>
          <caption>Administrator menu items in backend order</caption>
          <thead>
            <tr>
              <th scope="col">Image</th>
              <th scope="col">Item</th>
              <th scope="col">Category</th>
              <th scope="col">Price</th>
              <th scope="col">Cost</th>
              <th scope="col">Lifecycle</th>
              <th scope="col">Sale availability</th>
              <th scope="col">Order</th>
              <th scope="col">Updated</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td>
                  <MenuImagePreview item={item} />
                </td>
                <th scope="row">
                  <span className={styles.itemName}>{item.name}</span>
                  {item.description ? (
                    <span className={styles.itemDescription}>{item.description}</span>
                  ) : null}
                </th>
                <td>{categoryName(item.categoryId)}</td>
                <td className={styles.moneyCell}>
                  {item.currency === 'NOK'
                    ? formatNokMinorUnits(item.priceAmount) + ' NOK'
                    : 'Unsupported ' + item.currency}
                </td>
                <td className={styles.moneyCell}>
                  {item.costAmount === null
                    ? 'Unknown'
                    : item.currency === 'NOK'
                      ? formatNokMinorUnits(item.costAmount) + ' NOK'
                      : 'Unsupported ' + item.currency}
                </td>
                <td>
                  <StatusBadge variant={item.isActive ? 'success' : 'neutral'}>
                    {item.isActive ? 'Active' : 'Inactive'}
                  </StatusBadge>
                </td>
                <td>
                  <StatusBadge variant={item.isAvailable ? 'success' : 'warning'}>
                    {item.isAvailable ? 'Available' : 'Unavailable'}
                  </StatusBadge>
                </td>
                <td>{item.displayOrder}</td>
                <td>
                  <time dateTime={item.updatedAt}>
                    {formatAdminMenuDate(item.updatedAt)}
                  </time>
                </td>
                <td>
                  <Button
                    className={styles.compactButton}
                    size="sm"
                    variant="secondary"
                    onClick={(event) => onEdit(item, event.currentTarget)}
                  >
                    Edit <span className={styles.visuallyHidden}>{item.name}</span>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.cards} aria-label="Administrator menu items">
        {items.map((item) => (
          <li className={styles.card} key={item.id}>
            <article>
              <div className={styles.itemCardHeader}>
                <MenuImagePreview item={item} />
                <div className={styles.itemIdentity}>
                  <h3>{item.name}</h3>
                  <p>{categoryName(item.categoryId)}</p>
                </div>
              </div>
              {item.description ? (
                <p className={styles.itemCardDescription}>{item.description}</p>
              ) : null}
              <dl className={styles.cardDetails}>
                <div>
                  <dt>Price</dt>
                  <dd className={styles.moneyCell}>
                    {item.currency === 'NOK'
                      ? formatNokMinorUnits(item.priceAmount) + ' NOK'
                      : 'Unsupported ' + item.currency}
                  </dd>
                </div>
                <div>
                  <dt>Cost</dt>
                  <dd className={styles.moneyCell}>
                    {item.costAmount === null
                      ? 'Unknown'
                      : item.currency === 'NOK'
                        ? formatNokMinorUnits(item.costAmount) + ' NOK'
                        : 'Unsupported ' + item.currency}
                  </dd>
                </div>
                <div>
                  <dt>Lifecycle</dt>
                  <dd>
                    <StatusBadge variant={item.isActive ? 'success' : 'neutral'}>
                      {item.isActive ? 'Active' : 'Inactive'}
                    </StatusBadge>
                  </dd>
                </div>
                <div>
                  <dt>Sale availability</dt>
                  <dd>
                    <StatusBadge variant={item.isAvailable ? 'success' : 'warning'}>
                      {item.isAvailable ? 'Available' : 'Unavailable'}
                    </StatusBadge>
                  </dd>
                </div>
                <div>
                  <dt>Display order</dt>
                  <dd>{item.displayOrder}</dd>
                </div>
              </dl>
              <Button
                variant="secondary"
                onClick={(event) => onEdit(item, event.currentTarget)}
              >
                Edit menu item{' '}
                <span className={styles.visuallyHidden}>{item.name}</span>
              </Button>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function AdminMenuPage() {
  const {
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
  } = useAuth();
  const [categoryOffset, setCategoryOffset] = useState(0);
  const [itemOffset, setItemOffset] = useState(0);
  const [categoryState, setCategoryState] = useState<
    LoadState<AdminCategoryListResponse>
  >({ kind: 'loading' });
  const [itemState, setItemState] = useState<LoadState<AdminMenuItemListResponse>>({
    kind: 'loading',
  });
  const [categoryEditor, setCategoryEditor] = useState<
    AdminCategory | null | undefined
  >();
  const [itemEditor, setItemEditor] = useState<AdminMenuItem | null | undefined>();
  const [categoryOptions, setCategoryOptions] = useState<CategoryOptionsState>({
    kind: 'idle',
  });
  const [categoryNotice, setCategoryNotice] = useState<Notice | null>(null);
  const [itemNotice, setItemNotice] = useState<Notice | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [itemBusy, setItemBusy] = useState(false);
  const [categorySubmitLocked, setCategorySubmitLocked] = useState(false);
  const [itemSubmitLocked, setItemSubmitLocked] = useState(false);
  const [selectedCategoryId, setSelectedCategoryId] = useState<'all' | string>('all');
  const categoryControllerRef = useRef<AbortController | null>(null);
  const itemControllerRef = useRef<AbortController | null>(null);
  const optionsControllerRef = useRef<AbortController | null>(null);
  const categoryGenerationRef = useRef(0);
  const itemGenerationRef = useRef(0);
  const categoryHeadingRef = useRef<HTMLHeadingElement>(null);
  const itemHeadingRef = useRef<HTMLHeadingElement>(null);
  const categoryResultSummaryRef = useRef<HTMLParagraphElement>(null);
  const itemResultSummaryRef = useRef<HTMLParagraphElement>(null);
  const categoryRetryButtonRef = useRef<HTMLButtonElement>(null);
  const itemRetryButtonRef = useRef<HTMLButtonElement>(null);
  const categoryFocusIntentRef = useRef<CollectionFocusIntent | null>(null);
  const itemFocusIntentRef = useRef<CollectionFocusIntent | null>(null);
  const categoryEditorTriggerRef = useRef<HTMLButtonElement | null>(null);
  const itemEditorTriggerRef = useRef<HTMLButtonElement | null>(null);

  const loadCategories = useCallback(async () => {
    const authSession = getAuthenticatedSession();
    if (authSession === null) return logout();
    const token = authSession.accessToken;
    categoryGenerationRef.current += 1;
    const generation = categoryGenerationRef.current;
    categoryControllerRef.current?.abort();
    const controller = new AbortController();
    categoryControllerRef.current = controller;
    setCategoryNotice(null);
    setCategoryState({ kind: 'loading' });
    try {
      const data = await fetchAdminCategories(
        token,
        PAGE_LIMIT,
        categoryOffset,
        controller.signal,
      );
      if (generation !== categoryGenerationRef.current) return;
      setCategoryState({ data, kind: 'success' });
      setCategorySubmitLocked(false);
      if (data.offset === 0 && data.items.length === data.total) {
        setCategoryOptions({ categories: data.items, kind: 'success' });
      } else {
        setCategoryOptions({ kind: 'idle' });
      }
    } catch (error: unknown) {
      if (generation !== categoryGenerationRef.current) return;
      if (error instanceof AdminApiRequestError && error.kind === 'aborted') return;
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      setCategoryState({
        kind: 'error',
        message: getListErrorMessage('categories', error),
      });
    }
  }, [
    categoryOffset,
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    logout,
    refreshCurrentUser,
  ]);

  const loadItems = useCallback(async () => {
    const authSession = getAuthenticatedSession();
    if (authSession === null) return logout();
    const token = authSession.accessToken;
    itemGenerationRef.current += 1;
    const generation = itemGenerationRef.current;
    itemControllerRef.current?.abort();
    const controller = new AbortController();
    itemControllerRef.current = controller;
    setItemNotice(null);
    setItemState({ kind: 'loading' });
    try {
      const data = await fetchAdminMenuItems(
        token,
        PAGE_LIMIT,
        itemOffset,
        controller.signal,
      );
      if (generation !== itemGenerationRef.current) return;
      setItemState({ data, kind: 'success' });
      setItemSubmitLocked(false);
    } catch (error: unknown) {
      if (generation !== itemGenerationRef.current) return;
      if (error instanceof AdminApiRequestError && error.kind === 'aborted') return;
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      setItemState({
        kind: 'error',
        message: getListErrorMessage('menu items', error),
      });
    }
  }, [
    getAuthenticatedSession,
    invalidateSessionIfCurrent,
    itemOffset,
    logout,
    refreshCurrentUser,
  ]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadCategories(), 0);
    return () => {
      window.clearTimeout(id);
      categoryGenerationRef.current += 1;
      categoryControllerRef.current?.abort();
    };
  }, [loadCategories]);

  useEffect(() => {
    const id = window.setTimeout(() => void loadItems(), 0);
    return () => {
      window.clearTimeout(id);
      itemGenerationRef.current += 1;
      itemControllerRef.current?.abort();
    };
  }, [loadItems]);

  useEffect(() => () => optionsControllerRef.current?.abort(), []);

  useEffect(() => {
    if (categoryState.kind === 'loading') return;
    const intent = categoryFocusIntentRef.current;
    if (intent === null) return;
    categoryFocusIntentRef.current = null;
    const target =
      categoryState.kind === 'error'
        ? categoryRetryButtonRef.current
        : categoryState.data.items.length > 0
          ? categoryResultSummaryRef.current
          : categoryHeadingRef.current;
    restoreFocusIfAbandoned(target, intent.origin);
  }, [categoryState]);

  useEffect(() => {
    if (itemState.kind === 'loading') return;
    const intent = itemFocusIntentRef.current;
    if (intent === null) return;
    itemFocusIntentRef.current = null;
    const target =
      itemState.kind === 'error'
        ? itemRetryButtonRef.current
        : itemState.data.items.length > 0
          ? itemResultSummaryRef.current
          : itemHeadingRef.current;
    restoreFocusIfAbandoned(target, intent.origin);
  }, [itemState]);

  const retryCategories = useCallback(() => {
    categoryFocusIntentRef.current = {
      kind: 'retry',
      origin:
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    void loadCategories();
  }, [loadCategories]);

  const retryItems = useCallback(() => {
    itemFocusIntentRef.current = {
      kind: 'retry',
      origin:
        document.activeElement instanceof HTMLElement ? document.activeElement : null,
    };
    void loadItems();
  }, [loadItems]);

  const changeCategoryOffset = useCallback(
    (nextOffset: number, origin: HTMLButtonElement) => {
      categoryFocusIntentRef.current = { kind: 'pagination', origin };
      setCategoryOffset(nextOffset);
    },
    [],
  );

  const changeItemOffset = useCallback(
    (nextOffset: number, origin: HTMLButtonElement) => {
      itemFocusIntentRef.current = { kind: 'pagination', origin };
      setItemOffset(nextOffset);
    },
    [],
  );

  const categoryNames = useMemo(() => {
    const categories =
      categoryOptions.kind === 'success'
        ? categoryOptions.categories
        : categoryState.kind === 'success'
          ? categoryState.data.items
          : [];
    return new Map(categories.map((category) => [category.id, category.name]));
  }, [categoryOptions, categoryState]);

  const categoryFilterOptions = useMemo(() => {
    if (
      categoryState.kind !== 'success' ||
      itemState.kind !== 'success' ||
      categoryState.data.offset !== 0 ||
      itemState.data.offset !== 0 ||
      categoryState.data.items.length !== categoryState.data.total ||
      itemState.data.items.length !== itemState.data.total ||
      categoryState.data.items.length < 2
    ) {
      return [];
    }
    return categoryState.data.items;
  }, [categoryState, itemState]);

  const effectiveSelectedCategoryId =
    selectedCategoryId === 'all' ||
    categoryFilterOptions.some((category) => category.id === selectedCategoryId)
      ? selectedCategoryId
      : 'all';

  const visibleItems = useMemo(() => {
    if (itemState.kind !== 'success') {
      return [];
    }
    if (effectiveSelectedCategoryId === 'all' || categoryFilterOptions.length === 0) {
      return itemState.data.items;
    }
    return itemState.data.items.filter(
      (item) => item.categoryId === effectiveSelectedCategoryId,
    );
  }, [categoryFilterOptions, effectiveSelectedCategoryId, itemState]);

  const itemResultSummary = useMemo(() => {
    if (itemState.kind !== 'success') {
      return '';
    }
    if (effectiveSelectedCategoryId !== 'all' && categoryFilterOptions.length > 0) {
      const categoryName =
        categoryNames.get(effectiveSelectedCategoryId) ?? 'selected category';
      return `${visibleItems.length} item${visibleItems.length === 1 ? '' : 's'} in ${categoryName}`;
    }
    return `Showing ${itemState.data.offset + 1}–${itemState.data.offset + itemState.data.items.length} of ${itemState.data.total}`;
  }, [
    categoryFilterOptions.length,
    categoryNames,
    itemState,
    effectiveSelectedCategoryId,
    visibleItems.length,
  ]);

  const inventorySummary = useMemo(() => {
    if (
      itemState.kind !== 'success' ||
      itemState.data.offset !== 0 ||
      itemState.data.items.length !== itemState.data.total
    ) {
      return null;
    }
    return {
      active: itemState.data.items.filter((item) => item.isActive).length,
      available: itemState.data.items.filter((item) => item.isAvailable).length,
      total: itemState.data.total,
    };
  }, [itemState]);

  const openCategoryEditor = (
    category: AdminCategory | null,
    trigger: HTMLButtonElement,
  ) => {
    categoryEditorTriggerRef.current = trigger;
    if (!categorySubmitLocked) {
      setCategoryNotice(null);
    }
    setCategoryEditor(category);
  };

  const closeCategoryEditor = useCallback(() => {
    const trigger = categoryEditorTriggerRef.current;
    setCategoryEditor(undefined);
    window.setTimeout(() => {
      restoreFocusIfAbandoned(trigger);
      if (categoryEditorTriggerRef.current === trigger) {
        categoryEditorTriggerRef.current = null;
      }
    }, 0);
  }, []);

  const closeItemEditor = useCallback(() => {
    const trigger = itemEditorTriggerRef.current;
    setItemEditor(undefined);
    window.setTimeout(() => {
      restoreFocusIfAbandoned(trigger);
      if (itemEditorTriggerRef.current === trigger) {
        itemEditorTriggerRef.current = null;
      }
    }, 0);
  }, []);

  const openItemEditor = async (
    item: AdminMenuItem | null,
    trigger: HTMLButtonElement,
  ) => {
    itemEditorTriggerRef.current = trigger;
    if (!itemSubmitLocked) {
      setItemNotice(null);
    }
    if (categoryOptions.kind === 'success') {
      setItemEditor(item);
      return;
    }
    const authSession = getAuthenticatedSession();
    if (authSession === null) return logout();
    const token = authSession.accessToken;
    optionsControllerRef.current?.abort();
    const controller = new AbortController();
    optionsControllerRef.current = controller;
    setCategoryOptions({ kind: 'loading' });
    try {
      const categories = await fetchAllAdminCategories(token, controller.signal);
      optionsControllerRef.current = null;
      setCategoryOptions({ categories, kind: 'success' });
      setItemEditor(item);
    } catch (error: unknown) {
      optionsControllerRef.current = null;
      if (error instanceof AdminApiRequestError && error.kind === 'aborted') return;
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      setCategoryOptions({
        kind: 'error',
        message: getListErrorMessage('categories', error),
      });
      window.setTimeout(() => {
        restoreFocusIfAbandoned(trigger);
        if (itemEditorTriggerRef.current === trigger) {
          itemEditorTriggerRef.current = null;
        }
      }, 0);
    }
  };

  const handleCategorySubmit = async (
    payload: AdminCategoryCreatePayload | AdminCategoryUpdatePayload,
  ) => {
    const focusOrigin =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const authSession = getAuthenticatedSession();
    if (authSession === null) return logout();
    const token = authSession.accessToken;
    setCategoryBusy(true);
    setCategoryNotice(null);
    const controller = new AbortController();
    try {
      const editing = categoryEditor !== null && categoryEditor !== undefined;
      if (editing)
        await updateAdminCategory(token, categoryEditor.id, payload, controller.signal);
      else
        await createAdminCategory(
          token,
          payload as AdminCategoryCreatePayload,
          controller.signal,
        );
      setCategoryEditor(undefined);
      setCategoryOptions({ kind: 'idle' });
      try {
        const data = await fetchAdminCategories(
          token,
          PAGE_LIMIT,
          categoryOffset,
          controller.signal,
        );
        setCategoryState({ data, kind: 'success' });
        setCategorySubmitLocked(false);
        if (data.offset === 0 && data.items.length === data.total) {
          setCategoryOptions({ categories: data.items, kind: 'success' });
        }
        setCategoryNotice({
          message: `The category was ${editing ? 'updated' : 'created'} and the list was refreshed.`,
          title: 'Category saved',
          tone: 'success',
        });
        window.setTimeout(
          () => restoreFocusIfAbandoned(categoryHeadingRef.current, focusOrigin),
          0,
        );
      } catch (refreshError: unknown) {
        if (
          refreshError instanceof AdminApiRequestError &&
          refreshError.status === 401
        ) {
          invalidateSessionIfCurrent(authSession);
          return;
        }
        if (
          refreshError instanceof AdminApiRequestError &&
          refreshError.status === 403
        ) {
          await refreshCurrentUser();
        }
        setCategoryNotice({
          message:
            'The category was saved, but the latest list could not be refreshed. Use Refresh.',
          title: 'Category saved',
          tone: 'success',
        });
        window.setTimeout(
          () => restoreFocusIfAbandoned(categoryHeadingRef.current, focusOrigin),
          0,
        );
      }
    } catch (error: unknown) {
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      if (error instanceof AdminApiRequestError && error.status === 404) {
        setCategoryEditor(undefined);
        setCategoryNotice({
          message: 'The category no longer exists. The list is being refreshed.',
          title: 'Category not found',
          tone: 'error',
        });
        void loadCategories();
      } else {
        if (error instanceof AdminApiRequestError && isAmbiguousMutation(error))
          setCategorySubmitLocked(true);
        setCategoryNotice(getCategoryMutationNotice(error));
      }
    } finally {
      setCategoryBusy(false);
    }
  };

  const handleItemSubmit = async (
    payload: AdminMenuItemCreatePayload | AdminMenuItemUpdatePayload,
  ) => {
    const focusOrigin =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const authSession = getAuthenticatedSession();
    if (authSession === null) return logout();
    const token = authSession.accessToken;
    setItemBusy(true);
    setItemNotice(null);
    const controller = new AbortController();
    try {
      const editing = itemEditor !== null && itemEditor !== undefined;
      if (editing)
        await updateAdminMenuItem(token, itemEditor.id, payload, controller.signal);
      else
        await createAdminMenuItem(
          token,
          payload as AdminMenuItemCreatePayload,
          controller.signal,
        );
      setItemEditor(undefined);
      try {
        const data = await fetchAdminMenuItems(
          token,
          PAGE_LIMIT,
          itemOffset,
          controller.signal,
        );
        setItemState({ data, kind: 'success' });
        setItemSubmitLocked(false);
        setItemNotice({
          message: `The menu item was ${editing ? 'updated' : 'created'} and the list was refreshed.`,
          title: 'Menu item saved',
          tone: 'success',
        });
        window.setTimeout(
          () => restoreFocusIfAbandoned(itemHeadingRef.current, focusOrigin),
          0,
        );
      } catch (refreshError: unknown) {
        if (
          refreshError instanceof AdminApiRequestError &&
          refreshError.status === 401
        ) {
          invalidateSessionIfCurrent(authSession);
          return;
        }
        if (
          refreshError instanceof AdminApiRequestError &&
          refreshError.status === 403
        ) {
          await refreshCurrentUser();
        }
        setItemNotice({
          message:
            'The menu item was saved, but the latest list could not be refreshed. Use Refresh.',
          title: 'Menu item saved',
          tone: 'success',
        });
        window.setTimeout(
          () => restoreFocusIfAbandoned(itemHeadingRef.current, focusOrigin),
          0,
        );
      }
    } catch (error: unknown) {
      if (error instanceof AdminApiRequestError && error.status === 401) {
        invalidateSessionIfCurrent(authSession);
        return;
      }
      if (error instanceof AdminApiRequestError && error.status === 403) {
        await refreshCurrentUser();
      }
      if (error instanceof AdminApiRequestError && error.status === 404) {
        setItemEditor(undefined);
        setCategoryOptions({ kind: 'idle' });
        setItemNotice({
          message:
            'The menu item or selected category no longer exists. The list is being refreshed.',
          title: 'Menu item not found',
          tone: 'error',
        });
        void loadItems();
      } else {
        if (error instanceof AdminApiRequestError && isAmbiguousMutation(error))
          setItemSubmitLocked(true);
        setItemNotice(getItemMutationNotice(error));
      }
    } finally {
      setItemBusy(false);
    }
  };

  return (
    <section className={styles.page} aria-labelledby="admin-menu-heading">
      <header className={styles.pageHeader}>
        <p className="eyebrow">Catalog operations</p>
        <h1 id="admin-menu-heading">Menu</h1>
        <p>
          Manage categories, NOK pricing, lifecycle visibility, and daily sale
          availability.
        </p>
        <p className={styles.snapshotWarning}>
          Changes affect future orders only. Historical order snapshots and analytics do
          not change.
        </p>
      </header>

      <section
        aria-busy={categoryState.kind === 'loading' || categoryBusy}
        className={styles.resourceSection}
        aria-labelledby="categories-heading"
      >
        <header className={styles.sectionHeader}>
          <div>
            <h2 ref={categoryHeadingRef} id="categories-heading" tabIndex={-1}>
              Categories
            </h2>
            <p>Manage active and inactive category records.</p>
          </div>
          <div className={styles.sectionActions}>
            <Button
              disabled={categoryBusy}
              onClick={(event) => openCategoryEditor(null, event.currentTarget)}
            >
              Add category
            </Button>
            <Button
              variant="secondary"
              loading={categoryState.kind === 'loading'}
              loadingLabel="Refreshing categories…"
              disabled={categoryBusy}
              onClick={() => void loadCategories()}
            >
              Refresh categories
            </Button>
          </div>
        </header>
        {categoryNotice ? (
          <AsyncNotice title={categoryNotice.title} tone={categoryNotice.tone}>
            <p>{categoryNotice.message}</p>
          </AsyncNotice>
        ) : null}
        {categoryEditor !== undefined ? (
          <CategoryForm
            key={categoryEditor?.id ?? 'new-category'}
            busy={categoryBusy}
            category={categoryEditor}
            onCancel={closeCategoryEditor}
            onSubmit={handleCategorySubmit}
            submitLocked={categorySubmitLocked}
          />
        ) : null}
        {categoryState.kind === 'loading' ? (
          <StatePanel
            heading="Loading categories"
            message="The latest category page is being requested."
          />
        ) : null}
        {categoryState.kind === 'error' ? (
          <StatePanel
            actionRef={categoryRetryButtonRef}
            heading="Unable to load categories"
            message={categoryState.message}
            onRetry={retryCategories}
          />
        ) : null}
        {categoryState.kind === 'success' && categoryState.data.items.length === 0 ? (
          <StatePanel
            heading="No categories yet"
            message="Create a category before adding menu items."
          />
        ) : null}
        {categoryState.kind === 'success' && categoryState.data.items.length > 0 ? (
          <CategoryResults
            data={categoryState.data}
            onEdit={openCategoryEditor}
            summaryRef={categoryResultSummaryRef}
          />
        ) : null}
        {categoryState.kind === 'success' && categoryState.data.total > 0 ? (
          <Pagination
            label="Categories"
            limit={PAGE_LIMIT}
            offset={categoryOffset}
            pageItems={categoryState.data.items.length}
            total={categoryState.data.total}
            onOffsetChange={changeCategoryOffset}
          />
        ) : null}
      </section>

      <section
        aria-busy={itemState.kind === 'loading' || itemBusy}
        className={styles.resourceSection}
        aria-labelledby="items-heading"
      >
        <header className={styles.sectionHeader}>
          <div>
            <h2 ref={itemHeadingRef} id="items-heading" tabIndex={-1}>
              Menu items
            </h2>
            <p>Activity and availability remain independent controls.</p>
          </div>
          <div className={styles.sectionActions}>
            <Button
              disabled={
                itemBusy ||
                categoryState.kind !== 'success' ||
                categoryState.data.total === 0 ||
                categoryOptions.kind === 'loading'
              }
              onClick={(event) => void openItemEditor(null, event.currentTarget)}
            >
              Add menu item
            </Button>
            <Button
              variant="secondary"
              loading={itemState.kind === 'loading'}
              loadingLabel="Refreshing menu items…"
              disabled={itemBusy}
              onClick={() => void loadItems()}
            >
              Refresh menu items
            </Button>
          </div>
        </header>
        {inventorySummary !== null ? (
          <dl
            className={styles.operationalSummary}
            aria-label="Current inventory summary"
          >
            <div>
              <dt>Items</dt>
              <dd>{inventorySummary.total}</dd>
            </div>
            <div>
              <dt>Active</dt>
              <dd>{inventorySummary.active}</dd>
            </div>
            <div>
              <dt>Marked available</dt>
              <dd>{inventorySummary.available}</dd>
            </div>
          </dl>
        ) : null}
        {categoryFilterOptions.length > 0 ? (
          <nav
            className={styles.categoryFilter}
            aria-label="Filter menu items by category"
          >
            <p>Current inventory by category</p>
            <div className={styles.categoryFilterOptions}>
              <Button
                aria-pressed={effectiveSelectedCategoryId === 'all'}
                className={styles.categoryFilterButton}
                size="sm"
                variant={effectiveSelectedCategoryId === 'all' ? 'primary' : 'ghost'}
                onClick={() => setSelectedCategoryId('all')}
              >
                <span aria-hidden="true">
                  {effectiveSelectedCategoryId === 'all' ? '✓ ' : ''}
                </span>
                All items
              </Button>
              {categoryFilterOptions.map((category) => (
                <Button
                  key={category.id}
                  aria-pressed={effectiveSelectedCategoryId === category.id}
                  className={styles.categoryFilterButton}
                  size="sm"
                  variant={
                    effectiveSelectedCategoryId === category.id ? 'primary' : 'ghost'
                  }
                  onClick={() => setSelectedCategoryId(category.id)}
                >
                  <span aria-hidden="true">
                    {effectiveSelectedCategoryId === category.id ? '✓ ' : ''}
                  </span>
                  {category.name}
                </Button>
              ))}
            </div>
          </nav>
        ) : null}
        {categoryOptions.kind === 'loading' ? (
          <p className={styles.inlineStatus} role="status">
            Loading all categories for the item form…
          </p>
        ) : null}
        {categoryOptions.kind === 'error' ? (
          <AsyncNotice title="Unable to load category choices" tone="error">
            <p>{categoryOptions.message}</p>
          </AsyncNotice>
        ) : null}
        {itemNotice ? (
          <AsyncNotice title={itemNotice.title} tone={itemNotice.tone}>
            <p>{itemNotice.message}</p>
          </AsyncNotice>
        ) : null}
        {itemEditor !== undefined && categoryOptions.kind === 'success' ? (
          <MenuItemForm
            key={itemEditor?.id ?? 'new-item'}
            busy={itemBusy}
            categories={categoryOptions.categories}
            item={itemEditor}
            onCancel={closeItemEditor}
            onSubmit={handleItemSubmit}
            submitLocked={itemSubmitLocked}
          />
        ) : null}
        {itemState.kind === 'loading' ? (
          <StatePanel
            heading="Loading menu items"
            message="The latest menu-item page is being requested."
          />
        ) : null}
        {itemState.kind === 'error' ? (
          <StatePanel
            actionRef={itemRetryButtonRef}
            heading="Unable to load menu items"
            message={itemState.message}
            onRetry={retryItems}
          />
        ) : null}
        {itemState.kind === 'success' && itemState.data.items.length === 0 ? (
          <StatePanel
            heading="No menu items yet"
            message="Menu items will appear here after they are created."
          />
        ) : null}
        {itemState.kind === 'success' &&
        itemState.data.items.length > 0 &&
        visibleItems.length === 0 ? (
          <StatePanel
            heading="No items in this category"
            message="Choose another category or show all current menu items."
          />
        ) : null}
        {itemState.kind === 'success' && visibleItems.length > 0 ? (
          <ItemResults
            categoryNames={categoryNames}
            items={visibleItems}
            summary={itemResultSummary}
            onEdit={(item, trigger) => void openItemEditor(item, trigger)}
            summaryRef={itemResultSummaryRef}
          />
        ) : null}
        {itemState.kind === 'success' && itemState.data.total > 0 ? (
          <Pagination
            label="Menu items"
            limit={PAGE_LIMIT}
            offset={itemOffset}
            pageItems={itemState.data.items.length}
            total={itemState.data.total}
            onOffsetChange={changeItemOffset}
          />
        ) : null}
      </section>
    </section>
  );
}
