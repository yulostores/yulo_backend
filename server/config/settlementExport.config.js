import { csvCell } from '../utils/csv.js';

// The columns of the settlement CSV exports — a placeholder until the CA specifies the format
// they need for filing. Change the columns HERE; the export code just walks these arrays.
//
// `value` receives the row and the export context ({ timezone }) and returns a string or
// number. Money is exported in rupees with two decimals (rows hold paise). Dates are calendar
// dates in the settlement time zone (Finance Settings → settlementCycle.timezone) — a UTC date
// would print an IST Monday-to-Sunday week as Sunday-to-Sunday. `adminOnly` columns are left out
// of the restaurant's own export — Razorpay's fee and Yulo's margin are platform-internal.

const rupees = (paise) => ((paise ?? 0) / 100).toFixed(2);

const DEFAULT_TIMEZONE = 'Asia/Kolkata';
const dayFormatters = new Map();
/** YYYY-MM-DD of `date` in `timezone`. */
export const localDay = (date, timezone = DEFAULT_TIMEZONE) => {
  if (!date) return '';
  let f = dayFormatters.get(timezone);
  if (!f) {
    // en-CA formats as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dayFormatters.set(timezone, f);
  }
  return f.format(new Date(date));
};
const day = (date, ctx) => localDay(date, ctx?.timezone);

// One row per restaurant settlement (admin: a week's settlements across restaurants).
export const SETTLEMENT_EXPORT_COLUMNS = [
  { header: 'Restaurant', value: (s) => s.restaurantId?.name ?? String(s.restaurantId) },
  { header: 'Restaurant ID', value: (s) => String(s.restaurantId?._id ?? s.restaurantId) },
  { header: 'Week start', value: (s, ctx) => day(s.periodStart, ctx) },
  { header: 'Week end', value: (s, ctx) => day(s.periodEnd, ctx) },
  { header: 'Status', value: (s) => s.status },
  { header: 'Customer paid (online)', value: (s) => rupees(s.totals?.grossCustomerPaid) },
  // Included in "Customer paid" and passed to the rider in full — never the restaurant's.
  { header: 'Tips (to riders)', value: (s) => rupees(s.totals?.tips) },
  { header: 'Yulo Money - platform fee', value: (s) => rupees(s.totals?.yuloMoneyPlatformFee) },
  { header: 'Yulo Money - delivery', value: (s) => rupees(s.totals?.yuloMoneyDelivery) },
  { header: 'Restaurant-borne delivery', value: (s) => rupees(s.totals?.restaurantBorneDelivery) },
  { header: 'Settlement charge (base)', value: (s) => rupees(s.totals?.settlementCharge?.base) },
  { header: 'Settlement charge (GST)', value: (s) => rupees(s.totals?.settlementCharge?.gst) },
  { header: 'Settlement charge (total)', value: (s) => rupees(s.totals?.settlementCharge?.total) },
  { header: 'Counter platform fees', value: (s) => rupees(s.totals?.counterPlatformFees) },
  { header: 'Refund gateway fees', value: (s) => rupees(s.totals?.refundGatewayFees) },
  { header: 'Adjustments', value: (s) => rupees(s.totals?.adjustments) },
  { header: 'Penalties', value: (s) => rupees(s.totals?.penalties) },
  { header: 'Carried in', value: (s) => rupees(s.totals?.carryForwardIn) },
  { header: 'Failed payouts carried in', value: (s) => rupees(s.totals?.failedPayoutsCarriedIn) },
  { header: 'Carried out', value: (s) => rupees(s.totals?.carryForwardOut) },
  { header: 'Net payable', value: (s) => rupees(s.totals?.netPayable) },
  { header: 'UTR', value: (s) => s.payout?.utr ?? '' },
  { header: 'Paid on', value: (s, ctx) => day(s.payout?.paidAt, ctx) },
];

// One row per ledger entry in a settlement (the per-order statement).
export const ENTRY_EXPORT_COLUMNS = [
  { header: 'Date', value: (e, ctx) => day(e.eligibleAt, ctx) },
  { header: 'Type', value: (e) => e.type },
  { header: 'Order ID', value: (e) => (e.orderId ? String(e.orderId) : '') },
  { header: 'Bill ID', value: (e) => (e.billId ? String(e.billId) : '') },
  { header: 'Channel', value: (e) => e.breakdown?.paymentChannel ?? '' },
  { header: 'Customer paid', value: (e) => rupees(e.breakdown?.customerPaid) },
  { header: 'Tip (to rider)', value: (e) => rupees(e.breakdown?.tip) },
  { header: 'Platform fee', value: (e) => rupees(e.breakdown?.yuloMoney?.platformFee) },
  { header: 'Delivery (customer-paid)', value: (e) => rupees(e.breakdown?.yuloMoney?.deliveryCharge) },
  { header: 'Delivery (restaurant-paid)', value: (e) => rupees(e.breakdown?.restaurantBorneDelivery) },
  { header: 'Settlement charge', value: (e) => rupees(e.breakdown?.settlementCharge?.total) },
  { header: 'Razorpay fee', value: (e) => rupees(e.breakdown?.gateway?.total), adminOnly: true },
  { header: 'Yulo settlement margin', value: (e) => rupees(e.breakdown?.yuloSettlementMargin), adminOnly: true },
  { header: 'Rider pay', value: (e) => rupees(e.breakdown?.riderPay), adminOnly: true },
  { header: 'Credit / debit', value: (e) => e.direction },
  { header: 'Amount', value: (e) => rupees(e.direction === 'debit' ? -e.amountPaise : e.amountPaise) },
  { header: 'Note', value: (e) => e.note ?? '' },
];


/**
 * CSV text for `rows` using `columns`; `audience: 'owner'` drops adminOnly columns; `timezone`
 * (the settlement cycle's) is the zone dates are printed in.
 */
export const toCsv = (columns, rows, { audience = 'admin', timezone = DEFAULT_TIMEZONE } = {}) => {
  const cols = columns.filter((c) => audience === 'admin' || !c.adminOnly);
  const ctx = { timezone };
  const lines = [cols.map((c) => csvCell(c.header)).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(c.value(row, ctx))).join(','));
  return `${lines.join('\n')}\n`;
};
