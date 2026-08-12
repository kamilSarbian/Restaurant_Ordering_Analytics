import { AdminApiRequestError, adminRequestJson } from '../../api/adminApi';

export const ORDER_STATUSES = [
  'created',
  'accepted',
  'preparing',
  'ready',
  'completed',
  'cancelled',
] as const;

export const ORDER_TYPES = ['dine_in', 'takeaway'] as const;
export const PAYMENT_STATUSES = ['pending', 'succeeded', 'failed', 'expired'] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];
export type OrderType = (typeof ORDER_TYPES)[number];
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface AdminOrderListQuery {
  limit?: number;
  offset?: number;
  orderType?: OrderType;
  status?: OrderStatus;
}

export interface AdminOrderListItem {
  createdAt: string;
  currency: string;
  orderType: OrderType;
  publicOrderNumber: string;
  status: OrderStatus;
  tableNumber: number | null;
  totalAmount: number;
  updatedAt: string;
}

export interface AdminOrderListResponse {
  items: AdminOrderListItem[];
  limit: number;
  offset: number;
  total: number;
}

export interface AdminOrderItem {
  categoryName: string;
  discountAmount: number;
  id: string;
  lineTotalAmount: number;
  menuItemId: string;
  name: string;
  position: number;
  quantity: number;
  taxRateBps: number | null;
  unitCostAmount: number | null;
  unitPriceAmount: number;
}

export interface AdminOrderStatusHistoryEntry {
  changedAt: string;
  newStatus: OrderStatus;
  previousStatus: OrderStatus | null;
  sequence: number;
}

export interface AdminOrderStatusUpdateResponse {
  history: AdminOrderStatusHistoryEntry;
  publicOrderNumber: string;
  status: OrderStatus;
  updatedAt: string;
}

export interface AdminPaymentSummary {
  amount: number;
  checkoutExpiresAt: string | null;
  createdAt: string;
  currency: string;
  id: string;
  status: PaymentStatus;
  updatedAt: string;
}

export interface AdminOrderDetail {
  createdAt: string;
  currency: string;
  items: AdminOrderItem[];
  orderId: string;
  orderType: OrderType;
  payments: AdminPaymentSummary[];
  publicOrderNumber: string;
  status: OrderStatus;
  statusHistory: AdminOrderStatusHistoryEntry[];
  subtotalAmount: number;
  tableNumber: number | null;
  totalAmount: number;
  updatedAt: string;
}

const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AWARE_TIMESTAMP_PATTERN = /(?:Z|[+-]\d{2}:\d{2})$/;

const LIST_ITEM_KEYS = [
  'public_order_number',
  'status',
  'order_type',
  'table_number',
  'total_amount',
  'currency',
  'created_at',
  'updated_at',
] as const;
const LIST_RESPONSE_KEYS = ['items', 'total', 'limit', 'offset'] as const;
const DETAIL_KEYS = [
  'order_id',
  'public_order_number',
  'status',
  'order_type',
  'table_number',
  'currency',
  'subtotal_amount',
  'total_amount',
  'created_at',
  'updated_at',
  'items',
  'status_history',
  'payments',
] as const;
const ORDER_ITEM_KEYS = [
  'id',
  'menu_item_id',
  'position',
  'category_name',
  'name',
  'quantity',
  'unit_price_amount',
  'unit_cost_amount',
  'tax_rate_bps',
  'discount_amount',
  'line_total_amount',
] as const;
const HISTORY_KEYS = [
  'sequence',
  'previous_status',
  'new_status',
  'changed_at',
] as const;
const STATUS_UPDATE_KEYS = [
  'public_order_number',
  'status',
  'updated_at',
  'history',
] as const;
const PAYMENT_KEYS = [
  'id',
  'status',
  'amount',
  'currency',
  'created_at',
  'updated_at',
  'checkout_expires_at',
] as const;

