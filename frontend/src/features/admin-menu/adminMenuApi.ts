import { AdminApiRequestError, adminRequestJson } from '../../api/adminApi';

const CATEGORY_PATH = '/api/v1/admin/menu/categories';
const ITEM_PATH = '/api/v1/admin/menu/items';
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AWARE_TIMESTAMP_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;
const CATEGORY_KEYS = [
  'id',
  'name',
  'description',
  'display_order',
  'is_active',
  'created_at',
  'updated_at',
] as const;
const ITEM_KEYS = [
  'id',
  'category_id',
  'name',
  'description',
  'image_url',
  'price_amount',
  'cost_amount',
  'currency',
  'allergens',
  'display_order',
  'is_active',
  'is_available',
  'created_at',
  'updated_at',
] as const;
const LIST_KEYS = ['items', 'total', 'limit', 'offset'] as const;
const ALL_CATEGORY_PAGE_LIMIT = 100;
const MAX_CATEGORY_PAGES = 100;

export interface AdminCategory {
  createdAt: string;
  description: string | null;
  displayOrder: number;
  id: string;
  isActive: boolean;
  name: string;
  updatedAt: string;
}

export interface AdminCategoryListResponse {
  items: AdminCategory[];
  limit: number;
  offset: number;
  total: number;
}

export interface AdminCategoryCreatePayload {
  description: string | null;
  display_order: number;
  is_active: boolean;
  name: string;
}

export type AdminCategoryUpdatePayload = Partial<AdminCategoryCreatePayload>;

export interface AdminMenuItem {
  allergens: string[];
  categoryId: string;
  costAmount: number | null;
  createdAt: string;
  currency: string;
  description: string | null;
  displayOrder: number;
  id: string;
  imageUrl: string | null;
  isActive: boolean;
  isAvailable: boolean;
  name: string;
  priceAmount: number;
  updatedAt: string;
}

export interface AdminMenuItemListResponse {
  items: AdminMenuItem[];
  limit: number;
  offset: number;
  total: number;
}

export interface AdminMenuItemCreatePayload {
  allergens: string[];
  category_id: string;
  cost_amount: number | null;
  currency: string;
  description: string | null;
  display_order: number;
  image_url: string | null;
  is_active: boolean;
  is_available: boolean;
  name: string;
  price_amount: number;
}

export type AdminMenuItemUpdatePayload = Partial<AdminMenuItemCreatePayload>;

