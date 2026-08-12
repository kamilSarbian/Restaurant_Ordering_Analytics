import {
  AdminApiRequestError,
  adminRequestBlob,
  type AdminBlobResponse,
} from '../../api/adminApi';
import type { AdminAwareDateRange } from '../../components/admin/adminDateRange';

export type AdminExportKind = 'orders' | 'payments' | 'product-sales';
export type ExportOrderStatus =
  'accepted' | 'cancelled' | 'completed' | 'created' | 'preparing' | 'ready';
export type ExportOrderType = 'dine_in' | 'takeaway';

export interface AdminExportFilters extends AdminAwareDateRange {
  currency?: string;
  orderType?: ExportOrderType;
  status?: ExportOrderStatus;
}

const EXPORT_PATHS: Readonly<Record<AdminExportKind, string>> = {
  orders: '/api/v1/admin/exports/orders.csv',
  payments: '/api/v1/admin/exports/payments.csv',
  'product-sales': '/api/v1/admin/exports/product-sales.csv',
};

function isCsvContentType(value: string | null): boolean {
  return value?.split(';', 1)[0]?.trim().toLowerCase() === 'text/csv';
}

function buildExportPath(kind: AdminExportKind, filters: AdminExportFilters): string {
  const query = new URLSearchParams({ end: filters.end, start: filters.start });
  if (filters.currency !== undefined) query.set('currency', filters.currency);
  if (kind === 'orders') {
    if (filters.status !== undefined) query.set('status', filters.status);
    if (filters.orderType !== undefined) query.set('order_type', filters.orderType);
  }
  return `${EXPORT_PATHS[kind]}?${query.toString()}`;
}

/** Request one backend-authoritative administrator CSV without transforming bytes. */
export async function requestAdminCsvExport(
  kind: AdminExportKind,
  filters: AdminExportFilters,
  accessToken: string,
  signal?: AbortSignal,
): Promise<AdminBlobResponse> {
  const response = await adminRequestBlob(buildExportPath(kind, filters), {
    accessToken,
    signal,
  });
  if (!isCsvContentType(response.contentType)) {
    throw new AdminApiRequestError(
      'invalid-response',
      'The administrator export response was not a CSV file.',
    );
  }
  return response;
}
