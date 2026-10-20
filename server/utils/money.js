// Money arithmetic for everything settlement-related, in integer PAISE.
//
// Floating-point rupees drift (0.1 + 0.2, 357.1 * 100 = 35709.999…), and a settlement that is
// off by a paisa per order is off by real money across a week of orders. So the finance code
// converts to paise once at the edge, does every percentage and GST split on integers, and
// converts back only to display. Rounding is half-up (half away from zero), the convention
// used on Indian tax invoices — 1249.5 paise is ₹12.50, not ₹12.49.
//
// All functions are pure and throw on input that isn't a finite number, rather than
// propagating NaN into a ledger.

const assertFinite = (value, name) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number, got ${value}`);
  }
};

const assertPaise = (value, name) => {
  if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer number of paise, got ${value}`);
};

// Half away from zero. Math.round alone rounds -0.5 to -0, i.e. towards +∞.
const roundHalfUp = (x) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * Rupees (a plain number, as every existing price field stores them) → integer paise.
 * Shifts the decimal point on the number's own text, so 1.005 becomes 100.5 paise → 101,
 * where 1.005 * 100 would give 100.49999… → 100.
 */
export const toPaise = (rupees) => {
  assertFinite(rupees, 'rupees');
  const text = String(rupees);
  const shifted = text.includes('e') ? rupees * 100 : Number(`${text}e2`);
  return roundHalfUp(shifted);
};

/** Integer paise → rupees, for display and for the legacy rupee-denominated fields. */
export const toRupees = (paise) => {
  assertPaise(paise, 'paise');
  return paise / 100;
};

/** `percent`% of an amount in paise, rounded half-up to the paisa. 3.5 % of 35700 → 1250. */
export const percentOf = (paise, percent) => {
  assertPaise(paise, 'paise');
  assertFinite(percent, 'percent');
  // Scale the percentage to an integer first (up to 4 decimals) so the product stays exact.
  const scaledPercent = Math.round(percent * 10000);
  return roundHalfUp((paise * scaledPercent) / 1_000_000);
};

/**
 * Splits a GST-INCLUSIVE amount into its taxable base and the GST inside it.
 * base = round(incl / (1 + gst%)), gst = incl − base — so base + gst always equals the
 * inclusive amount exactly. ₹30 at 18 % → { base: 2542, gst: 458 }.
 */
export const splitInclusiveGst = (inclPaise, gstPercent) => {
  assertPaise(inclPaise, 'inclPaise');
  assertFinite(gstPercent, 'gstPercent');
  if (gstPercent < 0) throw new RangeError('gstPercent must not be negative');
  const scaled = Math.round(gstPercent * 10000);
  const base = roundHalfUp((inclPaise * 1_000_000) / (1_000_000 + scaled));
  return { base, gst: inclPaise - base };
};

/**
 * Rounds an amount to the nearest whole rupee (half-up). `roundOff` is what was added
 * (positive) or taken away (negative) — the "Round off" line on a bill. 35741 → 35700, −41.
 */
export const roundToRupee = (paise) => {
  assertPaise(paise, 'paise');
  const rounded = roundHalfUp(paise / 100) * 100;
  return { rounded, roundOff: rounded - paise };
};
