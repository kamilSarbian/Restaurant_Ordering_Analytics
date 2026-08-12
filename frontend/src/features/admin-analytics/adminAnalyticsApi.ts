import { AdminApiRequestError, adminRequestJson } from '../../api/adminApi';

const ANALYTICS_PATH = '/api/v1/admin/analytics';
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AWARE_TIMESTAMP_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;
const RANGE_KEYS = ['start', 'end', 'timezone'] as const;
const OVERVIEW_KEYS = ['range', 'currencies'] as const;
const OVERVIEW_CURRENCY_KEYS = [
  'currency',
  'collected_revenue_amount',
  'succeeded_orders_count',
  'average_order_value_amount',
] as const;
const BREAKDOWN_KEYS = ['range', 'limit_per_currency', 'items'] as const;
const PRODUCT_KEYS = [
  'menu_item_id',
  'item_name',
  'currency',
  'quantity_sold',
  'sales_amount',
] as const;
const CATEGORY_KEYS = [
  'category_name',
  'currency',
  'quantity_sold',
  'sales_amount',
] as const;
const ORDER_TYPE_RESPONSE_KEYS = ['range', 'items'] as const;
const ORDER_TYPE_KEYS = [
  'order_type',
  'currency',
  'succeeded_orders_count',
  'collected_revenue_amount',
] as const;

export interface AdminAnalyticsQuery {
  currency?: string;
  end: string;
  start: string;
}

export interface AdminAnalyticsBreakdownQuery extends AdminAnalyticsQuery {
  limit: number;
}

export interface AdminAnalyticsRange {
  end: string;
  start: string;
  timezone: 'Europe/Oslo';
}

export interface AdminAnalyticsOverviewCurrency {
  averageOrderValueAmount: number;
  collectedRevenueAmount: number;
  currency: string;
  succeededOrdersCount: number;
}

export interface AdminAnalyticsOverview {
  currencies: AdminAnalyticsOverviewCurrency[];
  range: AdminAnalyticsRange;
}

export interface AdminProductSalesItem {
  currency: string;
  itemName: string;
  quantitySold: number;
  salesAmount: number;
}

export interface AdminProductSales {
  items: AdminProductSalesItem[];
  limitPerCurrency: number;
  range: AdminAnalyticsRange;
}

export interface AdminCategorySalesItem {
  categoryName: string;
  currency: string;
  quantitySold: number;
  salesAmount: number;
}

export interface AdminCategorySales {
  items: AdminCategorySalesItem[];
  limitPerCurrency: number;
  range: AdminAnalyticsRange;
}

export interface AdminOrderTypeSalesItem {
  collectedRevenueAmount: number;
  currency: string;
  orderType: 'dine_in' | 'takeaway';
  succeededOrdersCount: number;
}

export interface AdminOrderTypeSales {
  items: AdminOrderTypeSalesItem[];
  range: AdminAnalyticsRange;
}

