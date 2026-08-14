import { ApiRequestError, buildApiUrl, requestJson } from './client';
import type {
  CheckoutSessionResponse,
  MenuCategory,
  MenuItem,
  MenuResponse,
  OrderCreateItemResponse,
  OrderCreateRequest,
  OrderCreateResponse,
  OrderStatusResponse,
  QuoteItemRequest,
  QuoteLine,
  QuoteResponse,
} from './types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const MENU_KEYS = ['categories'];
const CATEGORY_KEYS = ['description', 'display_order', 'id', 'items', 'name'];
const ITEM_KEYS = [
  'allergens',
  'currency',
  'description',
  'display_order',
  'id',
  'image_url',
  'is_available',
  'name',
  'price_amount',
];
const QUOTE_KEYS = ['currency', 'items', 'subtotal_amount', 'total_amount'];
const QUOTE_LINE_KEYS = [
  'line_total_amount',
  'menu_item_id',
  'name',
  'quantity',
  'unit_price_amount',
];
const QUOTE_TIMEOUT_MS = 10_000;
const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;
const ORDER_RESPONSE_KEYS = [
  'currency',
  'items',
  'order_access_token',
  'order_type',
  'public_order_number',
  'status',
  'subtotal_amount',
  'table_number',
  'total_amount',
];
const ORDER_STATUSES = new Set([
  'accepted',
  'cancelled',
  'completed',
  'created',
  'preparing',
  'ready',
]);
const ORDER_STATUS_RESPONSE_KEYS = [
  'created_at',
  'currency',
  'items',
  'order_type',
  'public_order_number',
  'status',
  'subtotal_amount',
  'table_number',
  'total_amount',
  'updated_at',
];
const CHECKOUT_RESPONSE_KEYS = [
  'checkout_url',
  'expires_at',
  'payment_status',
  'public_order_number',
];
const PAYMENT_STATUSES = new Set(['expired', 'failed', 'pending', 'succeeded']);
const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const AWARE_DATETIME_PATTERN = /(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
const CHECKOUT_TIMEOUT_MS = 10_000;
const ORDER_STATUS_TIMEOUT_MS = 10_000;

export interface CreateOrderOptions {
  accessToken?: string;
  signal?: AbortSignal;
}

export interface CheckoutSessionOptions {
  accessToken?: string;
  guestAccessToken?: string;
  idempotencyKey: string;
  signal?: AbortSignal;
}

export interface OrderStatusOptions {
  accessToken?: string;
  guestAccessToken?: string;
  signal?: AbortSignal;
}

/** Carry safe checkout transport metadata needed for explicit customer retry. */
export class CheckoutRequestError extends ApiRequestError {
  readonly retryAfterSeconds: number | null;

  constructor(
    kind: 'aborted' | 'http' | 'invalid-response' | 'network' | 'timeout',
    message: string,
    options: {
      cause?: unknown;
      retryAfterSeconds?: number;
      status?: number;
    } = {},
  ) {
    super(kind, message, options);
    this.name = 'CheckoutRequestError';
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

function invalidResponse(): ApiRequestError {
  return new ApiRequestError(
    'invalid-response',
    'The public menu response did not match its contract.',
  );
}

function invalidQuoteResponse(): ApiRequestError {
  return new ApiRequestError(
    'invalid-response',
    'The order quote response did not match its contract.',
  );
}

function invalidOrderResponse(): ApiRequestError {
  return new ApiRequestError(
    'invalid-response',
    'The order creation response did not match its contract.',
  );
}

function invalidCheckoutResponse(cause?: unknown): CheckoutRequestError {
  return new CheckoutRequestError(
    'invalid-response',
    'The checkout response did not match its contract.',
    { cause },
  );
}

function invalidOrderStatusResponse(cause?: unknown): ApiRequestError {
  return new ApiRequestError(
    'invalid-response',
    'The order status response did not match its contract.',
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

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isCredential(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/\s/.test(value);
}

function appendOptionalCredentials(
  headers: Headers,
  accessToken: unknown,
  guestAccessToken: unknown,
  invalidCredential: () => ApiRequestError,
): void {
  if (accessToken !== undefined) {
    if (!isCredential(accessToken)) {
      throw invalidCredential();
    }
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  if (guestAccessToken !== undefined) {
    if (!isCredential(guestAccessToken)) {
      throw invalidCredential();
    }
    headers.set('X-Order-Access-Token', guestAccessToken);
  }
}

function isDisplayOrder(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parseMenuItem(value: unknown): MenuItem {
  if (!isRecord(value) || !hasExactKeys(value, ITEM_KEYS)) {
    throw invalidResponse();
  }
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 120 ||
    !isNullableString(value.description) ||
    !isNullableString(value.image_url) ||
    (typeof value.image_url === 'string' && value.image_url.length > 2048) ||
    typeof value.price_amount !== 'number' ||
    !Number.isSafeInteger(value.price_amount) ||
    Number(value.price_amount) <= 0 ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !Array.isArray(value.allergens) ||
    !value.allergens.every((allergen) => typeof allergen === 'string') ||
    !isDisplayOrder(value.display_order) ||
    typeof value.is_available !== 'boolean'
  ) {
    throw invalidResponse();
  }

  return {
    allergens: [...value.allergens],
    currency: value.currency,
    description: value.description,
    display_order: value.display_order,
    id: value.id,
    image_url: value.image_url,
    is_available: value.is_available,
    name: value.name,
    price_amount: value.price_amount,
  };
}

function parseMenuCategory(value: unknown): MenuCategory {
  if (!isRecord(value) || !hasExactKeys(value, CATEGORY_KEYS)) {
    throw invalidResponse();
  }
  if (
    typeof value.id !== 'string' ||
    !UUID_PATTERN.test(value.id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 120 ||
    !isNullableString(value.description) ||
    !isDisplayOrder(value.display_order) ||
    !Array.isArray(value.items) ||
    value.items.length === 0
  ) {
    throw invalidResponse();
  }

  return {
    description: value.description,
    display_order: value.display_order,
    id: value.id,
    items: value.items.map(parseMenuItem),
    name: value.name,
  };
}

export function parseMenuResponse(value: unknown): MenuResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, MENU_KEYS) ||
    !Array.isArray(value.categories)
  ) {
    throw invalidResponse();
  }

  return { categories: value.categories.map(parseMenuCategory) };
}

export async function fetchMenu(signal?: AbortSignal): Promise<MenuResponse> {
  const payload = await requestJson('/api/v1/menu', { signal });
  return parseMenuResponse(payload);
}

function parsePositiveAmount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw invalidQuoteResponse();
  }
  return value;
}

function parseQuoteLine(value: unknown): QuoteLine {
  if (!isRecord(value) || !hasExactKeys(value, QUOTE_LINE_KEYS)) {
    throw invalidQuoteResponse();
  }
  if (
    typeof value.menu_item_id !== 'string' ||
    !UUID_PATTERN.test(value.menu_item_id) ||
    typeof value.name !== 'string' ||
    value.name.length < 1 ||
    value.name.length > 120 ||
    typeof value.quantity !== 'number' ||
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    value.quantity > 99
  ) {
    throw invalidQuoteResponse();
  }

  return {
    line_total_amount: parsePositiveAmount(value.line_total_amount),
    menu_item_id: value.menu_item_id,
    name: value.name,
    quantity: value.quantity,
    unit_price_amount: parsePositiveAmount(value.unit_price_amount),
  };
}

export function parseQuoteResponse(value: unknown): QuoteResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, QUOTE_KEYS) ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 50
  ) {
    throw invalidQuoteResponse();
  }

  const items = value.items.map(parseQuoteLine);
  if (new Set(items.map((item) => item.menu_item_id)).size !== items.length) {
    throw invalidQuoteResponse();
  }
  return {
    currency: value.currency,
    items,
    subtotal_amount: parsePositiveAmount(value.subtotal_amount),
    total_amount: parsePositiveAmount(value.total_amount),
  };
}

