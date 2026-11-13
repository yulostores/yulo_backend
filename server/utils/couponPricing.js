import { percentOf } from './money.js';

// Prices in the coupon system, in integer paise (utils/money.js). Plan and SMS prices are
// stored GST-EXCLUSIVE and GST is added on top, rounded half-up to the paisa.

/**
 * A plan's price breakdown: { basePaise, handlingFeePaise, gstPaise, totalPaise }.
 * Offline (no fee): Basic ₹5,000 at 18 % → { 500000, 0, 90000, 590000 } = ₹5,900.
 * Online, 3.5 % handling fee: the fee is added first and GST is charged on price + fee →
 *   { 500000, 17500, 93150, 610650 } = ₹6,106.50.
 */
export const planTotals = ({ basePricePaise, gstPercent }, { handlingFeePercent = 0 } = {}) => {
  const handlingFeePaise = percentOf(basePricePaise, handlingFeePercent);
  const gstPaise = percentOf(basePricePaise + handlingFeePaise, gstPercent);
  return { basePaise: basePricePaise, handlingFeePaise, gstPaise, totalPaise: basePricePaise + handlingFeePaise + gstPaise };
};

/**
 * What `count` SMS cost at the given settings: { pricePaise, gstPaise, totalPaise }. GST is
 * charged on the total, not rounded per message — 3 SMS at ₹3 + 18 % is ₹10.62.
 */
export const smsCost = (count, { smsPricePaise, smsGstPercent }) => {
  if (!Number.isInteger(count) || count < 0) throw new RangeError(`count must be a whole number ≥ 0, got ${count}`);
  const pricePaise = count * smsPricePaise;
  const gstPaise = percentOf(pricePaise, smsGstPercent);
  return { pricePaise, gstPaise, totalPaise: pricePaise + gstPaise };
};
