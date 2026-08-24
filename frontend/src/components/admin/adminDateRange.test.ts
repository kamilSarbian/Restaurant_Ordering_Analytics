import {
  addCalendarDays,
  buildAdminAwareDateRange,
  dateOnlyToOsloMidnight,
  getDefaultAdminDateRange,
  isValidDateOnly,
} from './adminDateRange';

describe('Europe/Oslo administrator date ranges', () => {
  it('converts winter and summer midnights with their exact offsets', () => {
    expect(dateOnlyToOsloMidnight('2026-01-15')).toBe('2026-01-15T00:00:00+01:00');
    expect(dateOnlyToOsloMidnight('2026-07-15')).toBe('2026-07-15T00:00:00+02:00');
  });

  it('handles the spring DST transition as calendar midnights', () => {
    expect(dateOnlyToOsloMidnight('2026-03-29')).toBe('2026-03-29T00:00:00+01:00');
    expect(dateOnlyToOsloMidnight('2026-03-30')).toBe('2026-03-30T00:00:00+02:00');
  });

  it('handles the autumn DST transition as calendar midnights', () => {
    expect(dateOnlyToOsloMidnight('2026-10-25')).toBe('2026-10-25T00:00:00+02:00');
    expect(dateOnlyToOsloMidnight('2026-10-26')).toBe('2026-10-26T00:00:00+01:00');
  });

  it('turns an inclusive selected end into exclusive next-day midnight', () => {
    expect(
      buildAdminAwareDateRange({ startDate: '2026-08-06', endDate: '2026-08-12' }),
    ).toEqual({
      end: '2026-08-13T00:00:00+02:00',
      endDate: '2026-08-12',
      start: '2026-08-06T00:00:00+02:00',
      startDate: '2026-08-06',
    });
  });

  it('rejects impossible calendar dates and reversed ranges', () => {
    expect(isValidDateOnly('2026-02-30')).toBe(true);
    expect(() => dateOnlyToOsloMidnight('2026-02-30')).toThrow(RangeError);
    expect(() =>
      buildAdminAwareDateRange({ startDate: '2026-08-13', endDate: '2026-08-12' }),
    ).toThrow(RangeError);
  });

  it('accepts a same-day range as one full Oslo calendar day', () => {
    const result = buildAdminAwareDateRange({
      startDate: '2026-01-15',
      endDate: '2026-01-15',
    });
    expect(result.start).toBe('2026-01-15T00:00:00+01:00');
    expect(result.end).toBe('2026-01-16T00:00:00+01:00');
  });

  it('returns seven Oslo calendar days including today for an injected instant', () => {
    expect(getDefaultAdminDateRange(new Date('2026-08-12T22:30:00Z'))).toEqual({
      endDate: '2026-08-13',
      startDate: '2026-08-07',
    });
  });

  it('keeps arithmetic and aware output independent of host local-time parsing', () => {
    expect(addCalendarDays('2026-03-29', 1)).toBe('2026-03-30');
    const aware = dateOnlyToOsloMidnight('2026-03-29');
    expect(aware).toMatch(/T00:00:00[+-]\d{2}:\d{2}$/);
    expect(new Date(aware).toISOString()).toBe('2026-03-28T23:00:00.000Z');
  });
});