function validateQuoteItems(items: QuoteItemRequest[]): void {
  const seenIds = new Set<string>();
  if (items.length < 1 || items.length > 50) {
    throw invalidQuoteResponse();
  }
  for (const item of items) {
    if (
      !UUID_PATTERN.test(item.menu_item_id) ||
      !Number.isInteger(item.quantity) ||
      item.quantity < 1 ||
      item.quantity > 99 ||
      seenIds.has(item.menu_item_id)
    ) {
      throw invalidQuoteResponse();
    }
    seenIds.add(item.menu_item_id);
  }
}

async function requestPostJson(
  path: string,
  payload: unknown,
  signal?: AbortSignal,
  headers: HeadersInit = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
): Promise<unknown> {
  const controller = new AbortController();
  let timeoutTriggered = false;
  let responseReceived = false;
  const forwardAbort = () => controller.abort(signal?.reason);
  if (signal?.aborted === true) {
    forwardAbort();
  } else {
    signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, QUOTE_TIMEOUT_MS);

  try {
    const response = await fetch(buildApiUrl(path), {
      body: JSON.stringify(payload),
      headers,
      method: 'POST',
      signal: controller.signal,
    });
    responseReceived = true;
    if (!response.ok) {
      throw new ApiRequestError('http', 'The API request was not successful.', {
        status: response.status,
      });
    }
    return await response.json();
  } catch (error: unknown) {
    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (timeoutTriggered) {
      throw new ApiRequestError('timeout', 'The API request timed out.', {
        cause: error,
      });
    }
    if (controller.signal.aborted) {
      throw new ApiRequestError('aborted', 'The API request was aborted.', {
        cause: error,
      });
    }
    if (responseReceived) {
      throw new ApiRequestError(
        'invalid-response',
        'The API response was not valid JSON.',
        { cause: error },
      );
    }
    throw new ApiRequestError('network', 'The API request could not be completed.', {
      cause: error,
    });
  } finally {
    window.clearTimeout(timeoutId);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

export async function quoteOrder(
  items: QuoteItemRequest[],
  signal?: AbortSignal,
): Promise<QuoteResponse> {
  validateQuoteItems(items);
  const payload = await requestPostJson('/api/v1/orders/quote', { items }, signal);
  const quote = parseQuoteResponse(payload);
  if (
    quote.items.length !== items.length ||
    quote.items.some(
      (line, index) =>
        line.menu_item_id !== items[index]?.menu_item_id ||
        line.quantity !== items[index]?.quantity,
    )
  ) {
    throw invalidQuoteResponse();
  }
  return quote;
}

function parseOrderItem(value: unknown): OrderCreateItemResponse {
  if (!isRecord(value) || !hasExactKeys(value, QUOTE_LINE_KEYS)) {
    throw invalidOrderResponse();
  }
  if (
    typeof value.menu_item_id !== 'string' ||
    !UUID_PATTERN.test(value.menu_item_id) ||
    typeof value.name !== 'string' ||
    value.name.trim().length < 1 ||
    typeof value.quantity !== 'number' ||
    !Number.isInteger(value.quantity) ||
    value.quantity < 1 ||
    value.quantity > 99 ||
    typeof value.unit_price_amount !== 'number' ||
    !Number.isSafeInteger(value.unit_price_amount) ||
    value.unit_price_amount <= 0 ||
    typeof value.line_total_amount !== 'number' ||
    !Number.isSafeInteger(value.line_total_amount) ||
    value.line_total_amount <= 0
  ) {
    throw invalidOrderResponse();
  }
  return {
    line_total_amount: value.line_total_amount,
    menu_item_id: value.menu_item_id,
    name: value.name,
    quantity: value.quantity,
    unit_price_amount: value.unit_price_amount,
  };
}

export function parseOrderCreateResponse(value: unknown): OrderCreateResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ORDER_RESPONSE_KEYS) ||
    typeof value.public_order_number !== 'string' ||
    !PUBLIC_ORDER_NUMBER_PATTERN.test(value.public_order_number) ||
    typeof value.order_access_token !== 'string' ||
    value.order_access_token.trim().length < 1 ||
    typeof value.status !== 'string' ||
    !ORDER_STATUSES.has(value.status) ||
    (value.order_type !== 'takeaway' && value.order_type !== 'dine_in') ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 50 ||
    typeof value.subtotal_amount !== 'number' ||
    !Number.isSafeInteger(value.subtotal_amount) ||
    value.subtotal_amount <= 0 ||
    typeof value.total_amount !== 'number' ||
    !Number.isSafeInteger(value.total_amount) ||
    value.total_amount <= 0
  ) {
    throw invalidOrderResponse();
  }
  if (
    (value.order_type === 'takeaway' && value.table_number !== null) ||
    (value.order_type === 'dine_in' &&
      (typeof value.table_number !== 'number' ||
        !Number.isSafeInteger(value.table_number) ||
        value.table_number <= 0))
  ) {
    throw invalidOrderResponse();
  }

  const items = value.items.map(parseOrderItem);
  if (new Set(items.map((item) => item.menu_item_id)).size !== items.length) {
    throw invalidOrderResponse();
  }
  return {
    currency: value.currency,
    items,
    order_access_token: value.order_access_token,
    order_type: value.order_type,
    public_order_number: value.public_order_number,
    status: value.status as OrderCreateResponse['status'],
    subtotal_amount: value.subtotal_amount,
    table_number: value.table_number as number | null,
    total_amount: value.total_amount,
  };
}

