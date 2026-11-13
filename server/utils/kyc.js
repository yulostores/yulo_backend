import { GSTIN_PATTERN } from '../config/storeSettings.config.js';

// Format checks for the identity numbers a coupon partner gives at onboarding (CB3). They catch
// typos — a digit dropped from an Aadhaar number, a PAN with its letters and digits swapped —
// not fraud: an admin still checks every number against its uploaded document before approving.
//
// All inputs are normalised first (spaces and dashes removed, letters upper-cased), so
// "abcde 1234 f" and "2341-2341-2346" are accepted the way people actually type them.

const compact = (value) => (typeof value === 'string' ? value.replace(/[\s-]/g, '').toUpperCase() : '');

// ── PAN ───────────────────────────────────────────────────────────────────────
// Five letters, four digits, a letter. The fourth letter is the holder type; a person's PAN has
// 'P' there, but a business owner may legitimately give a firm's PAN, so it isn't restricted.
const PAN_RE = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const normalizePan = compact;
export const isValidPan = (value) => PAN_RE.test(compact(value));

// ── GSTIN ─────────────────────────────────────────────────────────────────────
// The same pattern the restaurant settings use (config/storeSettings.config.js).
const GSTIN_RE = new RegExp(GSTIN_PATTERN);
export const normalizeGstin = compact;
export const isValidGstin = (value) => GSTIN_RE.test(compact(value));

// ── Aadhaar ───────────────────────────────────────────────────────────────────
// Twelve digits, not starting with 0 or 1, whose last digit is a Verhoeff check digit over the
// first eleven — the scheme UIDAI uses, which catches every single-digit error and every swap of
// two adjacent digits.

const VERHOEFF_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 2, 3, 4, 0, 6, 7, 8, 9, 5],
  [2, 3, 4, 0, 1, 7, 8, 9, 5, 6],
  [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1],
  [6, 5, 9, 8, 7, 1, 0, 4, 3, 2],
  [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4],
  [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const VERHOEFF_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
  [1, 5, 7, 6, 2, 8, 3, 0, 9, 4],
  [5, 8, 0, 3, 7, 9, 6, 1, 4, 2],
  [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 8, 7, 6, 0],
  [4, 2, 8, 6, 5, 7, 3, 9, 0, 1],
  [2, 7, 9, 3, 8, 0, 6, 4, 1, 5],
  [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
const VERHOEFF_INV = [0, 4, 3, 2, 1, 5, 6, 7, 8, 9];

/** True when a string of digits (check digit last) passes the Verhoeff check. */
export const verhoeffValid = (digits) => {
  if (!/^\d+$/.test(digits)) return false;
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    c = VERHOEFF_D.at(c).at(VERHOEFF_P.at(i % 8).at(Number(reversed.at(i))));
  }
  return c === 0;
};

/** The Verhoeff check digit to append to a string of digits. */
export const verhoeffCheckDigit = (digits) => {
  if (!/^\d+$/.test(digits)) throw new TypeError('digits only');
  let c = 0;
  const reversed = [...digits].reverse();
  for (let i = 0; i < reversed.length; i += 1) {
    c = VERHOEFF_D.at(c).at(VERHOEFF_P.at((i + 1) % 8).at(Number(reversed.at(i))));
  }
  return String(VERHOEFF_INV.at(c));
};

export const normalizeAadhaar = (value) => compact(value);
// Format only: 12 digits, not starting with 0 or 1. The Verhoeff check digit is NOT enforced —
// the business asked to accept numbers that fail it (Nov 2026), so a typo can get through; the
// admin compares the number with the Aadhaar document before approving. verhoeffValid stays
// exported for anyone who wants to warn rather than refuse.
export const isValidAadhaar = (value) => /^[2-9]\d{11}$/.test(compact(value));

// ── Display ───────────────────────────────────────────────────────────────────
// How a stored last-4 is shown back: never more than the last 4.
export const maskPan = (last4) => (last4 ? `******${last4}` : null);
export const maskAadhaar = (last4) => (last4 ? `XXXX XXXX ${last4}` : null);
