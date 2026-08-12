export const ADMIN_ANALYTICS_TIME_ZONE = 'Europe/Oslo';

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const OFFSET_PATTERN = /^GMT(?:(?<sign>[+-])(?<hours>\d{2}):(?<minutes>\d{2}))?$/;

export interface AdminDateRangeSelection {
  endDate: string;
  startDate: string;
}

export interface AdminAwareDateRange extends AdminDateRangeSelection {
  end: string;
  start: string;
}

interface CalendarDateParts {
  day: number;
  month: number;
  year: number;
}

function parseDateOnly(value: string): CalendarDateParts | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { day, month, year };
}

function formatDateOnly(parts: CalendarDateParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(
    2,
    '0',
  )}-${String(parts.day).padStart(2, '0')}`;
}

function getOsloParts(instant: Date): CalendarDateParts & {
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
    minute: '2-digit',
    month: '2-digit',
    second: '2-digit',
    timeZone: ADMIN_ANALYTICS_TIME_ZONE,
    year: 'numeric',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    return value === undefined ? Number.NaN : Number(value);
  };
  return {
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    month: read('month'),
    second: read('second'),
    year: read('year'),
  };
}

function getOsloOffset(date: CalendarDateParts): string {
  const probe = new Date(Date.UTC(date.year, date.month - 1, date.day));
  const offsetName = new Intl.DateTimeFormat('en-US', {
    timeZone: ADMIN_ANALYTICS_TIME_ZONE,
    timeZoneName: 'longOffset',
  })
    .formatToParts(probe)
    .find((part) => part.type === 'timeZoneName')?.value;
  const match = offsetName === undefined ? null : OFFSET_PATTERN.exec(offsetName);
  if (match === null) {
    throw new RangeError('Europe/Oslo offset could not be determined.');
  }
  if (match.groups?.sign === undefined) return '+00:00';
  return `${match.groups.sign}${match.groups.hours}:${match.groups.minutes}`;
}

/** Return whether a string is a real Gregorian calendar date in YYYY-MM-DD form. */
export function isValidDateOnly(value: string): boolean {
  return parseDateOnly(value) !== null;
}

/** Add whole Gregorian calendar days without using the host local time zone. */
export function addCalendarDays(value: string, days: number): string {
  const parts = parseDateOnly(value);
  if (parts === null || !Number.isSafeInteger(days)) {
    throw new RangeError('A valid date and whole-day offset are required.');
  }
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return formatDateOnly({
    day: shifted.getUTCDate(),
    month: shifted.getUTCMonth() + 1,
    year: shifted.getUTCFullYear(),
  });
}

/** Convert a date-only value to verified Europe/Oslo local midnight with an offset. */
export function dateOnlyToOsloMidnight(value: string): string {
  const parts = parseDateOnly(value);
  if (parts === null) throw new RangeError('A valid calendar date is required.');
  const aware = `${value}T00:00:00${getOsloOffset(parts)}`;
  const instant = new Date(aware);
  if (Number.isNaN(instant.getTime())) {
    throw new RangeError('The Europe/Oslo midnight could not be represented.');
  }
  const roundTrip = getOsloParts(instant);
  if (
    roundTrip.year !== parts.year ||
    roundTrip.month !== parts.month ||
    roundTrip.day !== parts.day ||
    roundTrip.hour !== 0 ||
    roundTrip.minute !== 0 ||
    roundTrip.second !== 0
  ) {
    throw new RangeError('The Europe/Oslo midnight did not round-trip safely.');
  }
  return aware;
}

/** Build an inclusive UI range and exclusive-next-midnight API range. */
export function buildAdminAwareDateRange(
  selection: AdminDateRangeSelection,
): AdminAwareDateRange {
  if (!isValidDateOnly(selection.startDate) || !isValidDateOnly(selection.endDate)) {
    throw new RangeError('Both reporting dates must be valid calendar dates.');
  }
  if (selection.startDate > selection.endDate) {
    throw new RangeError('The start date must not be after the end date.');
  }
  return {
    ...selection,
    start: dateOnlyToOsloMidnight(selection.startDate),
    end: dateOnlyToOsloMidnight(addCalendarDays(selection.endDate, 1)),
  };
}

/** Return the last seven Europe/Oslo calendar days, including the supplied instant. */
export function getDefaultAdminDateRange(
  now: Date = new Date(),
): AdminDateRangeSelection {
  if (Number.isNaN(now.getTime()))
    throw new RangeError('A valid current instant is required.');
  const osloToday = formatDateOnly(getOsloParts(now));
  return { endDate: osloToday, startDate: addCalendarDays(osloToday, -6) };
}
