import mongoose from 'mongoose';
import { z } from 'zod';
import { env } from '../config/env.js';
import { ABOUT } from '../config/appConfig.config.js';
import Seller from '../models/Seller.js';
import SellerSubscription from '../models/SellerSubscription.js';
import SmsCreditPurchase from '../models/SmsCreditPurchase.js';
import CouponCategory from '../models/CouponCategory.js';
import { nextSequence } from '../models/Counter.js';
import { ApiError } from '../utils/ApiError.js';
import { toRupees } from '../utils/money.js';
import { amountLines, createDocument, day, facts, heading, note } from './pdf/document.js';

// Seller bills — what a coupon seller paid Yulo: a plan (online through Razorpay, or offline via
// "Amount Received") or a pack of SMS credits. One bill per paid purchase, numbered from one
// running sequence ("YSB-000001", …) once it is paid. The super admin lists them with a report,
// opens one, downloads it as a PDF, and exports the list as CSV. Every amount is the one stored on
// the purchase when it was sold; nothing is re-priced here.

const IST = 'Asia/Kolkata';
const DAY_MS = 86_400_000;
const objectId = z.string().regex(/^[a-f\d]{24}$/i, 'Invalid id');
const istDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

// ── Numbering ─────────────────────────────────────────────────────────────────

const formatNumber = (seq) => `YSB-${String(seq).padStart(6, '0')}`;
const isPaidSub = (s) => Boolean(s.activatedAt) && ['active', 'exhausted'].includes(s.status);

/** Gives a paid purchase its bill number, once. Safe to call repeatedly or concurrently. */
const assignNumber = async (Model, id) => {
  const doc = await Model.findById(id).select('billNumber').lean();
  if (!doc || doc.billNumber) return doc?.billNumber ?? null;
  const number = formatNumber(await nextSequence('seller_bill'));
  const res = await Model.updateOne({ _id: id, billNumber: null }, { $set: { billNumber: number } });
  if (res.modifiedCount === 1) return number;
  return (await Model.findById(id).select('billNumber').lean())?.billNumber ?? null; // another call won
};

/** Called as a plan purchase is activated (services/sellerSubscription.service.js). */
export const numberSubscriptionBill = (subscriptionId) => assignNumber(SellerSubscription, subscriptionId);
/** Called as an SMS credit purchase is paid (services/smsCredits.service.js). */
export const numberSmsBill = (purchaseId) => assignNumber(SmsCreditPurchase, purchaseId);

/**
 * Purchases paid before bills existed get their numbers in the order they were paid — the first
 * time the bill list is read. Idempotent.
 */
const backfillNumbers = async () => {
  const [subs, sms] = await Promise.all([
    SellerSubscription.find({ billNumber: null, activatedAt: { $ne: null }, status: { $in: ['active', 'exhausted'] } }).select('activatedAt').lean(),
    SmsCreditPurchase.find({ billNumber: null, status: 'paid' }).select('paidAt').lean(),
  ]);
  const pending = [
    ...subs.map((s) => ({ Model: SellerSubscription, id: s._id, at: s.activatedAt })),
    ...sms.map((p) => ({ Model: SmsCreditPurchase, id: p._id, at: p.paidAt })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at) || String(a.id).localeCompare(String(b.id)));
  for (const p of pending) await assignNumber(p.Model, p.id);
};

// ── Shapes ────────────────────────────────────────────────────────────────────

const METHOD_LABEL = { online: 'Online (Razorpay)', manual: 'Amount Received' };
const MODE_LABEL = { neft: 'Bank transfer', upi: 'UPI', cash: 'Cash', cheque: 'Cheque', other: 'Other' };

const methodOf = (payment) => (payment?.method === 'manual' ? 'manual' : 'online');
const referenceOf = (payment) => (payment?.method === 'manual' ? payment.manual?.reference ?? null : payment?.razorpayPaymentId ?? null);