/** Create one guest or canonical-user order with explicit optional Bearer auth. */
export async function createOrder(
  request: OrderCreateRequest,
  options: CreateOrderOptions = {},
): Promise<OrderCreateResponse> {
  validateQuoteItems(request.items);
  if (
    request.order_type === 'dine_in' &&
    (!Number.isSafeInteger(request.table_number) || request.table_number <= 0)
  ) {
    throw invalidOrderResponse();
  }

  const headers = new Headers({
    Accept: 'application/json',
    'Content-Type': 'application/json',
  });
  appendOptionalCredentials(
    headers,
    options.accessToken,
    undefined,
    invalidOrderResponse,
  );
  const payload = await requestPostJson(
    '/api/v1/orders',
    request,
    options.signal,
    headers,
  );
  const response = parseOrderCreateResponse(payload);
  const expectedTableNumber =
    request.order_type === 'dine_in' ? request.table_number : null;
  if (
    response.order_type !== request.order_type ||
    response.table_number !== expectedTableNumber ||
    response.items.length !== request.items.length ||
    response.items.some(
      (item, index) =>
        item.menu_item_id !== request.items[index]?.menu_item_id ||
        item.quantity !== request.items[index]?.quantity,
    )
  ) {
    throw invalidOrderResponse();
  }
  return response;
}

