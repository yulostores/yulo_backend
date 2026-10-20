// Settlement weeks, drawn in a business time zone (Finance Settings → settlementCycle), not the
// server's. A container runs in UTC; a week that starts at UTC midnight starts at 05:30 in
// India, which would put an order delivered at 02:00 IST on a Monday into the previous week.
// Pure — uses only Intl for the zone's offset, so it is right across DST zones too.

const DAY_INDEX = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
const DAY_MS = 24 * 60 * 60 * 1000;

// One formatter per zone — building an Intl.DateTimeFormat is far slower than using one.
const formatters = new Map();
const formatterFor = (timeZone) => {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
};

// The wall-clock date/time `instant` shows in `timeZone`, as numbers.
const zonedParts = (instant, timeZone) => {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
};

// The zone's UTC offset (ms) at `instant`: wall-clock-as-UTC minus the real instant.
const offsetAt = (instant, timeZone) => {
  const p = zonedParts(new Date(instant), timeZone);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - instant;
};

// The first instant of the given calendar day in `timeZone`, as a UTC Date: its wall-clock
// midnight — or, in a zone whose DST starts AT midnight (Santiago, Asunción, Havana, São Paulo
// until 2019), the moment the clocks jump, since that day has no 00:00.
const zonedMidnightToUtc = ({ year, month, day }, timeZone) => {
  const wall = Date.UTC(year, month - 1, day);
  // Candidates: the offset at UTC midnight, then the offset at each guess — they differ when a
  // DST change falls between them. One of them is the real midnight when it exists; when it
  // doesn't, the one taken with the pre-change offset is exactly the jump.
  const candidates = [];
  let utc = wall - offsetAt(wall, timeZone);
  for (let i = 0; i < 3; i += 1) {
    candidates.push(utc);
    utc = wall - offsetAt(utc, timeZone);
  }
  const onDay = candidates.filter((c) => {
    const p = zonedParts(new Date(c), timeZone);
    return p.year === year && p.month === month && p.day === day;
  });
  const exact = onDay.find((c) => {
    const p = zonedParts(new Date(c), timeZone);
    return p.hour === 0 && p.minute === 0 && p.second === 0;
  });
  if (exact !== undefined) return new Date(exact);
  if (onDay.length) return new Date(Math.min(...onDay));
  return new Date(candidates[1]);
};

/**
 * The settlement week containing `instant`: { start, end } as UTC Dates, where `start` is the
 * zone's midnight on `weekStartsOn` and `end` is the last millisecond before the next start.
 */
export const weekBounds = (instant, { weekStartsOn = 'monday', timezone = 'Asia/Kolkata' } = {}) => {
  const startDay = DAY_INDEX[weekStartsOn];
  if (startDay === undefined) throw new RangeError(`Unknown weekStartsOn: ${weekStartsOn}`);

  const local = zonedParts(new Date(instant), timezone);
  // Day-of-week of the local calendar date (computed on a UTC date with the same Y-M-D).
  const localDate = new Date(Date.UTC(local.year, local.month - 1, local.day));
  const daysBack = (localDate.getUTCDay() - startDay + 7) % 7;
  const startLocal = new Date(localDate.getTime() - daysBack * DAY_MS);
  const nextLocal = new Date(startLocal.getTime() + 7 * DAY_MS);

  const ymd = (d) => ({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() });
  const start = zonedMidnightToUtc(ymd(startLocal), timezone);
  const next = zonedMidnightToUtc(ymd(nextLocal), timezone);
  return { start, end: new Date(next.getTime() - 1) };
};

/** The calendar day containing `instant` in `timezone`: { start, end } as UTC Dates. */
export const dayBounds = (instant, { timezone = 'Asia/Kolkata' } = {}) => {
  const local = zonedParts(new Date(instant), timezone);
  const start = zonedMidnightToUtc(local, timezone);
  const nextDay = new Date(Date.UTC(local.year, local.month - 1, local.day) + DAY_MS);
  const next = zonedMidnightToUtc(
    { year: nextDay.getUTCFullYear(), month: nextDay.getUTCMonth() + 1, day: nextDay.getUTCDate() },
    timezone
  );
  return { start, end: new Date(next.getTime() - 1) };
};

/** The calendar month containing `instant` in `timezone`: { start, end } as UTC Dates. */
export const monthBounds = (instant, { timezone = 'Asia/Kolkata' } = {}) => {
  const local = zonedParts(new Date(instant), timezone);
  const start = zonedMidnightToUtc({ year: local.year, month: local.month, day: 1 }, timezone);
  const nextMonth = local.month === 12 ? { year: local.year + 1, month: 1 } : { year: local.year, month: local.month + 1 };
  const next = zonedMidnightToUtc({ ...nextMonth, day: 1 }, timezone);
  return { start, end: new Date(next.getTime() - 1) };
};
