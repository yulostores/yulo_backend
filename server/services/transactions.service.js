// The super admin's Transactions ledger — every payment that came in and every payment that went
// out, from all the places money is recorded, as one list (dashboard card + /transactions page).
//
// Nothing is stored here: each row is read from the document that already records the money, so
// the ledger can never drift from the screens that own those documents.
//
//   IN   order_payment      a delivery/takeaway order paid (online to Yulo, or cash on delivery)
//        bill_payment       a dine-in bill paid (online to Yulo, or at the restaurant's counter)
//        seller_plan        a coupon seller's plan purchase (Razorpay, or admin "Amount Received")
//        sms_credits        a seller's SMS credit pack
//        job_fee            a careers-portal application fee
//        stray_payment      a payment captured but refused (duplicate, wrong amount…) — owed back
//   OUT  refund             money returned to a customer, seller or applicant through Razorpay
//        restaurant_payout  a weekly settlement paid to a restaurant's bank account
//        rider_payout       a weekly payout paid to a delivery partner
//
// `channel` says who holds the money: 'online' / 'manual' / 'bank' reached (or left) Yulo;
// 'counter' and 'cod' were collected by the restaurant or the rider and never passed through Yulo.
// Totals keep the two apart. Dine-in rounds are counted once, through their bill; delivery and
// takeaway orders once, through the order (their single-order bills are skipped). All in PAISE.

import mongoose from 'mongoose';
import ExcelJS from 'exceljs';

import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import SellerSubscription from '../models/SellerSubscription.js';
import SmsCreditPurchase from '../models/SmsCreditPurchase.js';
import JobApplication from '../models/JobApplication.js';
import StrayPayment from '../models/StrayPayment.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import Payout from '../models/Payout.js';
import Restaurant from '../models/Restaurant.js';
import Seller from '../models/Seller.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import { ApiError } from '../utils/ApiError.js';

export const KINDS = {
  order_payment: { label: 'Order payment', direction: 'in' },
  bill_payment: { label: 'Dine-in bill', direction: 'in' },
  seller_plan: { label: 'Seller plan', direction: 'in' },
  sms_credits: { label: 'SMS credits', direction: 'in' },
  job_fee: { label: 'Job application fee', direction: 'in' },
  stray_payment: { label: 'Unmatched payment', direction: 'in' },
  refund: { label: 'Refund', direction: 'out' },
  restaurant_payout: { label: 'Restaurant payout', direction: 'out' },
  rider_payout: { label: 'Rider payout', direction: 'out' },
};
const THROUGH_YULO = ['online', 'manual', 'bank'];
const IST_OFFSET = '+05:30';
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
export const MAX_EXPORT_ROWS = 50_000;

const rupeesToPaise = (field) => ({ $round: [{ $multiply: [{ $ifNull: [field, 0] }, 100] }, 0] });
const REFUND_MOVED = ['processing', 'processed'];
const refundStatus = { $cond: [{ $eq: ['$refund.status', 'processed'] }, 'completed', 'processing'] };

// ── One sub-pipeline per source, each projecting the common row shape ──────────────────────────
// Every pipeline gets the date window first, on its own date field, so each one is index-friendly
// and the union stays small.

