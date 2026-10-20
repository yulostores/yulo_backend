import { dayBounds } from './week.js';

// Razorpay settles a captured payment to Yulo on the 2nd working day after capture (T+2). Until
// then the money isn't Yulo's to pay out, so a restaurant's online earnings only become
// settlement-eligible from that moment (B12). Working days here are Monday–Friday in the
// settlement time zone; bank holidays are out of scope (a holiday only delays Razorpay's
// settlement by a day — the statement it lands in is unchanged in almost every week).

export const CLEARANCE_WORKING_DAYS = 2;

const HOUR = 60 * 60 * 1000;

const weekdayFormatters = new Map();
const localWeekday = (instant, timeZone) => {
  let f = weekdayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' });
    weekdayFormatters.set(timeZone, f);
  }
  return f.format(instant);
};

const isWorkingDay = (dayStart, timeZone) => !['Sat', 'Sun'].includes(localWeekday(dayStart, timeZone));

/**
 * The first instant (local midnight) of the n-th working day after the calendar day containing
 * `instant`, in `timezone`. A payment captured on Friday at any hour clears Tuesday 00:00; one
 * captured on Saturday or Sunday also clears Tuesday 00:00; Wednesday → Friday 00:00.
 */
export const addWorkingDays = (instant, n = CLEARANCE_WORKING_DAYS, { timezone = 'Asia/Kolkata' } = {}) => {
  let day = dayBounds(new Date(instant), { timezone }).start;
  let counted = 0;
  while (counted < n) {
    // 30 h past a local midnight is always inside the next calendar day, DST or not.
    day = dayBounds(new Date(day.getTime() + 30 * HOUR), { timezone }).start;
    if (isWorkingDay(day, timezone)) counted += 1;
  }
  return day;
};

/** When money captured at `capturedAt` has reached Yulo (T+2 working days). */
export const clearanceTime = (capturedAt, { timezone = 'Asia/Kolkata' } = {}) =>
  addWorkingDays(capturedAt ?? new Date(), CLEARANCE_WORKING_DAYS, { timezone });