const subscriptionRow = (s, seller) => {
  const p = s.planSnapshot;
  return {
    id: String(s._id),
    kind: 'plan',
    billNumber: s.billNumber ?? null,
    seller: seller ? { id: String(seller._id), name: seller.businessName, city: seller.address?.city ?? null } : null,
    description: `${p.name} plan — ${p.couponAllocation.toLocaleString('en-IN')} coupons`,
    basePaise: p.basePricePaise,
    handlingFeePercent: p.handlingFeePercent ?? 0,
    handlingFeePaise: p.handlingFeePaise ?? 0,
    gstPercent: p.gstPercent,
    gstPaise: p.gstPaise,
    totalPaise: p.totalPaise,
    paidPaise: s.payment?.amountPaise ?? null,
    method: methodOf(s.payment),
    mode: s.payment?.manual?.mode ?? null,
    reference: referenceOf(s.payment),
    paidAt: s.activatedAt,
  };
};

const smsRow = (p, seller) => ({
  id: String(p._id),
  kind: 'sms',
  billNumber: p.billNumber ?? null,
  seller: seller ? { id: String(seller._id), name: seller.businessName, city: seller.address?.city ?? null } : null,
  description: `${p.credits.toLocaleString('en-IN')} SMS credits @ ₹${toRupees(p.unitPricePaise)}`,
  basePaise: p.pricePaise,
  handlingFeePercent: 0,
  handlingFeePaise: 0,
  gstPercent: p.gstPercent,
  gstPaise: p.gstPaise,
  totalPaise: p.totalPaise,
  paidPaise: p.payment?.amountPaise ?? null,
  method: methodOf(p.payment),
  mode: p.payment?.manual?.mode ?? null,
  reference: referenceOf(p.payment),
  paidAt: p.paidAt,
});

const withRupees = (row) => ({
  ...row,
  amount: {
    base: toRupees(row.basePaise),
    handlingFee: toRupees(row.handlingFeePaise),
    gst: toRupees(row.gstPaise),
    total: toRupees(row.totalPaise),
    paid: row.paidPaise == null ? null : toRupees(row.paidPaise),
  },
});

// ── Filters ───────────────────────────────────────────────────────────────────

export const sellerBillFilterSchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    seller: objectId.optional(),
    kind: z.enum(['plan', 'sms']).optional(),
    method: z.enum(['online', 'manual']).optional(),
    from: istDate.optional(),
    to: istDate.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(20),
  })
  .refine((f) => !f.from || !f.to || f.from <= f.to, { message: '`from` must not be after `to`', path: ['from'] });

export const parseSellerBillFilters = (query) => {
  const parsed = sellerBillFilterSchema.safeParse(query ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid filters', flat);
  }
  return parsed.data;
};

const istMidnight = (ymd) => new Date(new Date(`${ymd}T00:00:00Z`).getTime() - 330 * 60_000);
const range = ({ from, to }) => {
  const r = {};
  if (from) r.$gte = istMidnight(from);
  if (to) r.$lt = new Date(istMidnight(to).getTime() + DAY_MS);
  return Object.keys(r).length ? r : null;
};

/** Every bill matching the filters (no paging), newest first. */
const allRows = async (f) => {
  await backfillNumbers();
  const paidRange = range(f);
  const sellerId = f.seller ? new mongoose.Types.ObjectId(f.seller) : null;
  const methodQuery = f.method === 'manual' ? { 'payment.method': 'manual' } : f.method === 'online' ? { 'payment.method': 'razorpay' } : {};
  const [subs, sms] = await Promise.all([
    f.kind === 'sms'
      ? []
      : SellerSubscription.find({
          activatedAt: { $ne: null, ...(paidRange ?? {}) },
          status: { $in: ['active', 'exhausted'] },
          ...(sellerId ? { sellerId } : {}),
          ...methodQuery,
        }).lean(),
    f.kind === 'plan'
      ? []
      : SmsCreditPurchase.find({
          status: 'paid',
          ...(paidRange ? { paidAt: paidRange } : {}),
          ...(sellerId ? { sellerId } : {}),
          ...methodQuery,
        }).lean(),
  ]);
  const sellerIds = [...new Set([...subs, ...sms].map((x) => String(x.sellerId)))];
  const sellers = new Map((await Seller.find({ _id: { $in: sellerIds } }).select('businessName address.city').lean()).map((s) => [String(s._id), s]));
  let rows = [
    ...subs.filter(isPaidSub).map((s) => subscriptionRow(s, sellers.get(String(s.sellerId)))),
    ...sms.map((p) => smsRow(p, sellers.get(String(p.sellerId)))),
  ];
  if (f.q) {
    const q = f.q.toLowerCase();
    rows = rows.filter((r) => [r.billNumber, r.seller?.name, r.reference, r.description].some((v) => v && String(v).toLowerCase().includes(q)));
  }
  return rows.sort((a, b) => new Date(b.paidAt) - new Date(a.paidAt) || String(b.billNumber).localeCompare(String(a.billNumber)));
};