const sources = ({ start, end }) => {
  const at = (field) => ({ [field]: { $gte: start, $lt: end } });
  const row = (extra) => ({ $project: { _id: 0, ...extra } });

  return [
    {
      coll: Order.collection.name,
      pipeline: [
        { $match: { ...at('paidAt'), type: { $in: ['delivery', 'takeaway'] }, paymentStatus: { $in: ['paid', 'refunded'] } } },
        row({
          id: { $concat: ['order_payment:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$paidAt',
          kind: 'order_payment',
          direction: 'in',
          amountPaise: { $ifNull: ['$paymentAmountPaise', { $ifNull: ['$charges.grandTotal', rupeesToPaise('$grandTotal')] }] },
          channel: { $ifNull: ['$paymentChannel', { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 'cod', 'online'] }] },
          method: { $ifNull: ['$paymentMethod', 'online'] },
          status: 'completed',
          partyType: 'restaurant',
          partyId: '$restaurantId',
          reference: { $literal: null },
          orderType: '$type',
          gatewayId: '$razorpayPaymentId',
        }),
      ],
    },
    {
      coll: Bill.collection.name,
      pipeline: [
        { $match: { ...at('paidAt'), type: 'dine_in', status: 'paid' } },
        row({
          id: { $concat: ['bill_payment:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$paidAt',
          kind: 'bill_payment',
          direction: 'in',
          amountPaise: { $ifNull: ['$paymentAmountPaise', { $ifNull: ['$charges.grandTotal', rupeesToPaise('$grandTotal')] }] },
          channel: { $ifNull: ['$paymentChannel', { $cond: [{ $eq: ['$paidBy', 'online'] }, 'online', 'counter'] }] },
          method: { $ifNull: ['$paidBy', null] },
          status: 'completed',
          partyType: 'restaurant',
          partyId: '$restaurantId',
          reference: '$billNumber',
          gatewayId: '$razorpayPaymentId',
        }),
      ],
    },
    {
      coll: SellerSubscription.collection.name,
      pipeline: [
        { $match: at('activatedAt') },
        row({
          id: { $concat: ['seller_plan:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$activatedAt',
          kind: 'seller_plan',
          direction: 'in',
          amountPaise: { $ifNull: ['$payment.amountPaise', '$planSnapshot.totalPaise'] },
          channel: { $cond: [{ $eq: ['$payment.method', 'manual'] }, 'manual', 'online'] },
          method: { $cond: [{ $eq: ['$payment.method', 'manual'] }, { $ifNull: ['$payment.manual.mode', 'manual'] }, 'online'] },
          status: 'completed',
          partyType: 'seller',
          partyId: '$sellerId',
          reference: { $ifNull: ['$billNumber', '$planSnapshot.name'] },
          gatewayId: { $ifNull: ['$payment.razorpayPaymentId', '$payment.manual.reference'] },
        }),
      ],
    },
    {
      coll: SmsCreditPurchase.collection.name,
      pipeline: [
        { $match: { ...at('paidAt'), status: 'paid' } },
        row({
          id: { $concat: ['sms_credits:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$paidAt',
          kind: 'sms_credits',
          direction: 'in',
          amountPaise: { $ifNull: ['$payment.amountPaise', '$totalPaise'] },
          channel: { $cond: [{ $eq: ['$payment.method', 'manual'] }, 'manual', 'online'] },
          method: { $cond: [{ $eq: ['$payment.method', 'manual'] }, { $ifNull: ['$payment.manual.mode', 'manual'] }, 'online'] },
          status: 'completed',
          partyType: 'seller',
          partyId: '$sellerId',
          reference: '$billNumber',
          gatewayId: { $ifNull: ['$payment.razorpayPaymentId', '$payment.manual.reference'] },
        }),
      ],
    },
    {
      coll: JobApplication.collection.name,
      pipeline: [
        { $match: { ...at('payment.paidAt'), 'payment.status': 'paid' } },
        row({
          id: { $concat: ['job_fee:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$payment.paidAt',
          kind: 'job_fee',
          direction: 'in',
          amountPaise: '$payment.amountPaise',
          channel: 'online',
          method: 'online',
          status: 'completed',
          partyType: 'applicant',
          partyId: '$_id',
          partyName: '$fullName',
          reference: '$applicationNumber',
          gatewayId: '$payment.razorpayPaymentId',
        }),
      ],
    },
    {
      coll: StrayPayment.collection.name,
      pipeline: [
        { $match: at('createdAt') },
        row({
          id: { $concat: ['stray_payment:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$createdAt',
          kind: 'stray_payment',
          direction: 'in',
          amountPaise: { $ifNull: ['$amountPaise', 0] },
          channel: 'online',
          method: 'online',
          status: 'completed',
          partyType: {
            $cond: [{ $ne: [{ $ifNull: ['$restaurantId', null] }, null] }, 'restaurant',
              { $cond: [{ $ne: [{ $ifNull: ['$sellerId', null] }, null] }, 'seller', 'applicant'] }],
          },
          partyId: { $ifNull: ['$restaurantId', { $ifNull: ['$sellerId', '$jobApplicationId'] }] },
          reference: '$kind',
          gatewayId: '$razorpayPaymentId',
        }),
      ],
    },
    // Refunds: an order's, a bill's or a refused payment's — once sent to Razorpay.
    ...[
      { model: Order, partyType: 'restaurant', partyId: '$restaurantId', ref: { $literal: null }, extra: { type: { $in: ['delivery', 'takeaway'] } } },
      { model: Bill, partyType: 'restaurant', partyId: '$restaurantId', ref: '$billNumber', extra: { type: 'dine_in' } },
      { model: StrayPayment, partyType: 'stray', partyId: { $ifNull: ['$restaurantId', { $ifNull: ['$sellerId', '$jobApplicationId'] }] }, ref: '$kind', extra: {} },
    ].map(({ model, partyType, partyId, ref, extra }) => ({
      coll: model.collection.name,
      pipeline: [
        {
          $match: {
            ...extra,
            'refund.status': { $in: REFUND_MOVED },
            $or: [at('refund.processedAt'), { 'refund.processedAt': null, ...at('refund.initiatedAt') }],
          },
        },
        row({
          id: { $concat: [`refund:${model.modelName}:`, { $toString: '$_id' }] },
          docId: '$_id',
          at: { $ifNull: ['$refund.processedAt', '$refund.initiatedAt'] },
          kind: 'refund',
          direction: 'out',
          amountPaise: { $ifNull: ['$refund.amountPaise', 0] },
          channel: 'online',
          method: 'online',
          status: refundStatus,
          partyType:
            partyType === 'stray'
              ? {
                  $cond: [{ $ne: [{ $ifNull: ['$restaurantId', null] }, null] }, 'restaurant',
                    { $cond: [{ $ne: [{ $ifNull: ['$sellerId', null] }, null] }, 'seller', 'applicant'] }],
                }
              : partyType,
          partyId,
          reference: ref,
          refundOf: model.modelName,
          gatewayId: '$refund.razorpayRefundId',
        }),
      ],
    })),
    {
      coll: RestaurantSettlement.collection.name,
      pipeline: [
        { $match: { ...at('payout.paidAt'), status: 'paid' } },
        row({
          id: { $concat: ['restaurant_payout:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$payout.paidAt',
          kind: 'restaurant_payout',
          direction: 'out',
          amountPaise: { $ifNull: ['$totals.netPayable', 0] },
          channel: 'bank',
          method: 'bank',
          status: 'completed',
          partyType: 'restaurant',
          partyId: '$restaurantId',
          reference: { $literal: null },
          periodStart: '$periodStart',
          gatewayId: { $ifNull: ['$payout.utr', '$payout.reference'] },
        }),
      ],
    },
    {
      coll: Payout.collection.name,
      pipeline: [
        { $match: { ...at('paidAt'), status: 'paid', periodType: 'weekly' } },
        row({
          id: { $concat: ['rider_payout:', { $toString: '$_id' }] },
          docId: '$_id',
          at: '$paidAt',
          kind: 'rider_payout',
          direction: 'out',
          amountPaise: rupeesToPaise('$netPayable'),
          channel: 'bank',
          method: 'bank',
          status: 'completed',
          partyType: 'rider',
          partyId: '$partnerId',
          reference: { $literal: null },
          periodStart: '$periodStart',
          gatewayId: '$paymentReference',
        }),
      ],
    },
  ];
};

// ── Filters ───────────────────────────────────────────────────────────────────────────────────

const istStart = (ymd, field) => {
  if (!DATE_ONLY.test(String(ymd ?? ''))) throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a date like 2026-11-25`);
  const [y, m, d] = ymd.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is not a real date`);
  }
  return new Date(`${ymd}T00:00:00${IST_OFFSET}`);
};

/** IST calendar days [from, to] → [start, end). Both optional: no range = all time. */
export const parseRange = ({ from, to } = {}) => {
  const start = from ? istStart(from, 'from') : new Date(0);
  const end = to ? new Date(istStart(to, 'to').getTime() + DAY_MS) : new Date(Date.now() + DAY_MS);
  if (end <= start) throw new ApiError(400, 'VALIDATION_ERROR', '"to" must be on or after "from"');
  return { start, end };
};

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Name search covers restaurants, sellers, riders and applicants; ids and references match as typed.
const searchMatch = async (q) => {
  const term = String(q ?? '').trim();
  if (!term) return null;
  const rx = new RegExp(escapeRx(term), 'i');
  const [restaurants, sellers, riders] = await Promise.all([
    Restaurant.find({ name: rx }).select('_id').limit(500).lean(),
    Seller.find({ businessName: rx }).select('_id').limit(500).lean(),
    DeliveryPartner.find({ fullName: rx }).select('_id').limit(500).lean(),
  ]);
  const ids = [...restaurants, ...sellers, ...riders].map((d) => d._id);
  return { $or: [{ partyId: { $in: ids } }, { partyName: rx }, { reference: rx }, { gatewayId: rx }] };
};

const buildPipeline = async ({ from, to, direction, kind, q }) => {
  const range = parseRange({ from, to });
  if (direction && !['in', 'out'].includes(direction)) throw new ApiError(400, 'VALIDATION_ERROR', 'direction must be in or out');
  if (kind && !KINDS[kind]) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown transaction type');

  // Drop sources the filter rules out before they are even read.
  const all = sources(range).filter(({ pipeline }) => {
    const proj = pipeline.at(-1).$project;
    if (kind && proj.kind !== kind) return false;
    if (direction && proj.direction !== direction) return false;
    return true;
  });
  if (!all.length) return { base: null, firstColl: null };
  const [first, ...rest] = all;
  const base = [...first.pipeline, ...rest.map(({ coll, pipeline }) => ({ $unionWith: { coll, pipeline } }))];
  const search = await searchMatch(q);
  if (search) base.push({ $match: search });
  return { base, firstColl: first.coll };
};

const zeroTotals = () => ({
  count: 0,
  inPaise: 0, // reached Yulo (online / manual)
  inCount: 0,
  collectedDirectPaise: 0, // counter + cash on delivery: the restaurant or rider holds it
  outPaise: 0,
  outCount: 0,
  netPaise: 0,
});

const totalsStage = {
  $group: {
    _id: null,
    count: { $sum: 1 },
    inPaise: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $in: ['$channel', THROUGH_YULO] }] }, '$amountPaise', 0] } },
    inCount: { $sum: { $cond: [{ $eq: ['$direction', 'in'] }, 1, 0] } },
    collectedDirectPaise: { $sum: { $cond: [{ $and: [{ $eq: ['$direction', 'in'] }, { $not: [{ $in: ['$channel', THROUGH_YULO] }] }] }, '$amountPaise', 0] } },
    outPaise: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, '$amountPaise', 0] } },
    outCount: { $sum: { $cond: [{ $eq: ['$direction', 'out'] }, 1, 0] } },
  },
};

const db = () => mongoose.connection.db;

const run = async (firstColl, pipeline) => db().collection(firstColl).aggregate(pipeline, { allowDiskUse: true }).toArray();

// ── Names for the rows on a page ─────────────────────────────────────────────────────────────

const STRAY_LABEL = {
  duplicate_payment: 'Paid twice',
  bill_already_settled: 'Bill already settled',
  bill_total_changed: 'Bill total changed',
  refused_payment: 'Refused payment',
  dine_in_round_cancelled: 'Round cancelled',
  seller_payment_refused: 'Seller payment refused',
  seller_duplicate_payment: 'Seller paid twice',
  sms_credits_payment_refused: 'SMS payment refused',
  sms_credits_duplicate_payment: 'SMS paid twice',
  job_application_payment_refused: 'Fee refused',
  job_application_duplicate_payment: 'Fee paid twice',
};

const shortRef = (id) => `#${String(id).slice(-6).toUpperCase()}`;

const decorate = async (rows) => {
  const idsOf = (type) => [...new Set(rows.filter((r) => r.partyType === type && r.partyId).map((r) => String(r.partyId)))];
  const [restaurants, sellers, riders, applicants] = await Promise.all([
    Restaurant.find({ _id: { $in: idsOf('restaurant') } }).select('name').lean(),
    Seller.find({ _id: { $in: idsOf('seller') } }).select('businessName').lean(),
    DeliveryPartner.find({ _id: { $in: idsOf('rider') } }).select('fullName phone').lean(),
    JobApplication.find({ _id: { $in: idsOf('applicant') } }).select('fullName applicationNumber').lean(),
  ]);
  const names = new Map([
    ...restaurants.map((d) => [`restaurant:${d._id}`, d.name]),
    ...sellers.map((d) => [`seller:${d._id}`, d.businessName]),
    ...riders.map((d) => [`rider:${d._id}`, d.fullName || d.phone]),
    ...applicants.map((d) => [`applicant:${d._id}`, d.fullName]),
  ]);

  return rows.map((r) => {
    let reference = r.reference;
    if (r.kind === 'order_payment' || (r.kind === 'refund' && r.refundOf === 'Order')) reference = `Order ${shortRef(r.docId)}`;
    else if (r.kind === 'stray_payment' || (r.kind === 'refund' && r.refundOf === 'StrayPayment')) reference = STRAY_LABEL[r.reference] ?? r.reference;
    else if (r.kind === 'restaurant_payout' || r.kind === 'rider_payout') reference = r.periodStart ? `Week of ${new Date(r.periodStart).toISOString().slice(0, 10)}` : null;
    return {
      id: r.id,
      at: r.at,
      kind: r.kind,
      kindLabel: KINDS[r.kind]?.label ?? r.kind,
      direction: r.direction,
      amountPaise: r.amountPaise ?? 0,
      channel: r.channel,
      method: r.method ?? null,
      status: r.status,
      party: {
        type: r.partyType,
        id: r.partyId ?? null,
        name: r.partyName ?? names.get(`${r.partyType}:${r.partyId}`) ?? null,
      },
      reference: reference ?? null,
      gatewayId: r.gatewayId ?? null,
      // Where the admin portal opens this row.
      link: linkOf(r),
    };
  });
};

const linkOf = (r) => {
  switch (r.kind) {
    case 'bill_payment':
      return `/bills/${r.docId}`;
    case 'seller_plan':
    case 'sms_credits':
      return r.partyId ? `/sellers/${r.partyId}` : null;
    case 'job_fee':
      return `/job-applications/${r.docId}`;
    case 'refund':
    case 'stray_payment':
      return '/finance/refunds';
    case 'restaurant_payout':
      return `/payouts/${r.docId}`;
    case 'rider_payout':
      return r.partyId ? `/delivery-partners/${r.partyId}` : null;
    case 'order_payment':
      return r.partyId ? `/stores/${r.partyId}` : null;
    default:
      return null;
  }
};

// ── Public ────────────────────────────────────────────────────────────────────────────────────

/** A page of transactions (newest first) and totals over the whole filter. */
export const listTransactions = async ({ from, to, direction, kind, q, page = 1, limit = 25 } = {}) => {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 25));
  const { base, firstColl } = await buildPipeline({ from, to, direction, kind, q });
  if (!base) return { transactions: [], totals: zeroTotals(), page: p, limit: l, pages: 0 };

  const [res] = await run(firstColl, [
    ...base,
    {
      $facet: {
        rows: [{ $sort: { at: -1, id: -1 } }, { $skip: (p - 1) * l }, { $limit: l }],
        totals: [totalsStage],
      },
    },
  ]);
  const t = res?.totals?.[0] ?? zeroTotals();
  const totals = { ...zeroTotals(), ...t, netPaise: (t.inPaise ?? 0) - (t.outPaise ?? 0) };
  delete totals._id;
  return {
    transactions: await decorate(res?.rows ?? []),
    totals,
    page: p,
    limit: l,
    pages: Math.ceil((totals.count ?? 0) / l),
  };
};

const istToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

/** The dashboard card: today's and this month's totals (IST) and the latest few transactions. */
export const dashboardSummary = async ({ latest = 8 } = {}) => {
  const today = istToday();
  const monthStart = `${today.slice(0, 8)}01`;
  const [todayRes, monthRes, recent] = await Promise.all([
    listTransactions({ from: today, to: today, limit: 1 }),
    listTransactions({ from: monthStart, to: today, limit: 1 }),
    listTransactions({ limit: latest }),
  ]);
  return { today: todayRes.totals, month: monthRes.totals, latest: recent.transactions };
};

const METHOD_LABEL = { online: 'Online', cash: 'Cash', upi: 'UPI', card: 'Card', neft: 'NEFT', cheque: 'Cheque', bank: 'Bank transfer', manual: 'Manual', other: 'Other' };
const CHANNEL_LABEL = { online: 'Through Yulo (Razorpay)', manual: 'Paid to Yulo directly', bank: 'Yulo bank transfer', counter: 'At restaurant counter', cod: 'Cash to rider' };
const istDateTime = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true });

/** Every transaction matching the filter, as an Excel workbook. */
export const exportTransactions = async ({ from, to, direction, kind, q }) => {
  const { base, firstColl } = await buildPipeline({ from, to, direction, kind, q });
  const raw = base ? await run(firstColl, [...base, { $sort: { at: -1, id: -1 } }, { $limit: MAX_EXPORT_ROWS + 1 }]) : [];
  if (raw.length > MAX_EXPORT_ROWS) {
    throw new ApiError(400, 'TOO_MANY_ROWS', `More than ${MAX_EXPORT_ROWS} transactions match — choose a shorter date range.`);
  }
  const rows = await decorate(raw);

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yulo Stores';
  const sheet = wb.addWorksheet('Transactions');
  sheet.columns = [
    { header: 'Date & time (IST)', key: 'at', width: 22 },
    { header: 'Direction', key: 'direction', width: 10 },
    { header: 'Type', key: 'kind', width: 20 },
    { header: 'Party', key: 'party', width: 26 },
    { header: 'Reference', key: 'reference', width: 22 },
    { header: 'Amount (₹)', key: 'amount', width: 13 },
    { header: 'Method', key: 'method', width: 13 },
    { header: 'Money held by', key: 'channel', width: 24 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Gateway / bank ref', key: 'gatewayId', width: 28 },
  ];
  for (const r of rows) {
    sheet.addRow({
      at: istDateTime.format(new Date(r.at)),
      direction: r.direction === 'in' ? 'In' : 'Out',
      kind: r.kindLabel,
      party: r.party.name ?? '',
      reference: r.reference ?? '',
      // Money out is negative, so a SUM over the column is the net.
      amount: (r.direction === 'out' ? -1 : 1) * (r.amountPaise / 100),
      method: METHOD_LABEL[r.method] ?? r.method ?? '',
      channel: CHANNEL_LABEL[r.channel] ?? r.channel ?? '',
      status: r.status === 'completed' ? 'Completed' : 'Processing',
      gatewayId: r.gatewayId ?? '',
    });
  }
  sheet.getColumn('amount').numFmt = '#,##0.00;[Red]-#,##0.00';
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE4572E' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  if (rows.length) sheet.autoFilter = { from: 'A1', to: { row: 1, column: 10 } };

  const name = from || to ? `transactions-${from ?? 'start'}-to-${to ?? istToday()}.xlsx` : `transactions-all-${istToday()}.xlsx`;
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), filename: name, count: rows.length };
};