function invalidResponse(): never {
  throw new AdminApiRequestError(
    'invalid-response',
    'The administrator analytics response did not match the expected contract.',
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys<T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function isSafeNonnegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

function isAwareTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AWARE_TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function parseRange(value: unknown): AdminAnalyticsRange {
  if (
    !hasExactKeys(value, RANGE_KEYS) ||
    !isAwareTimestamp(value.start) ||
    !isAwareTimestamp(value.end) ||
    value.timezone !== 'Europe/Oslo' ||
    Date.parse(value.start) >= Date.parse(value.end)
  ) {
    return invalidResponse();
  }
  return { end: value.end, start: value.start, timezone: value.timezone };
}

function parseOverviewCurrency(value: unknown): AdminAnalyticsOverviewCurrency {
  if (
    !hasExactKeys(value, OVERVIEW_CURRENCY_KEYS) ||
    !isCurrency(value.currency) ||
    !isSafeNonnegativeInteger(value.collected_revenue_amount) ||
    !isSafeNonnegativeInteger(value.succeeded_orders_count) ||
    !isSafeNonnegativeInteger(value.average_order_value_amount)
  ) {
    return invalidResponse();
  }
  return {
    averageOrderValueAmount: value.average_order_value_amount,
    collectedRevenueAmount: value.collected_revenue_amount,
    currency: value.currency,
    succeededOrdersCount: value.succeeded_orders_count,
  };
}

function parseOverview(value: unknown): AdminAnalyticsOverview {
  if (!hasExactKeys(value, OVERVIEW_KEYS) || !Array.isArray(value.currencies)) {
    return invalidResponse();
  }
  return {
    currencies: value.currencies.map(parseOverviewCurrency),
    range: parseRange(value.range),
  };
}

function parseProduct(value: unknown): AdminProductSalesItem {
  if (
    !hasExactKeys(value, PRODUCT_KEYS) ||
    typeof value.menu_item_id !== 'string' ||
    !UUID_PATTERN.test(value.menu_item_id) ||
    typeof value.item_name !== 'string' ||
    value.item_name.length === 0 ||
    !isCurrency(value.currency) ||
    !isSafeNonnegativeInteger(value.quantity_sold) ||
    !isSafeNonnegativeInteger(value.sales_amount)
  ) {
    return invalidResponse();
  }
  return {
    currency: value.currency,
    itemName: value.item_name,
    quantitySold: value.quantity_sold,
    salesAmount: value.sales_amount,
  };
}

function parseCategory(value: unknown): AdminCategorySalesItem {
  if (
    !hasExactKeys(value, CATEGORY_KEYS) ||
    typeof value.category_name !== 'string' ||
    value.category_name.length === 0 ||
    !isCurrency(value.currency) ||
    !isSafeNonnegativeInteger(value.quantity_sold) ||
    !isSafeNonnegativeInteger(value.sales_amount)
  ) {
    return invalidResponse();
  }
  return {
    categoryName: value.category_name,
    currency: value.currency,
    quantitySold: value.quantity_sold,
    salesAmount: value.sales_amount,
  };
}

function parseBreakdown<T>(
  value: unknown,
  parseItem: (item: unknown) => T,
): { items: T[]; limitPerCurrency: number; range: AdminAnalyticsRange } {
  if (
    !hasExactKeys(value, BREAKDOWN_KEYS) ||
    !Array.isArray(value.items) ||
    typeof value.limit_per_currency !== 'number' ||
    !Number.isSafeInteger(value.limit_per_currency) ||
    value.limit_per_currency < 1 ||
    value.limit_per_currency > 100
  ) {
    return invalidResponse();
  }
  return {
    items: value.items.map(parseItem),
    limitPerCurrency: value.limit_per_currency,
    range: parseRange(value.range),
  };
}

function parseOrderTypeItem(value: unknown): AdminOrderTypeSalesItem {
  if (
    !hasExactKeys(value, ORDER_TYPE_KEYS) ||
    (value.order_type !== 'dine_in' && value.order_type !== 'takeaway') ||
    !isCurrency(value.currency) ||
    !isSafeNonnegativeInteger(value.succeeded_orders_count) ||
    !isSafeNonnegativeInteger(value.collected_revenue_amount)
  ) {
    return invalidResponse();
  }
  return {
    collectedRevenueAmount: value.collected_revenue_amount,
    currency: value.currency,
    orderType: value.order_type,
    succeededOrdersCount: value.succeeded_orders_count,
  };
}

function parseOrderTypes(value: unknown): AdminOrderTypeSales {
  if (!hasExactKeys(value, ORDER_TYPE_RESPONSE_KEYS) || !Array.isArray(value.items)) {
    return invalidResponse();
  }
  return {
    items: value.items.map(parseOrderTypeItem),
    range: parseRange(value.range),
  };
}

function buildQuery(query: AdminAnalyticsQuery, limit?: number): string {
  const params = new URLSearchParams({ start: query.start, end: query.end });
  if (query.currency !== undefined) params.set('currency', query.currency);
  if (limit !== undefined) params.set('limit', String(limit));
  return params.toString();
}

function validateResponseRange(
  range: AdminAnalyticsRange,
  query: AdminAnalyticsQuery,
): void {
  if (
    Date.parse(range.start) !== Date.parse(query.start) ||
    Date.parse(range.end) !== Date.parse(query.end)
  ) {
    return invalidResponse();
  }
}

/** Fetch strict per-currency administrator overview KPIs. */
export async function fetchAdminAnalyticsOverview(
  accessToken: string,
  query: AdminAnalyticsQuery,
  signal?: AbortSignal,
): Promise<AdminAnalyticsOverview> {
  const parsed = parseOverview(
    await adminRequestJson(`${ANALYTICS_PATH}/overview?${buildQuery(query)}`, {
      accessToken,
      signal,
    }),
  );
  validateResponseRange(parsed.range, query);
  return parsed;
}

/** Fetch strict historical product sales in backend rank order. */
export async function fetchAdminProductSales(
  accessToken: string,
  query: AdminAnalyticsBreakdownQuery,
  signal?: AbortSignal,
): Promise<AdminProductSales> {
  const parsed = parseBreakdown(
    await adminRequestJson(
      `${ANALYTICS_PATH}/products?${buildQuery(query, query.limit)}`,
      { accessToken, signal },
    ),
    parseProduct,
  );
  validateResponseRange(parsed.range, query);
  if (parsed.limitPerCurrency !== query.limit) return invalidResponse();
  return parsed;
}

/** Fetch strict historical category sales in backend rank order. */
export async function fetchAdminCategorySales(
  accessToken: string,
  query: AdminAnalyticsBreakdownQuery,
  signal?: AbortSignal,
): Promise<AdminCategorySales> {
  const parsed = parseBreakdown(
    await adminRequestJson(
      `${ANALYTICS_PATH}/categories?${buildQuery(query, query.limit)}`,
      { accessToken, signal },
    ),
    parseCategory,
  );
  validateResponseRange(parsed.range, query);
  if (parsed.limitPerCurrency !== query.limit) return invalidResponse();
  return parsed;
}

/** Fetch strict per-currency order-type sales in backend order. */
export async function fetchAdminOrderTypeSales(
  accessToken: string,
  query: AdminAnalyticsQuery,
  signal?: AbortSignal,
): Promise<AdminOrderTypeSales> {
  const parsed = parseOrderTypes(
    await adminRequestJson(`${ANALYTICS_PATH}/order-types?${buildQuery(query)}`, {
      accessToken,
      signal,
    }),
  );
  validateResponseRange(parsed.range, query);
  return parsed;
}

/** Format a minor-unit amount using the currency's resolved display precision. */
export function formatAnalyticsMoney(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-NO', { currency, style: 'currency' });
  const digits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  return formatter.format(amount / 10 ** digits);
}

/** Format an analytics count without fractional digits. */
export function formatAnalyticsCount(count: number): string {
  return new Intl.NumberFormat('en-NO', { maximumFractionDigits: 0 }).format(count);
}
