const PUBLIC_ORDER_NUMBER_PATTERN = /^ROA-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{12}$/;

export const ORDER_ACCESS_STORAGE_VERSION = 1;
export const ORDER_ACCESS_STORAGE_PREFIX = 'restaurant-ordering:order-access:v1:';

interface StoredOrderAccess {
  publicOrderNumber: string;
  token: string;
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

export function isPublicOrderNumber(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_ORDER_NUMBER_PATTERN.test(value);
}

export function isOrderAccessToken(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function getOrderAccessStorageKey(publicOrderNumber: string): string {
  return `${ORDER_ACCESS_STORAGE_PREFIX}${publicOrderNumber}`;
}

export function saveOrderAccess(
  publicOrderNumber: string,
  token: string,
  storage?: Storage,
): boolean {
  if (!isPublicOrderNumber(publicOrderNumber) || !isOrderAccessToken(token)) {
    return false;
  }
  const record: StoredOrderAccess = {
    publicOrderNumber,
    token,
    version: ORDER_ACCESS_STORAGE_VERSION,
  };
  try {
    resolveSessionStorage(storage).setItem(
      getOrderAccessStorageKey(publicOrderNumber),
      JSON.stringify(record),
    );
    return true;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return false;
    }
    return false;
  }
}

export function loadOrderAccess(
  publicOrderNumber: string,
  storage?: Storage,
): string | null {
  if (!isPublicOrderNumber(publicOrderNumber)) {
    return null;
  }
  try {
    const serialized = resolveSessionStorage(storage).getItem(
      getOrderAccessStorageKey(publicOrderNumber),
    );
    if (serialized === null) {
      return null;
    }
    const value: unknown = JSON.parse(serialized);
    if (
      !isRecord(value) ||
      !hasExactKeys(value, ['publicOrderNumber', 'token', 'version']) ||
      value.version !== ORDER_ACCESS_STORAGE_VERSION ||
      value.publicOrderNumber !== publicOrderNumber ||
      !isOrderAccessToken(value.token)
    ) {
      return null;
    }
    return value.token;
  } catch (error: unknown) {
    if (error instanceof Error) {
      return null;
    }
    return null;
  }
}