const sum = (rows, key) => rows.reduce((n, r) => n + (r[key] ?? 0), 0);
const group = (rows) => ({ count: rows.length, totalPaise: sum(rows, 'totalPaise') });

/** The report over the filtered bills: totals and the split by kind and by payment method. */
const summaryOf = (rows) => ({
  count: rows.length,
  basePaise: sum(rows, 'basePaise'),
  handlingFeePaise: sum(rows, 'handlingFeePaise'),
  gstPaise: sum(rows, 'gstPaise'),
  totalPaise: sum(rows, 'totalPaise'),
  total: toRupees(sum(rows, 'totalPaise')),
  byKind: { plan: group(rows.filter((r) => r.kind === 'plan')), sms: group(rows.filter((r) => r.kind === 'sms')) },
  byMethod: { online: group(rows.filter((r) => r.method === 'online')), manual: group(rows.filter((r) => r.method === 'manual')) },
});

// ── Reads ─────────────────────────────────────────────────────────────────────

/** GET /api/admin/seller-bills — a page of bills plus the report over everything filtered. */
export const listSellerBills = async (query) => {
  const f = parseSellerBillFilters(query);
  const rows = await allRows(f);
  const start = (f.page - 1) * f.limit;
  return { bills: rows.slice(start, start + f.limit).map(withRupees), total: rows.length, page: f.page, limit: f.limit, summary: summaryOf(rows) };
};

/** One bill in full: Yulo, who it is billed to, the lines, and the payment. 404 if not a paid bill. */
export const sellerBillDetail = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  await backfillNumbers();
  const sub = await SellerSubscription.findById(id).lean();
  const sms = sub ? null : await SmsCreditPurchase.findById(id).lean();
  const doc = sub ?? sms;
  if (!doc || (sub && !isPaidSub(sub)) || (sms && sms.status !== 'paid')) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');
  const seller = await Seller.findById(doc.sellerId).select('businessName gstNumber address businessPhone owner.name categoryId').lean();
  const category = seller?.categoryId ? await CouponCategory.findById(seller.categoryId).select('name').lean() : null;
  const row = sub ? subscriptionRow(sub, seller) : smsRow(sms, seller);
  const lines = [{ label: row.description, amountPaise: row.basePaise }];
  if (row.handlingFeePaise) lines.push({ label: `Payment handling fee (${row.handlingFeePercent}%)`, amountPaise: row.handlingFeePaise });
  lines.push({ label: `GST (${row.gstPercent}%)`, amountPaise: row.gstPaise });
  const address = seller?.address ?? {};
  return {
    bill: {
      ...withRupees(row),
      issuedBy: { name: ABOUT.legalName, gstin: env.YULO_GSTIN || null, address: env.YULO_BILLING_ADDRESS || null, email: ABOUT.supportEmail },
      billedTo: {
        name: seller?.businessName ?? null,
        ownerName: seller?.owner?.name ?? null,
        category: category?.name ?? null,
        gstin: seller?.gstNumber ?? null,
        phone: seller?.businessPhone ?? null,
        address: [address.line1, address.line2, address.city, address.state, address.pincode].filter(Boolean).join(', ') || null,
      },
      lines,
      payment: {
        method: row.method,
        methodLabel: METHOD_LABEL[row.method],
        mode: row.mode,
        modeLabel: row.mode ? MODE_LABEL[row.mode] ?? row.mode : null,
        reference: row.reference,
        razorpayOrderId: doc.payment?.razorpayOrderId ?? null,
        receivedOn: doc.payment?.manual?.receivedOn ?? null,
        paidAt: row.paidAt,
        amountPaise: row.paidPaise,
      },
    },
  };
};

// ── Downloads ─────────────────────────────────────────────────────────────────

