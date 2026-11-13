import crypto from 'crypto';

// Coupon codes and customer age bands.
//
// A code is what a customer reads out, types, or shows as a QR at the seller's counter, so it
// avoids every character that is easy to misread: no 0/O, 1/I/L, and no U (reads as V). 30
// symbols, 10 characters → ~5.9 × 10^14 codes, which keeps guessing hopeless behind the
// redemption rate limit (CB7). Codes are drawn with crypto randomness and rejection sampling,
// so every symbol is equally likely — `byte % 30` alone would favour the first 16.

export const COUPON_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
export const COUPON_CODE_LENGTH = 10;

// The largest multiple of the alphabet size that fits in a byte; bytes at or above it are
// thrown away rather than folded back in with a bias.
const LIMIT = 256 - (256 % COUPON_CODE_ALPHABET.length);

export const generateCouponCode = () => {
  let code = '';
  while (code.length < COUPON_CODE_LENGTH) {
    for (const byte of crypto.randomBytes(COUPON_CODE_LENGTH * 2)) {
      if (byte >= LIMIT) continue;
      code += COUPON_CODE_ALPHABET[byte % COUPON_CODE_ALPHABET.length];
      if (code.length === COUPON_CODE_LENGTH) break;
    }
  }
  return code;
};

/**
 * What a person typed or a scanner read → the stored form: upper case, with the spaces and
 * dashes people add for readability removed. Returns null for anything that cannot be a code,
 * so a lookup never runs a query for it.
 */
export const normalizeCouponCode = (input) => {
  if (typeof input !== 'string') return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== COUPON_CODE_LENGTH) return null;
  for (const ch of code) if (!COUPON_CODE_ALPHABET.includes(ch)) return null;
  return code;
};

// ── Age bands ─────────────────────────────────────────────────────────────────
//
// Sellers see a customer's age only as a band (§ Business rules — Visibility); reports group by
// the same bands. Ages are whole years on the calendar date in India, since that is where both
// the birthday and "today" are reckoned.

export const AGE_BANDS = ['18-24', '25-34', '35-44', '45-54', '55+'];
export const AGE_BAND_UNDER_18 = 'under-18';
export const AGE_BAND_NOT_GIVEN = 'not-given';

const IST_OFFSET_MS = 330 * 60 * 1000;

// The calendar date (Y, M, D) of a moment as read in India.
const istDate = (d) => {
  const shifted = new Date(d.getTime() + IST_OFFSET_MS);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()];
};

/** Whole years old on `at`, or null when the date of birth is missing or invalid. */
export const ageOn = (dateOfBirth, at = new Date()) => {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  if (Number.isNaN(dob.getTime())) return null;
  const [by, bm, bd] = istDate(dob);
  const [ay, am, ad] = istDate(at);
  let age = ay - by;
  if (am < bm || (am === bm && ad < bd)) age -= 1;
  return age;
};

/** The report band for a date of birth on `at`. */
export const ageBand = (dateOfBirth, at = new Date()) => {
  const age = ageOn(dateOfBirth, at);
  if (age === null || age < 0) return AGE_BAND_NOT_GIVEN;
  if (age < 18) return AGE_BAND_UNDER_18;
  if (age <= 24) return '18-24';
  if (age <= 34) return '25-34';
  if (age <= 44) return '35-44';
  if (age <= 54) return '45-54';
  return '55+';
};

// ── CSV wording ───────────────────────────────────────────────────────────────
// Exports are read by people in a spreadsheet, so they say "Female" / "Not given" rather than the
// API's keys, and a customer who gave nothing reads the same in every column.
const GENDER_LABELS = { male: 'Male', female: 'Female', other: 'Other' };
export const genderLabel = (gender) => GENDER_LABELS[gender] ?? 'Not given';
export const ageBandLabel = (band) =>
  band === AGE_BAND_NOT_GIVEN ? 'Not given' : band === AGE_BAND_UNDER_18 ? 'Under 18' : band ?? 'Not given';