function isSafeCheckoutUrl(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const parsed = new URL(value);
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    if (parsed.protocol === 'https:') {
      return true;
    }
    const localHosts = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
    return parsed.protocol === 'http:' && localHosts.has(parsed.hostname.toLowerCase());
  } catch (error: unknown) {
    if (error instanceof TypeError) {
      return false;
    }
    return false;
  }
}

function isAwareDatetime(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    AWARE_DATETIME_PATTERN.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Strictly parse the public checkout DTO for the requested order. */
export function parseCheckoutSessionResponse(
  value: unknown,
  expectedPublicOrderNumber: string,
): CheckoutSessionResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CHECKOUT_RESPONSE_KEYS) ||
    value.public_order_number !== expectedPublicOrderNumber ||
    typeof value.payment_status !== 'string' ||
    !PAYMENT_STATUSES.has(value.payment_status) ||
    !isSafeCheckoutUrl(value.checkout_url) ||
    !isAwareDatetime(value.expires_at)
  ) {
    throw invalidCheckoutResponse();
  }
  return {
    checkout_url: value.checkout_url,
    expires_at: value.expires_at,
    payment_status: value.payment_status as CheckoutSessionResponse['payment_status'],
    public_order_number: value.public_order_number,
  };
}

function parsePositiveRetryAfter(value: string | null): number | undefined {
  if (value === null || !/^[1-9][0-9]*$/.test(value)) {
    return undefined;
  }
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}

