// Indian mobile numbers in the one shape every login stores them: 10 digits, no country code.
//
// People type the same number many ways — "+91 98765 43210", "098765-43210", "9876543210" —
// and a staff member's number is typed by the owner once and by the staff member at every
// login, so the two must land on the same string or the lookup silently misses.

/** @returns {string | null} the 10-digit number, or null when it isn't one. */
export const normalizeIndianPhone = (value) => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let digits = String(value).replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  // Indian mobile numbers start 6-9.
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
};
