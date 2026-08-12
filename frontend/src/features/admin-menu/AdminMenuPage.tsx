import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AdminApiRequestError } from '../../api/adminApi';
import AsyncNotice, { type AsyncNoticeTone } from '../../components/AsyncNotice';
import { useAdminAuth } from '../admin-auth/AdminAuthContext';
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
  formatAdminMenuMoney,
  updateAdminCategory,
  updateAdminMenuItem,
} from './adminMenuApi';
import styles from './AdminMenuPage.module.css';
import CategoryForm from './CategoryForm';
import MenuItemForm from './MenuItemForm';

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
  heading,
  message,
  onRetry,
}: {
  heading: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className={styles.statePanel} role={onRetry ? 'alert' : undefined}>
      <h3>{heading}</h3>
      <p>{message}</p>
      {onRetry ? (
        <button className={styles.secondaryButton} type="button" onClick={onRetry}>
          Retry
        </button>
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
  onOffsetChange: (offset: number) => void;
}) {
  return (
    <nav className={styles.pagination} aria-label={`${label} pagination`}>
      <button
        className={styles.secondaryButton}
        type="button"
        disabled={offset === 0}
        onClick={() => onOffsetChange(Math.max(0, offset - limit))}
      >
        Previous
      </button>
      <span aria-current="page">Page {Math.floor(offset / limit) + 1}</span>
      <button
        className={styles.secondaryButton}
        type="button"
        disabled={offset + pageItems >= total}
        onClick={() => onOffsetChange(offset + limit)}
      >
        Next
      </button>
    </nav>
  );
}

function CategoryResults({
  data,
  onEdit,
}: {
  data: AdminCategoryListResponse;
  onEdit: (category: AdminCategory) => void;
}) {
  return (
    <>
      <p className={styles.resultSummary} aria-live="polite">
        Showing {data.offset + 1}–{data.offset + data.items.length} of {data.total}
      </p>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <caption>Administrator categories in backend order</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Description</th>
              <th scope="col">Display order</th>
              <th scope="col">Active</th>
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
                <td>{category.isActive ? 'Active' : 'Inactive'}</td>
                <td>
                  <time dateTime={category.updatedAt}>
                    {formatAdminMenuDate(category.updatedAt)}
                  </time>
                </td>
                <td>
                  <button
                    className={styles.compactButton}
                    type="button"
                    onClick={() => onEdit(category)}
                  >
                    Edit <span className={styles.visuallyHidden}>{category.name}</span>
                  </button>
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
                  <dt>Status</dt>
                  <dd>{category.isActive ? 'Active' : 'Inactive'}</dd>
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
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => onEdit(category)}
              >
                Edit category
              </button>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

function ItemResults({
  categoryNames,
  data,
  onEdit,
}: {
  categoryNames: Map<string, string>;
  data: AdminMenuItemListResponse;
  onEdit: (item: AdminMenuItem) => void;
}) {
  const categoryName = (id: string) => categoryNames.get(id) ?? 'Category not loaded';
  return (
    <>
      <p className={styles.resultSummary} aria-live="polite">
        Showing {data.offset + 1}–{data.offset + data.items.length} of {data.total}
      </p>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <caption>Administrator menu items in backend order</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Category</th>
              <th scope="col">Price</th>
              <th scope="col">Currency</th>
              <th scope="col">Active</th>
              <th scope="col">Available</th>
              <th scope="col">Display order</th>
              <th scope="col">Updated</th>
              <th scope="col">Action</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.id}>
                <th scope="row">{item.name}</th>
                <td>{categoryName(item.categoryId)}</td>
                <td>{formatAdminMenuMoney(item.priceAmount, item.currency)}</td>
                <td>{item.currency}</td>
                <td>{item.isActive ? 'Active' : 'Inactive'}</td>
                <td>{item.isAvailable ? 'Available' : 'Unavailable'}</td>
                <td>{item.displayOrder}</td>
                <td>
                  <time dateTime={item.updatedAt}>
                    {formatAdminMenuDate(item.updatedAt)}
                  </time>
                </td>
                <td>
                  <button
                    className={styles.compactButton}
                    type="button"
                    onClick={() => onEdit(item)}
                  >
                    Edit <span className={styles.visuallyHidden}>{item.name}</span>
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className={styles.cards} aria-label="Administrator menu items">
        {data.items.map((item) => (
          <li className={styles.card} key={item.id}>
            <article>
              <h3>{item.name}</h3>
              <p>{categoryName(item.categoryId)}</p>
              <dl className={styles.cardDetails}>
                <div>
                  <dt>Price</dt>
                  <dd>{formatAdminMenuMoney(item.priceAmount, item.currency)}</dd>
                </div>
                <div>
                  <dt>Currency</dt>
                  <dd>{item.currency}</dd>
                </div>
                <div>
                  <dt>Active</dt>
                  <dd>{item.isActive ? 'Active' : 'Inactive'}</dd>
                </div>
                <div>
                  <dt>Available</dt>
                  <dd>{item.isAvailable ? 'Available' : 'Unavailable'}</dd>
                </div>
                <div>
                  <dt>Display order</dt>
                  <dd>{item.displayOrder}</dd>
                </div>
              </dl>
              <button
                className={styles.secondaryButton}
                type="button"
                onClick={() => onEdit(item)}
              >
                Edit menu item
              </button>
            </article>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function AdminMenuPage() {
  const { expireSession, getAccessToken } = useAdminAuth();
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
  const categoryControllerRef = useRef<AbortController | null>(null);
  const itemControllerRef = useRef<AbortController | null>(null);
  const optionsControllerRef = useRef<AbortController | null>(null);
  const categoryGenerationRef = useRef(0);
  const itemGenerationRef = useRef(0);

  const loadCategories = useCallback(async () => {
    const token = getAccessToken();
    if (token === null) return expireSession();
    categoryGenerationRef.current += 1;
    const generation = categoryGenerationRef.current;
    categoryControllerRef.current?.abort();
    const controller = new AbortController();
    categoryControllerRef.current = controller;
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
      if (error instanceof AdminApiRequestError && error.status === 401)
        return expireSession();
      setCategoryState({
        kind: 'error',
        message: getListErrorMessage('categories', error),
      });
    }
  }, [categoryOffset, expireSession, getAccessToken]);

  const loadItems = useCallback(async () => {
    const token = getAccessToken();
    if (token === null) return expireSession();
    itemGenerationRef.current += 1;
    const generation = itemGenerationRef.current;
    itemControllerRef.current?.abort();
    const controller = new AbortController();
    itemControllerRef.current = controller;
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
      if (error instanceof AdminApiRequestError && error.status === 401)
        return expireSession();
      setItemState({
        kind: 'error',
        message: getListErrorMessage('menu items', error),
      });
    }
  }, [expireSession, getAccessToken, itemOffset]);

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

  const categoryNames = useMemo(() => {
    const categories =
      categoryOptions.kind === 'success'
        ? categoryOptions.categories
        : categoryState.kind === 'success'
          ? categoryState.data.items
          : [];
    return new Map(categories.map((category) => [category.id, category.name]));
  }, [categoryOptions, categoryState]);

  const openItemEditor = async (item: AdminMenuItem | null) => {
    if (categoryOptions.kind === 'success') {
      setItemEditor(item);
      return;
    }
    const token = getAccessToken();
    if (token === null) return expireSession();
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
      if (error instanceof AdminApiRequestError && error.status === 401)
        return expireSession();
      setCategoryOptions({
        kind: 'error',
        message: getListErrorMessage('categories', error),
      });
    }
  };

  const handleCategorySubmit = async (
    payload: AdminCategoryCreatePayload | AdminCategoryUpdatePayload,
  ) => {
    const token = getAccessToken();
    if (token === null) return expireSession();
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
      } catch (refreshError: unknown) {
        if (refreshError instanceof AdminApiRequestError && refreshError.status === 401)
          return expireSession();
        setCategoryNotice({
          message:
            'The category was saved, but the latest list could not be refreshed. Use Refresh.',
          title: 'Category saved',
          tone: 'success',
        });
      }
    } catch (error: unknown) {
      if (error instanceof AdminApiRequestError && error.status === 401)
        return expireSession();
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
    const token = getAccessToken();
    if (token === null) return expireSession();
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
      } catch (refreshError: unknown) {
        if (refreshError instanceof AdminApiRequestError && refreshError.status === 401)
          return expireSession();
        setItemNotice({
          message:
            'The menu item was saved, but the latest list could not be refreshed. Use Refresh.',
          title: 'Menu item saved',
          tone: 'success',
        });
      }
    } catch (error: unknown) {
      if (error instanceof AdminApiRequestError && error.status === 401)
        return expireSession();
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
          Manage current categories and menu items without deleting historical records.
        </p>
        <p className={styles.snapshotWarning}>
          Changes affect future orders only. Historical order snapshots and analytics do
          not change.
        </p>
      </header>

      <section className={styles.resourceSection} aria-labelledby="categories-heading">
        <header className={styles.sectionHeader}>
          <div>
            <h2 id="categories-heading">Categories</h2>
            <p>Manage active and inactive category records.</p>
          </div>
          <div className={styles.sectionActions}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={categoryBusy}
              onClick={() => setCategoryEditor(null)}
            >
              Add category
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={categoryState.kind === 'loading' || categoryBusy}
              onClick={() => void loadCategories()}
            >
              Refresh categories
            </button>
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
            onCancel={() => setCategoryEditor(undefined)}
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
            heading="Unable to load categories"
            message={categoryState.message}
            onRetry={() => void loadCategories()}
          />
        ) : null}
        {categoryState.kind === 'success' && categoryState.data.items.length === 0 ? (
          <StatePanel
            heading="No categories yet"
            message="Create a category before adding menu items."
          />
        ) : null}
        {categoryState.kind === 'success' && categoryState.data.items.length > 0 ? (
          <CategoryResults data={categoryState.data} onEdit={setCategoryEditor} />
        ) : null}
        {categoryState.kind === 'success' && categoryState.data.total > 0 ? (
          <Pagination
            label="Categories"
            limit={PAGE_LIMIT}
            offset={categoryOffset}
            pageItems={categoryState.data.items.length}
            total={categoryState.data.total}
            onOffsetChange={setCategoryOffset}
          />
        ) : null}
      </section>

      <section className={styles.resourceSection} aria-labelledby="items-heading">
        <header className={styles.sectionHeader}>
          <div>
            <h2 id="items-heading">Menu items</h2>
            <p>Activity and availability remain independent controls.</p>
          </div>
          <div className={styles.sectionActions}>
            <button
              className={styles.primaryButton}
              type="button"
              disabled={
                itemBusy ||
                categoryState.kind !== 'success' ||
                categoryState.data.total === 0 ||
                categoryOptions.kind === 'loading'
              }
              onClick={() => void openItemEditor(null)}
            >
              Add menu item
            </button>
            <button
              className={styles.secondaryButton}
              type="button"
              disabled={itemState.kind === 'loading' || itemBusy}
              onClick={() => void loadItems()}
            >
              Refresh menu items
            </button>
          </div>
        </header>
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
            onCancel={() => setItemEditor(undefined)}
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
            heading="Unable to load menu items"
            message={itemState.message}
            onRetry={() => void loadItems()}
          />
        ) : null}
        {itemState.kind === 'success' && itemState.data.items.length === 0 ? (
          <StatePanel
            heading="No menu items yet"
            message="Menu items will appear here after they are created."
          />
        ) : null}
        {itemState.kind === 'success' && itemState.data.items.length > 0 ? (
          <ItemResults
            categoryNames={categoryNames}
            data={itemState.data}
            onEdit={(item) => void openItemEditor(item)}
          />
        ) : null}
        {itemState.kind === 'success' && itemState.data.total > 0 ? (
          <Pagination
            label="Menu items"
            limit={PAGE_LIMIT}
            offset={itemOffset}
            pageItems={itemState.data.items.length}
            total={itemState.data.total}
            onOffsetChange={setItemOffset}
          />
        ) : null}
      </section>
    </section>
  );
}
