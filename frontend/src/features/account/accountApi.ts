import {
  AuthenticatedApiRequestError,
  authenticatedRequestJson,
} from '../../api/authenticatedApi';
import { parseOrderStatusResponse } from '../../api/customerApi';
import type { OrderStatus, OrderStatusResponse, OrderType } from '../../api/types';

const ACCOUNT_ORDERS_PATH = '/api/v1/account/orders';
const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const AWARE_DATETIME_PATTERN = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const LIST_RESPONSE_KEYS = ['items', 'limit', 'offset', 'total'];
const LIST_ITEM_KEYS = [
  'created_at',
  'currency',
  'order_type',
  'public_order_number',
  'status',
  'total_amount',
  'updated_at',
];
const ORDER_STATUSES = new Set<OrderStatus>([
  'accepted',
  'cancelled',
  'completed',
  'created',
  'preparing',
  'ready',
]);

/** Describe one customer-safe personally owned Order list item. */
export interface AccountOrderListItem {
  createdAt: string;
  currency: string;
  orderType: OrderType;
  publicOrderNumber: string;
  status: OrderStatus;
  totalAmount: number;
  updatedAt: string;
}

/** Describe one deterministic page of personally owned Orders. */
export interface AccountOrdersResponse {
  items: AccountOrderListItem[];
  limit: number;
  offset: number;
  total: number;
}

/** Configure one canonical account-order list request. */
export interface FetchAccountOrdersOptions {
  accessToken: string;
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

/** Configure one canonical account-order detail request. */
export interface FetchAccountOrderOptions {
  accessToken: string;
  signal?: AbortSignal;
}

function invalidAccountResponse(cause?: unknown): AuthenticatedApiRequestError {
  return new AuthenticatedApiRequestError(
    'invalid-response',
    'The account orders response did not match its contract.',
    { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const sortedExpectedKeys = [...expectedKeys].sort();
  return (
    actualKeys.length === sortedExpectedKeys.length &&
    actualKeys.every((key, index) => key === sortedExpectedKeys[index])
  );
}

function isAwareDatetime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AWARE_DATETIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseListItem(value: unknown): AccountOrderListItem {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, LIST_ITEM_KEYS) ||
    typeof value.public_order_number !== 'string' ||
    !PUBLIC_ORDER_NUMBER_PATTERN.test(value.public_order_number) ||
    typeof value.status !== 'string' ||
    !ORDER_STATUSES.has(value.status as OrderStatus) ||
    (value.order_type !== 'dine_in' && value.order_type !== 'takeaway') ||
    typeof value.total_amount !== 'number' ||
    !Number.isSafeInteger(value.total_amount) ||
    value.total_amount <= 0 ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !isAwareDatetime(value.created_at) ||
    !isAwareDatetime(value.updated_at)
  ) {
    throw invalidAccountResponse();
  }

  return {
    createdAt: value.created_at,
    currency: value.currency,
    orderType: value.order_type,
    publicOrderNumber: value.public_order_number,
    status: value.status as OrderStatus,
    totalAmount: value.total_amount,
    updatedAt: value.updated_at,
  };
}

function parseListResponse(
  value: unknown,
  expectedLimit: number,
  expectedOffset: number,
): AccountOrdersResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, LIST_RESPONSE_KEYS) ||
    !Array.isArray(value.items) ||
    typeof value.total !== 'number' ||
    !Number.isSafeInteger(value.total) ||
    value.total < 0 ||
    value.limit !== expectedLimit ||
    value.offset !== expectedOffset
  ) {
    throw invalidAccountResponse();
  }

  const items = value.items.map(parseListItem);
  if (
    items.length > expectedLimit ||
    (items.length > 0 && expectedOffset + items.length > value.total)
  ) {
    throw invalidAccountResponse();
  }
  return {
    items,
    limit: expectedLimit,
    offset: expectedOffset,
    total: value.total,
  };
}

function validatePagination(limit: number, offset: number): void {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0
  ) {
    throw invalidAccountResponse();
  }
}

/** Fetch and strictly parse one page of personally owned Orders. */
export async function fetchAccountOrders(
  options: FetchAccountOrdersOptions,
): Promise<AccountOrdersResponse> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const offset = options.offset ?? DEFAULT_OFFSET;
  validatePagination(limit, offset);

  const payload = await authenticatedRequestJson(
    `${ACCOUNT_ORDERS_PATH}?limit=${limit}&offset=${offset}`,
    {
      accessToken: options.accessToken,
      signal: options.signal,
    },
  );
  return parseListResponse(payload, limit, offset);
}

/** Fetch and strictly parse one personally owned Order detail. */
export async function fetchAccountOrder(
  publicOrderNumber: string,
  options: FetchAccountOrderOptions,
): Promise<OrderStatusResponse> {
  if (!PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber)) {
    throw invalidAccountResponse();
  }
  const payload = await authenticatedRequestJson(
    `${ACCOUNT_ORDERS_PATH}/${publicOrderNumber}`,
    {
      accessToken: options.accessToken,
      signal: options.signal,
    },
  );
  try {
    return parseOrderStatusResponse(payload, publicOrderNumber);
  } catch (error: unknown) {
    throw invalidAccountResponse(error);
  }
}
