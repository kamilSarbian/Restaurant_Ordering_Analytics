import { isPublicOrderNumber } from './orderAccessStorage';

export const CHECKOUT_ATTEMPT_STORAGE_VERSION = 1;
export const CHECKOUT_ATTEMPT_STORAGE_PREFIX =
  'restaurant-ordering:checkout-attempt:v1:';

const CANONICAL_UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface CheckoutAttempt {
  idempotencyKey: string;
  publicOrderNumber: string;
  version: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...keys].sort();
  return (
    actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index])
  );
}

function resolveSessionStorage(storage?: Storage): Storage {
  return storage ?? window.sessionStorage;
}

/** Return whether a value is canonical lowercase UUIDv4 text. */
export function isCanonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_V4_PATTERN.test(value);
}

/** Build the per-order session storage key for a checkout attempt. */
export function getCheckoutAttemptStorageKey(publicOrderNumber: string): string {
  return `${CHECKOUT_ATTEMPT_STORAGE_PREFIX}${publicOrderNumber}`;
}

/** Create a checkout attempt using the browser's secure UUID generator. */
export function createCheckoutAttempt(
  publicOrderNumber: string,
): CheckoutAttempt | null {
  if (!isPublicOrderNumber(publicOrderNumber)) {
    return null;
  }
  try {
    const idempotencyKey = window.crypto.randomUUID();
    if (!isCanonicalUuidV4(idempotencyKey)) {
      return null;
    }
    return {
      idempotencyKey,
      publicOrderNumber,
      version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
    };
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    return null;
  }
}

/** Persist a non-sensitive checkout attempt in session storage. */
export function saveCheckoutAttempt(
  attempt: CheckoutAttempt,
  storage?: Storage,
): boolean {
  if (
    attempt.version !== CHECKOUT_ATTEMPT_STORAGE_VERSION ||
    !isPublicOrderNumber(attempt.publicOrderNumber) ||
    !isCanonicalUuidV4(attempt.idempotencyKey)
  ) {
    return false;
  }
  try {
    resolveSessionStorage(storage).setItem(
      getCheckoutAttemptStorageKey(attempt.publicOrderNumber),
      JSON.stringify(attempt),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}

/** Load and strictly validate one per-order checkout attempt. */
export function loadCheckoutAttempt(
  publicOrderNumber: string,
  storage?: Storage,
): CheckoutAttempt | null {
  if (!isPublicOrderNumber(publicOrderNumber)) {
    return null;
  }
  try {
    const serialized = resolveSessionStorage(storage).getItem(
      getCheckoutAttemptStorageKey(publicOrderNumber),
    );
    if (serialized === null) {
      return null;
    }
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['idempotencyKey', 'publicOrderNumber', 'version']) ||
      value.version !== CHECKOUT_ATTEMPT_STORAGE_VERSION ||
      value.publicOrderNumber !== publicOrderNumber ||
      !isCanonicalUuidV4(value.idempotencyKey)
    ) {
      return null;
    }
    return {
      idempotencyKey: value.idempotencyKey,
      publicOrderNumber,
      version: CHECKOUT_ATTEMPT_STORAGE_VERSION,
    };
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    return null;
  }
}
