import { afterEach, vi } from 'vitest';

import { downloadCsvBlob, getCsvDownloadFilename } from './csvDownload';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('administrator CSV filename safety', () => {
  it('accepts a safe quoted backend filename', () => {
    expect(
      getCsvDownloadFilename(
        'orders',
        'attachment; filename="orders_20260812T000000Z_all.csv"',
      ),
    ).toBe('orders_20260812T000000Z_all.csv');
  });

  it.each([
    'attachment; filename="orders.txt"',
    'attachment; filename="../orders.csv"',
    'attachment; filename="folder/orders.csv"',
    'attachment; filename="folder\\orders.csv"',
    'attachment; filename="orders\u0000.csv"',
    'attachment; filename="orders\u0007.csv"',
    'attachment; filename=" orders.csv"',
    'attachment; filename="orders.csv "',
    'attachment; filename="ordérs.csv"',
    'attachment; filename=orders.csv',
  ])('rejects an unsafe or unsupported disposition %s', (disposition) => {
    expect(getCsvDownloadFilename('orders', disposition)).toBe('orders.csv');
  });

  it('rejects an overlong filename', () => {
    const filename = `${'a'.repeat(125)}.csv`;
    expect(getCsvDownloadFilename('orders', `attachment; filename="${filename}"`)).toBe(
      'orders.csv',
    );
  });

  it.each([
    ['orders', 'orders.csv'],
    ['product-sales', 'product-sales.csv'],
    ['payments', 'payments.csv'],
  ] as const)('uses the fixed %s fallback', (kind, fallback) => {
    expect(getCsvDownloadFilename(kind, null)).toBe(fallback);
  });
});

describe('administrator CSV browser download', () => {
  it('clicks one temporary safe link, removes it, and revokes the URL', () => {
    const blob = new Blob(['bytes'], { type: 'text/csv' });
    const createObjectURL = vi.fn(() => 'blob:test-export');
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function verifyLink(this: HTMLAnchorElement) {
        expect(this.href).toContain('blob:test-export');
        expect(this.download).toBe('orders.csv');
        expect(document.body.contains(this)).toBe(true);
      });

    downloadCsvBlob(blob, 'orders.csv');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(createObjectURL).toHaveBeenCalledWith(blob);
    expect(click).toHaveBeenCalledOnce();
    expect(document.body.querySelector('a')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-export');
  });

  it('removes the link and revokes the URL when clicking throws', () => {
    const revokeObjectURL = vi.fn();
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:failed-export'),
      revokeObjectURL,
    });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      throw new DOMException('Synthetic click failure', 'InvalidStateError');
    });

    expect(() => downloadCsvBlob(new Blob(['bytes']), 'payments.csv')).toThrow();
    expect(document.body.querySelector('a')).toBeNull();
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:failed-export');
  });
});
