import type { AdminExportKind } from './adminExportsApi';

const MAX_FILENAME_LENGTH = 128;
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.csv$/i;
const QUOTED_FILENAME_PATTERN = /(?:^|;)\s*filename="([^"]*)"\s*(?:;|$)/i;

const FALLBACK_FILENAMES: Readonly<Record<AdminExportKind, string>> = {
  orders: 'orders.csv',
  payments: 'payments.csv',
  'product-sales': 'product-sales.csv',
};

function isSafeCsvFilename(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_FILENAME_LENGTH &&
    value === value.trim() &&
    !value.includes('..') &&
    SAFE_FILENAME_PATTERN.test(value)
  );
}

/** Select a conservative CSV filename or the fixed export-specific fallback. */
export function getCsvDownloadFilename(
  kind: AdminExportKind,
  contentDisposition: string | null,
): string {
  if (contentDisposition !== null) {
    const match = QUOTED_FILENAME_PATTERN.exec(contentDisposition);
    const candidate = match?.[1];
    if (candidate !== undefined && isSafeCsvFilename(candidate)) return candidate;
  }
  return FALLBACK_FILENAMES[kind];
}

/** Start one browser Blob download and always release its temporary object URL. */
export function downloadCsvBlob(blob: Blob, filename: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  try {
    link.href = objectUrl;
    link.download = filename;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}