function invalidResponse(): never {
  throw new AdminApiRequestError(
    'invalid-response',
    'The administrator menu response did not match the expected contract.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && keys.every((key) => key in value);
}

function isSafeInteger(value: unknown, minimum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum;
}

function isAwareTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AWARE_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseCategory(value: unknown): AdminCategory {
  if (
    !hasExactKeys(value, CATEGORY_KEYS) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 120 ||
    !(value.description === null || typeof value.description === 'string') ||
    !isSafeInteger(value.display_order, 0) ||
    typeof value.is_active !== 'boolean' ||
    !isAwareTimestamp(value.created_at) ||
    !isAwareTimestamp(value.updated_at)
  ) {
    return invalidResponse();
  }
  return {
    createdAt: value.created_at,
    description: value.description,
    displayOrder: value.display_order,
    id: value.id,
    isActive: value.is_active,
    name: value.name,
    updatedAt: value.updated_at,
  };
}

function parseMenuItem(value: unknown): AdminMenuItem {
  if (
    !hasExactKeys(value, ITEM_KEYS) ||
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.category_id !== 'string' ||
    !UUID_PATTERN.test(value.category_id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 120 ||
    !(value.description === null || typeof value.description === 'string') ||
    !(value.image_url === null || typeof value.image_url === 'string') ||
    (typeof value.image_url === 'string' && value.image_url.length > 2_048) ||
    !isSafeInteger(value.price_amount, 1) ||
    !(value.cost_amount === null || isSafeInteger(value.cost_amount, 0)) ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !Array.isArray(value.allergens) ||
    !value.allergens.every((allergen) => typeof allergen === 'string') ||
    !isSafeInteger(value.display_order, 0) ||
    typeof value.is_active !== 'boolean' ||
    typeof value.is_available !== 'boolean' ||
    !isAwareTimestamp(value.created_at) ||
    !isAwareTimestamp(value.updated_at)
  ) {
    return invalidResponse();
  }
  return {
    allergens: value.allergens,
    categoryId: value.category_id,
    costAmount: value.cost_amount,
    createdAt: value.created_at,
    currency: value.currency,
    description: value.description,
    displayOrder: value.display_order,
    id: value.id,
    imageUrl: value.image_url,
    isActive: value.is_active,
    isAvailable: value.is_available,
    name: value.name,
    priceAmount: value.price_amount,
    updatedAt: value.updated_at,
  };
}

function parseCategoryList(value: unknown): AdminCategoryListResponse {
  if (
    !hasExactKeys(value, LIST_KEYS) ||
    !Array.isArray(value.items) ||
    !isSafeInteger(value.total, 0) ||
    !isSafeInteger(value.limit, 1) ||
    value.limit > 100 ||
    !isSafeInteger(value.offset, 0)
  ) {
    return invalidResponse();
  }
  return {
    items: value.items.map(parseCategory),
    limit: value.limit,
    offset: value.offset,
    total: value.total,
  };
}

function parseItemList(value: unknown): AdminMenuItemListResponse {
  if (
    !hasExactKeys(value, LIST_KEYS) ||
    !Array.isArray(value.items) ||
    !isSafeInteger(value.total, 0) ||
    !isSafeInteger(value.limit, 1) ||
    value.limit > 100 ||
    !isSafeInteger(value.offset, 0)
  ) {
    return invalidResponse();
  }
  return {
    items: value.items.map(parseMenuItem),
    limit: value.limit,
    offset: value.offset,
    total: value.total,
  };
}

/** Fetch one deterministic administrator category page. */
export async function fetchAdminCategories(
  accessToken: string,
  limit = 50,
  offset = 0,
  signal?: AbortSignal,
): Promise<AdminCategoryListResponse> {
  const value = await adminRequestJson(
    `${CATEGORY_PATH}?limit=${limit}&offset=${offset}`,
    { accessToken, signal },
  );
  const parsed = parseCategoryList(value);
  if (parsed.limit !== limit || parsed.offset !== offset) {
    return invalidResponse();
  }
  return parsed;
}

/** Fetch every category page for safe menu-item reassignment choices. */
export async function fetchAllAdminCategories(
  accessToken: string,
  signal?: AbortSignal,
): Promise<AdminCategory[]> {
  const categories: AdminCategory[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_CATEGORY_PAGES; page += 1) {
    const response = await fetchAdminCategories(
      accessToken,
      ALL_CATEGORY_PAGE_LIMIT,
      offset,
      signal,
    );
    categories.push(...response.items);
    offset += response.items.length;
    if (offset >= response.total) {
      return categories;
    }
    if (response.items.length === 0) {
      return invalidResponse();
    }
  }
  return invalidResponse();
}

/** Create one category with the exact backend payload. */
export async function createAdminCategory(
  accessToken: string,
  payload: AdminCategoryCreatePayload,
  signal?: AbortSignal,
): Promise<AdminCategory> {
  return parseCategory(
    await adminRequestJson(CATEGORY_PATH, {
      accessToken,
      body: payload,
      method: 'POST',
      signal,
    }),
  );
}

/** Update one category with intentionally changed fields only. */
export async function updateAdminCategory(
  accessToken: string,
  categoryId: string,
  payload: AdminCategoryUpdatePayload,
  signal?: AbortSignal,
): Promise<AdminCategory> {
  if (Object.keys(payload).length === 0) {
    throw new AdminApiRequestError(
      'invalid-response',
      'A category update is required.',
    );
  }
  const category = parseCategory(
    await adminRequestJson(`${CATEGORY_PATH}/${encodeURIComponent(categoryId)}`, {
      accessToken,
      body: payload,
      method: 'PATCH',
      signal,
    }),
  );
  if (category.id !== categoryId) {
    return invalidResponse();
  }
  return category;
}

/** Fetch one deterministic administrator menu-item page. */
export async function fetchAdminMenuItems(
  accessToken: string,
  limit = 50,
  offset = 0,
  signal?: AbortSignal,
): Promise<AdminMenuItemListResponse> {
  const value = await adminRequestJson(`${ITEM_PATH}?limit=${limit}&offset=${offset}`, {
    accessToken,
    signal,
  });
  const parsed = parseItemList(value);
  if (parsed.limit !== limit || parsed.offset !== offset) {
    return invalidResponse();
  }
  return parsed;
}

/** Create one menu item with the exact backend payload. */
export async function createAdminMenuItem(
  accessToken: string,
  payload: AdminMenuItemCreatePayload,
  signal?: AbortSignal,
): Promise<AdminMenuItem> {
  return parseMenuItem(
    await adminRequestJson(ITEM_PATH, {
      accessToken,
      body: payload,
      method: 'POST',
      signal,
    }),
  );
}

/** Update one menu item with intentionally changed fields only. */
export async function updateAdminMenuItem(
  accessToken: string,
  itemId: string,
  payload: AdminMenuItemUpdatePayload,
  signal?: AbortSignal,
): Promise<AdminMenuItem> {
  if (Object.keys(payload).length === 0) {
    throw new AdminApiRequestError(
      'invalid-response',
      'A menu-item update is required.',
    );
  }
  const item = parseMenuItem(
    await adminRequestJson(`${ITEM_PATH}/${encodeURIComponent(itemId)}`, {
      accessToken,
      body: payload,
      method: 'PATCH',
      signal,
    }),
  );
  if (item.id !== itemId) {
    return invalidResponse();
  }
  return item;
}

/** Format one aware timestamp for administrator menu presentation. */
export function formatAdminMenuDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-NO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/** Format a validated minor-unit amount for display only. */
export function formatAdminMenuMoney(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-NO', { currency, style: 'currency' });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  return formatter.format(amount / 10 ** digits);
}