function invalidResponse(): never {
  throw new AdminApiRequestError(
    'invalid-response',
    'The administrator orders response did not match the expected contract.',
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

function isSafeIntegerInRange(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isAwareTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AWARE_TIMESTAMP_PATTERN.test(value) &&
    Number.isNaN(Date.parse(value)) === false
  );
}

function isCurrency(value: unknown): value is string {
  return typeof value === 'string' && CURRENCY_PATTERN.test(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function isOrderStatus(value: unknown): value is OrderStatus {
  return ORDER_STATUSES.some((status) => status === value);
}

function isOrderType(value: unknown): value is OrderType {
  return ORDER_TYPES.some((orderType) => orderType === value);
}

function isPaymentStatus(value: unknown): value is PaymentStatus {
  return PAYMENT_STATUSES.some((status) => status === value);
}

function parseListItem(value: unknown): AdminOrderListItem {
  if (
    !hasExactKeys(value, LIST_ITEM_KEYS) ||
    typeof value.public_order_number !== 'string' ||
    !PUBLIC_ORDER_NUMBER_PATTERN.test(value.public_order_number) ||
    !isOrderStatus(value.status) ||
    !isOrderType(value.order_type) ||
    !(
      value.table_number === null ||
      isSafeIntegerInRange(value.table_number, 1, Number.MAX_SAFE_INTEGER)
    ) ||
    !isSafeIntegerInRange(value.total_amount, 1, Number.MAX_SAFE_INTEGER) ||
    !isCurrency(value.currency) ||
    !isAwareTimestamp(value.created_at) ||
    !isAwareTimestamp(value.updated_at)
  ) {
    return invalidResponse();
  }

  return {
    createdAt: value.created_at,
    currency: value.currency,
    orderType: value.order_type,
    publicOrderNumber: value.public_order_number,
    status: value.status,
    tableNumber: value.table_number,
    totalAmount: value.total_amount,
    updatedAt: value.updated_at,
  };
}

function parseOrderItem(value: unknown): AdminOrderItem {
  if (
    !hasExactKeys(value, ORDER_ITEM_KEYS) ||
    !isUuid(value.id) ||
    !isUuid(value.menu_item_id) ||
    !isSafeIntegerInRange(value.position, 0, Number.MAX_SAFE_INTEGER) ||
    typeof value.category_name !== 'string' ||
    value.category_name.length === 0 ||
    typeof value.name !== 'string' ||
    value.name.length === 0 ||
    !isSafeIntegerInRange(value.quantity, 1, 99) ||
    !isSafeIntegerInRange(value.unit_price_amount, 1, Number.MAX_SAFE_INTEGER) ||
    !(
      value.unit_cost_amount === null ||
      isSafeIntegerInRange(value.unit_cost_amount, 0, Number.MAX_SAFE_INTEGER)
    ) ||
    !(
      value.tax_rate_bps === null || isSafeIntegerInRange(value.tax_rate_bps, 0, 10_000)
    ) ||
    !isSafeIntegerInRange(value.discount_amount, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntegerInRange(value.line_total_amount, 1, Number.MAX_SAFE_INTEGER)
  ) {
    return invalidResponse();
  }

  return {
    categoryName: value.category_name,
    discountAmount: value.discount_amount,
    id: value.id,
    lineTotalAmount: value.line_total_amount,
    menuItemId: value.menu_item_id,
    name: value.name,
    position: value.position,
    quantity: value.quantity,
    taxRateBps: value.tax_rate_bps,
    unitCostAmount: value.unit_cost_amount,
    unitPriceAmount: value.unit_price_amount,
  };
}

function parseHistoryEntry(value: unknown): AdminOrderStatusHistoryEntry {
  if (
    !hasExactKeys(value, HISTORY_KEYS) ||
    !isSafeIntegerInRange(value.sequence, 0, Number.MAX_SAFE_INTEGER) ||
    !(value.previous_status === null || isOrderStatus(value.previous_status)) ||
    !isOrderStatus(value.new_status) ||
    !isAwareTimestamp(value.changed_at)
  ) {
    return invalidResponse();
  }

  return {
    changedAt: value.changed_at,
    newStatus: value.new_status,
    previousStatus: value.previous_status,
    sequence: value.sequence,
  };
}

function parsePayment(value: unknown): AdminPaymentSummary {
  if (
    !hasExactKeys(value, PAYMENT_KEYS) ||
    !isUuid(value.id) ||
    !isPaymentStatus(value.status) ||
    !isSafeIntegerInRange(value.amount, 1, Number.MAX_SAFE_INTEGER) ||
    !isCurrency(value.currency) ||
    !isAwareTimestamp(value.created_at) ||
    !isAwareTimestamp(value.updated_at) ||
    !(value.checkout_expires_at === null || isAwareTimestamp(value.checkout_expires_at))
  ) {
    return invalidResponse();
  }

  return {
    amount: value.amount,
    checkoutExpiresAt: value.checkout_expires_at,
    createdAt: value.created_at,
    currency: value.currency,
    id: value.id,
    status: value.status,
    updatedAt: value.updated_at,
  };
}

function parseListResponse(value: unknown): AdminOrderListResponse {
  if (
    !hasExactKeys(value, LIST_RESPONSE_KEYS) ||
    !Array.isArray(value.items) ||
    !isSafeIntegerInRange(value.total, 0, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntegerInRange(value.limit, 1, 100) ||
    !isSafeIntegerInRange(value.offset, 0, Number.MAX_SAFE_INTEGER)
  ) {
    return invalidResponse();
  }

  return {
    items: value.items.map(parseListItem),
    limit: value.limit,
    offset: value.offset,
    total: value.total,
  };
}

function parseDetailResponse(value: unknown): AdminOrderDetail {
  if (
    !hasExactKeys(value, DETAIL_KEYS) ||
    !isUuid(value.order_id) ||
    typeof value.public_order_number !== 'string' ||
    !PUBLIC_ORDER_NUMBER_PATTERN.test(value.public_order_number) ||
    !isOrderStatus(value.status) ||
    !isOrderType(value.order_type) ||
    !(
      value.table_number === null ||
      isSafeIntegerInRange(value.table_number, 1, Number.MAX_SAFE_INTEGER)
    ) ||
    !isCurrency(value.currency) ||
    !isSafeIntegerInRange(value.subtotal_amount, 1, Number.MAX_SAFE_INTEGER) ||
    !isSafeIntegerInRange(value.total_amount, 1, Number.MAX_SAFE_INTEGER) ||
    !isAwareTimestamp(value.created_at) ||
    !isAwareTimestamp(value.updated_at) ||
    !Array.isArray(value.items) ||
    !Array.isArray(value.status_history) ||
    !Array.isArray(value.payments)
  ) {
    return invalidResponse();
  }

  return {
    createdAt: value.created_at,
    currency: value.currency,
    items: value.items.map(parseOrderItem),
    orderId: value.order_id,
    orderType: value.order_type,
    payments: value.payments.map(parsePayment),
    publicOrderNumber: value.public_order_number,
    status: value.status,
    statusHistory: value.status_history.map(parseHistoryEntry),
    subtotalAmount: value.subtotal_amount,
    tableNumber: value.table_number,
    totalAmount: value.total_amount,
    updatedAt: value.updated_at,
  };
}

function parseStatusUpdateResponse(value: unknown): AdminOrderStatusUpdateResponse {
  if (
    !hasExactKeys(value, STATUS_UPDATE_KEYS) ||
    typeof value.public_order_number !== 'string' ||
    !PUBLIC_ORDER_NUMBER_PATTERN.test(value.public_order_number) ||
    !isOrderStatus(value.status) ||
    !isAwareTimestamp(value.updated_at)
  ) {
    return invalidResponse();
  }

  return {
    history: parseHistoryEntry(value.history),
    publicOrderNumber: value.public_order_number,
    status: value.status,
    updatedAt: value.updated_at,
  };
}

/** Fetch one exact administrator order page through the authenticated transport. */
export async function fetchAdminOrders(
  accessToken: string,
  query: AdminOrderListQuery = {},
  signal?: AbortSignal,
): Promise<AdminOrderListResponse> {
  const parameters = new URLSearchParams();
  if (query.status !== undefined) {
    parameters.set('status', query.status);
  }
  if (query.orderType !== undefined) {
    parameters.set('order_type', query.orderType);
  }
  parameters.set('limit', String(query.limit ?? 50));
  parameters.set('offset', String(query.offset ?? 0));

  const requestedLimit = query.limit ?? 50;
  const requestedOffset = query.offset ?? 0;
  const response = await adminRequestJson(
    `/api/v1/admin/orders?${parameters.toString()}`,
    { accessToken, signal },
  );
  const parsedResponse = parseListResponse(response);
  if (
    parsedResponse.limit !== requestedLimit ||
    parsedResponse.offset !== requestedOffset
  ) {
    return invalidResponse();
  }
  return parsedResponse;
}

/** Fetch one exact read-only administrator order detail. */
export async function fetchAdminOrderDetail(
  accessToken: string,
  publicOrderNumber: string,
  signal?: AbortSignal,
): Promise<AdminOrderDetail> {
  const response = await adminRequestJson(
    `/api/v1/admin/orders/${encodeURIComponent(publicOrderNumber)}`,
    { accessToken, signal },
  );
  const parsedResponse = parseDetailResponse(response);
  if (parsedResponse.publicOrderNumber !== publicOrderNumber) {
    return invalidResponse();
  }
  return parsedResponse;
}

/** Apply one exact administrator order-status transition. */
export async function updateAdminOrderStatus(
  accessToken: string,
  publicOrderNumber: string,
  targetStatus: OrderStatus,
  signal?: AbortSignal,
): Promise<AdminOrderStatusUpdateResponse> {
  const response = await adminRequestJson(
    `/api/v1/admin/orders/${encodeURIComponent(publicOrderNumber)}/status`,
    {
      accessToken,
      body: { status: targetStatus },
      method: 'PATCH',
      signal,
    },
  );
  const parsedResponse = parseStatusUpdateResponse(response);
  if (
    parsedResponse.publicOrderNumber !== publicOrderNumber ||
    parsedResponse.status !== targetStatus ||
    parsedResponse.history.newStatus !== targetStatus
  ) {
    return invalidResponse();
  }
  return parsedResponse;
}

/** Format an integer minor-unit amount with the currency's standard precision. */
export function formatAdminMoney(amount: number, currency: string): string {
  const formatter = new Intl.NumberFormat('en-NO', {
    currency,
    style: 'currency',
  });
  const fractionDigits = formatter.resolvedOptions().maximumFractionDigits ?? 0;
  return formatter.format(amount / 10 ** fractionDigits);
}

/** Format one aware backend timestamp for the administrator locale. */
export function formatAdminDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-NO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp));
}

/** Return the approved human-readable order-status label. */
export function getOrderStatusLabel(status: OrderStatus): string {
  return {
    accepted: 'Accepted',
    cancelled: 'Cancelled',
    completed: 'Completed',
    created: 'Created',
    preparing: 'Preparing',
    ready: 'Ready',
  }[status];
}

/** Return the approved human-readable order-type label. */
export function getOrderTypeLabel(orderType: OrderType): string {
  return orderType === 'dine_in' ? 'Dine in' : 'Takeaway';
}

/** Return a safe human-readable payment-status label. */
export function getPaymentStatusLabel(status: PaymentStatus): string {
  return {
    expired: 'Expired',
    failed: 'Failed',
    pending: 'Pending',
    succeeded: 'Succeeded',
  }[status];
}
