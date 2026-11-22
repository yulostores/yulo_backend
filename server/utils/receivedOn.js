import { z } from 'zod';

// "Received on" for a payment an admin records by hand (Amount Received — plan / SMS credits).
//
// The admin dialogs send a plain calendar date ("2026-11-21") picked in India. `new Date()`
// reads that as midnight UTC = 05:30 IST, so between 00:00 and 05:30 IST "today" looked like a
// future date and the whole form failed with "Invalid payment details". A date-only value is
// therefore taken as the start of that day in IST; a full timestamp is used as given.
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const receivedOnSchema = z
  .preprocess(
    (v) => (typeof v === 'string' && DATE_ONLY.test(v.trim()) ? new Date(`${v.trim()}T00:00:00+05:30`) : v),
    z.coerce.date()
  )
  .refine((d) => d.getTime() <= Date.now() + 5 * 60_000, 'receivedOn cannot be in the future');