/** The bill as a PDF — built from the same detail the screen shows. */
export const sellerBillPdf = async (id, { now = new Date() } = {}) => {
  const { bill } = await sellerBillDetail(id);
  const { doc, done } = createDocument({
    title: `Bill ${bill.billNumber}`,
    subtitle: `${bill.issuedBy.name} · ${bill.kind === 'plan' ? 'Coupon plan' : 'SMS credits'}`,
    timezone: IST,
    now,
  });
  heading(doc, 'Issued by');
  facts(doc, [
    ['Name', bill.issuedBy.name],
    bill.issuedBy.gstin ? ['GSTIN', bill.issuedBy.gstin] : null,
    bill.issuedBy.address ? ['Address', bill.issuedBy.address] : null,
  ].filter(Boolean));
  heading(doc, 'Billed to');
  facts(doc, [
    ['Business', bill.billedTo.name ?? '—'],
    bill.billedTo.ownerName ? ['Owner', bill.billedTo.ownerName] : null,
    bill.billedTo.gstin ? ['GSTIN', bill.billedTo.gstin] : null,
    bill.billedTo.address ? ['Address', bill.billedTo.address] : null,
    bill.billedTo.phone ? ['Phone', bill.billedTo.phone] : null,
  ].filter(Boolean));
  heading(doc, 'Bill');
  facts(doc, [
    ['Bill number', bill.billNumber],
    ['Date', day(bill.paidAt, IST)],
  ]);
  amountLines(doc, bill.lines, { total: { label: 'Total', amountPaise: bill.totalPaise } });
  heading(doc, 'Payment');
  facts(doc, [
    ['Paid by', bill.payment.methodLabel + (bill.payment.modeLabel ? ` · ${bill.payment.modeLabel}` : '')],
    bill.payment.reference ? ['Reference', bill.payment.reference] : null,
    bill.payment.receivedOn ? ['Received on', day(bill.payment.receivedOn, IST)] : null,
    ['Paid on', day(bill.paidAt, IST)],
    bill.payment.amountPaise != null ? ['Amount paid', `₹${toRupees(bill.payment.amountPaise).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`] : null,
  ].filter(Boolean));
  note(doc, 'This is a computer-generated bill.');
  const { buffer, text } = await done();
  return { buffer, text, filename: `${bill.billNumber}.pdf` };
};

const istDateTime = (d) => (d ? new Date(new Date(d).getTime() + 330 * 60_000).toISOString().slice(0, 16).replace('T', ' ') : '');
const csvCell = (value) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
};
const COLUMNS = [
  ['Bill number', (r) => r.billNumber],
  ['Paid on (IST)', (r) => istDateTime(r.paidAt)],
  ['Seller', (r) => r.seller?.name],
  ['City', (r) => r.seller?.city],
  ['For', (r) => (r.kind === 'plan' ? 'Coupon plan' : 'SMS credits')],
  ['Description', (r) => r.description],
  ['Price (₹)', (r) => toRupees(r.basePaise)],
  ['Handling fee (₹)', (r) => toRupees(r.handlingFeePaise)],
  ['GST (₹)', (r) => toRupees(r.gstPaise)],
  ['Total (₹)', (r) => toRupees(r.totalPaise)],
  ['Paid (₹)', (r) => (r.paidPaise == null ? '' : toRupees(r.paidPaise))],
  ['Paid by', (r) => METHOD_LABEL[r.method] + (r.mode ? ` · ${MODE_LABEL[r.mode] ?? r.mode}` : '')],
  ['Reference', (r) => r.reference],
];

/** The filtered bills (all pages) as CSV, with a totals row. */
export const sellerBillsCsv = async (query) => {
  const f = parseSellerBillFilters({ ...query, page: 1, limit: 200 });
  const rows = await allRows(f);
  const s = summaryOf(rows);
  const lines = [
    COLUMNS.map(([h]) => csvCell(h)).join(','),
    ...rows.map((r) => COLUMNS.map(([, get]) => csvCell(get(r))).join(',')),
    ['Total', '', '', '', `${s.count} bills`, '', toRupees(s.basePaise), toRupees(s.handlingFeePaise), toRupees(s.gstPaise), toRupees(s.totalPaise), '', '', ''].map(csvCell).join(','),
  ];
  return `﻿${lines.join('\r\n')}\r\n`;
};