/** Create or replay one mixed-access checkout session without a request body. */
export async function createCheckoutSession(
  publicOrderNumber: string,
  options: CheckoutSessionOptions,
): Promise<CheckoutSessionResponse> {
  if (
    !PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber) ||
    !CANONICAL_UUID_V4_PATTERN.test(options.idempotencyKey)
  ) {
    throw invalidCheckoutResponse();
  }

  const headers = new Headers({ 'Idempotency-Key': options.idempotencyKey });
  appendOptionalCredentials(
    headers,
    options.accessToken,
    options.guestAccessToken,
    invalidCheckoutResponse,
  );
  if (options.accessToken === undefined && options.guestAccessToken === undefined) {
    throw invalidCheckoutResponse();
  }

  const controller = new AbortController();
  let timeoutTriggered = false;
  let responseReceived = false;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) {
    forwardAbort();
  } else {
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, CHECKOUT_TIMEOUT_MS);

  try {
    const response = await fetch(
      buildApiUrl(
        `/api/v1/orders/${encodeURIComponent(publicOrderNumber)}/checkout-session`,
      ),
      {
        headers,
        method: 'POST',
        signal: controller.signal,
      },
    );
    responseReceived = true;
    if (!response.ok) {
      throw new CheckoutRequestError(
        'http',
        'The checkout request was not successful.',
        {
          retryAfterSeconds:
            response.status === 429
              ? parsePositiveRetryAfter(response.headers.get('Retry-After'))
              : undefined,
          status: response.status,
        },
      );
    }
    if (response.status !== 200 && response.status !== 201) {
      throw invalidCheckoutResponse();
    }
    return parseCheckoutSessionResponse(await response.json(), publicOrderNumber);
  } catch (error: unknown) {
    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (timeoutTriggered) {
      throw new CheckoutRequestError('timeout', 'The checkout request timed out.', {
        cause: error,
      });
    }
    if (controller.signal.aborted) {
      throw new CheckoutRequestError('aborted', 'The checkout request was aborted.', {
        cause: error,
      });
    }
    if (responseReceived) {
      throw invalidCheckoutResponse(error);
    }
    throw new CheckoutRequestError(
      'network',
      'The checkout request could not be completed.',
      { cause: error },
    );
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/** Strictly parse the authenticated public order snapshot. */
export function parseOrderStatusResponse(
  value: unknown,
  expectedPublicOrderNumber: string,
): OrderStatusResponse {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ORDER_STATUS_RESPONSE_KEYS) ||
    value.public_order_number !== expectedPublicOrderNumber ||
    typeof value.status !== 'string' ||
    !ORDER_STATUSES.has(value.status) ||
    (value.order_type !== 'takeaway' && value.order_type !== 'dine_in') ||
    typeof value.currency !== 'string' ||
    !CURRENCY_PATTERN.test(value.currency) ||
    !Array.isArray(value.items) ||
    value.items.length < 1 ||
    value.items.length > 50 ||
    typeof value.subtotal_amount !== 'number' ||
    !Number.isSafeInteger(value.subtotal_amount) ||
    value.subtotal_amount <= 0 ||
    typeof value.total_amount !== 'number' ||
    !Number.isSafeInteger(value.total_amount) ||
    value.total_amount <= 0 ||
    !isAwareDatetime(value.created_at) ||
    !isAwareDatetime(value.updated_at)
  ) {
    throw invalidOrderStatusResponse();
  }
  if (
    (value.order_type === 'takeaway' && value.table_number !== null) ||
    (value.order_type === 'dine_in' &&
      (typeof value.table_number !== 'number' ||
        !Number.isSafeInteger(value.table_number) ||
        value.table_number <= 0))
  ) {
    throw invalidOrderStatusResponse();
  }

  let items: OrderCreateItemResponse[];
  try {
    items = value.items.map(parseOrderItem);
  } catch (error: unknown) {
    throw invalidOrderStatusResponse(error);
  }
  if (new Set(items.map((item) => item.menu_item_id)).size !== items.length) {
    throw invalidOrderStatusResponse();
  }
  return {
    created_at: value.created_at,
    currency: value.currency,
    items,
    order_type: value.order_type,
    public_order_number: value.public_order_number,
    status: value.status as OrderStatusResponse['status'],
    subtotal_amount: value.subtotal_amount,
    table_number: value.table_number as number | null,
    total_amount: value.total_amount,
    updated_at: value.updated_at,
  };
}

/** Fetch one mixed-access order snapshot with the ordinary 10-second timeout. */
export async function fetchOrderStatus(
  publicOrderNumber: string,
  options: OrderStatusOptions,
): Promise<OrderStatusResponse> {
  if (!PUBLIC_ORDER_NUMBER_PATTERN.test(publicOrderNumber)) {
    throw invalidOrderStatusResponse();
  }

  const headers = new Headers();
  appendOptionalCredentials(
    headers,
    options.accessToken,
    options.guestAccessToken,
    invalidOrderStatusResponse,
  );

  const controller = new AbortController();
  let timeoutTriggered = false;
  let responseReceived = false;
  const forwardAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted === true) {
    forwardAbort();
  } else {
    options.signal?.addEventListener('abort', forwardAbort, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timeoutTriggered = true;
    controller.abort();
  }, ORDER_STATUS_TIMEOUT_MS);

  try {
    const response = await fetch(
      buildApiUrl(`/api/v1/orders/${encodeURIComponent(publicOrderNumber)}`),
      {
        headers,
        method: 'GET',
        signal: controller.signal,
      },
    );
    responseReceived = true;
    if (!response.ok) {
      throw new ApiRequestError('http', 'The API request was not successful.', {
        status: response.status,
      });
    }
    if (response.status !== 200) {
      throw invalidOrderStatusResponse();
    }
    return parseOrderStatusResponse(await response.json(), publicOrderNumber);
  } catch (error: unknown) {
    if (error instanceof ApiRequestError) {
      throw error;
    }
    if (timeoutTriggered) {
      throw new ApiRequestError('timeout', 'The API request timed out.', {
        cause: error,
      });
    }
    if (controller.signal.aborted) {
      throw new ApiRequestError('aborted', 'The API request was aborted.', {
        cause: error,
      });
    }
    if (responseReceived) {
      throw invalidOrderStatusResponse(error);
    }
    throw new ApiRequestError('network', 'The API request could not be completed.', {
      cause: error,
    });
  } finally {
    window.clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}
