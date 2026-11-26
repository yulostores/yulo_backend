// The owner's "Download bills" Excel export — GET /api/owner/:rId/bills/export.xlsx.
//
// One workbook for a single day or a date range, read the same way the bill screens read
// (billView.service.js), so every figure matches the receipt the owner can open:
//   • Day-wise — one row per day in the range: bill count, paid bills and their takings.
//   • Bills    — one row per bill with its full charge breakdown and a totals row.
//   • Items    — one row per dish per bill (the receipt's lines).
//
// Days are calendar days in India (Asia/Kolkata): "2026-11-25" means 00:00–23:59 IST, and a
// bill belongs to the day it was raised (createdAt) — the same date the Bills list shows.
// Cells are written as typed values, never formulas, so a dish or guest name can't run as one.

import ExcelJS from 'exceljs';

import Bill from '../models/Bill.js';
import * as billViewService from './billView.service.js';
import { ApiError } from '../utils/ApiError.js';

export const TIMEZONE = 'Asia/Kolkata';
const IST_OFFSET = '+05:30';
const DAY_MS = 24 * 60 * 60 * 1000;
export const MAX_DAYS = 366;
export const MAX_BILLS = 20_000;
const CHUNK = 500;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** "2026-11-25" → the IST day as [start, end) instants; throws 400 on anything else. */
const dayStart = (value, field) => {
  if (!DATE_ONLY.test(String(value ?? ''))) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} must be a date like 2026-11-25`);
  }
  const [y, m, day] = value.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, day));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== day) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is not a real date`);
  }
  return new Date(`${value}T00:00:00${IST_OFFSET}`);
};

/**
 * Validates the requested range. `to` defaults to `from` (a single day).
 * Returns { from, to, start, end } with end exclusive.
 */
export const parseRange = ({ from, to }) => {
  const fromDay = String(from ?? '').trim();
  const toDay = String(to ?? '').trim() || fromDay;
  const start = dayStart(fromDay, 'from');
  const lastDay = dayStart(toDay, 'to');
  if (lastDay < start) throw new ApiError(400, 'VALIDATION_ERROR', '"to" must be on or after "from"');
  const end = new Date(lastDay.getTime() + DAY_MS);
  if ((end - start) / DAY_MS > MAX_DAYS) {
    throw new ApiError(400, 'RANGE_TOO_LONG', `Choose a range of ${MAX_DAYS} days or fewer`);
  }
  return { from: fromDay, to: toDay, start, end };
};

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit', hour12: true });
const istDay = (d) => (d ? dayFmt.format(new Date(d)) : '');
const istTime = (d) => (d ? timeFmt.format(new Date(d)) : '');
// "2026-11-25" → "25-11-2026", how dates are written in India.
const displayDay = (ymd) => (ymd ? ymd.split('-').reverse().join('-') : '');

const TYPE_LABEL = { dine_in: 'Dine-in', delivery: 'Delivery', takeaway: 'Takeaway' };
const STATUS_LABEL = { open: 'Open', paid: 'Paid', cancelled: 'Cancelled' };
const METHOD_LABEL = { cash: 'Cash', upi: 'UPI', card: 'Card', online: 'Online' };

// A charge line from the pricing engine, in rupees (0 when the bill has no such line).
const lineRupees = (view, key) => {
  const line = view.chargeBreakdown?.lines?.find((l) => l.key === key);
  return line ? Math.round(line.amountPaise) / 100 : 0;
};

const MONEY_FMT = '#,##0.00';
const BRAND = 'FFE4572E';

const styleHeader = (sheet) => {
  const row = sheet.getRow(1);
  row.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND } };
  row.alignment = { vertical: 'middle' };
  row.height = 20;
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
};

const styleTotal = (row) => {
  row.font = { bold: true };
  row.border = { top: { style: 'thin' } };
};

const BILL_COLUMNS = [
  { header: 'Date', key: 'date', width: 12 },
  { header: 'Time', key: 'time', width: 10 },
  { header: 'Bill no.', key: 'billNumber', width: 14 },
  { header: 'Type', key: 'type', width: 10 },
  { header: 'Table', key: 'table', width: 8 },
  { header: 'Customer', key: 'customer', width: 18 },
  { header: 'Phone', key: 'phone', width: 15 },
  { header: 'Status', key: 'status', width: 10 },
  { header: 'Paid by', key: 'method', width: 9 },
  { header: 'Paid at', key: 'paidAt', width: 18 },
  { header: 'Items', key: 'itemCount', width: 7 },
  { header: 'Item total (₹)', key: 'subtotal', width: 13, money: true },
  { header: 'Discount (₹)', key: 'discount', width: 12, money: true },
  { header: 'GST (₹)', key: 'gst', width: 10, money: true },
  { header: 'Packaging (₹)', key: 'packaging', width: 12, money: true },
  { header: 'Service charge (₹)', key: 'serviceCharge', width: 15, money: true },
  { header: 'Delivery fee (₹)', key: 'deliveryFee', width: 14, money: true },
  { header: 'Platform fee (₹)', key: 'platformFee', width: 14, money: true },
  { header: 'Tip (₹)', key: 'tip', width: 9, money: true },
  { header: 'Round off (₹)', key: 'roundOff', width: 12, money: true },
  { header: 'Grand total (₹)', key: 'grandTotal', width: 14, money: true },
];
const MONEY_KEYS = BILL_COLUMNS.filter((c) => c.money).map((c) => c.key);

const billRow = (v) => {
  const c = v.charges ?? {};
  return {
    date: displayDay(istDay(v.createdAt)),
    time: istTime(v.createdAt),
    billNumber: v.billNumber ?? v.reference ?? String(v._id),
    type: TYPE_LABEL[v.type] ?? v.type ?? '',
    table: v.tableNumber ?? '',
    customer: v.customer?.name ?? '',
    phone: v.customer?.phone ?? '',
    status: STATUS_LABEL[v.status] ?? v.status ?? '',
    method: METHOD_LABEL[v.payment?.method] ?? v.payment?.method ?? '',
    paidAt: v.payment?.paidAt ? `${displayDay(istDay(v.payment.paidAt))} ${istTime(v.payment.paidAt)}` : '',
    itemCount: v.itemCount ?? 0,
    subtotal: c.subtotal ?? 0,
    // Shown as a positive amount taken off, as on the printed bill.
    discount: c.discountTotal ?? 0,
    gst: c.gstAmount ?? 0,
    packaging: lineRupees(v, 'packaging'),
    serviceCharge: c.serviceChargeAmount ?? 0,
    deliveryFee: c.deliveryFee ?? 0,
    platformFee: c.platformFee ?? 0,
    tip: c.tip ?? 0,
    roundOff: c.roundOff ?? 0,
    grandTotal: c.grandTotal ?? 0,
  };
};

const round2 = (n) => Math.round(n * 100) / 100;

/** Every IST day from `from` to `to`, inclusive, as "YYYY-MM-DD". */
const daysBetween = (start, end) => {
  const days = [];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) days.push(istDay(new Date(t)));
  return days;
};

/**
 * Loads the bills in range (optionally by status/type) and returns
 * { buffer, filename, count }.
 */
export const buildBillsWorkbook = async ({ restaurantId, restaurantName, from, to, status, type }) => {
  const range = parseRange({ from, to });
  const filter = { restaurantId, createdAt: { $gte: range.start, $lt: range.end } };
  if (status) {
    if (!STATUS_LABEL[status]) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown bill status');
    filter.status = status;
  }
  if (type) {
    if (!TYPE_LABEL[type]) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown bill type');
    filter.type = type;
  }

  const count = await Bill.countDocuments(filter);
  if (count > MAX_BILLS) {
    throw new ApiError(400, 'TOO_MANY_BILLS', `That range has ${count} bills — choose a shorter range (up to ${MAX_BILLS} bills).`);
  }

  // Oldest first, the way a day book reads. Built in chunks so a long range doesn't load
  // every table, waiter and session behind thousands of bills in one go.
  const views = [];
  const cursor = Bill.find(filter).sort({ createdAt: 1, _id: 1 }).lean().cursor({ batchSize: CHUNK });
  let chunk = [];
  for await (const bill of cursor) {
    chunk.push(bill);
    if (chunk.length === CHUNK) {
      views.push(...(await billViewService.buildBillViews(chunk)));
      chunk = [];
    }
  }
  if (chunk.length) views.push(...(await billViewService.buildBillViews(chunk)));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'Yulo Stores';
  wb.created = new Date();

  // ── Day-wise ────────────────────────────────────────────────────────
  const summary = wb.addWorksheet('Day-wise');
  summary.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Bills', key: 'bills', width: 8 },
    { header: 'Paid bills', key: 'paid', width: 10 },
    { header: 'Open bills', key: 'open', width: 10 },
    { header: 'Cancelled', key: 'cancelled', width: 10 },
    { header: 'Item total (₹)', key: 'subtotal', width: 14 },
    { header: 'Discount (₹)', key: 'discount', width: 12 },
    { header: 'GST (₹)', key: 'gst', width: 11 },
    { header: 'Paid takings (₹)', key: 'takings', width: 15 },
    { header: 'Cash (₹)', key: 'cash', width: 11 },
    { header: 'UPI (₹)', key: 'upi', width: 11 },
    { header: 'Card (₹)', key: 'card', width: 11 },
    { header: 'Online (₹)', key: 'online', width: 11 },
  ];
  const zeroDay = () => ({ bills: 0, paid: 0, open: 0, cancelled: 0, subtotal: 0, discount: 0, gst: 0, takings: 0, cash: 0, upi: 0, card: 0, online: 0 });
  const byDay = new Map(daysBetween(range.start, range.end).map((d) => [d, zeroDay()]));
  const rows = views.map((v) => ({ view: v, row: billRow(v) }));
  for (const { view, row } of rows) {
    const day = byDay.get(istDay(view.createdAt)) ?? zeroDay();
    day.bills += 1;
    if (view.status === 'paid') day.paid += 1;
    else if (view.status === 'cancelled') day.cancelled += 1;
    else day.open += 1;
    // Money only from paid bills: an open bill can still change, a cancelled one never settles.
    if (view.status === 'paid') {
      day.subtotal += row.subtotal;
      day.discount += row.discount;
      day.gst += row.gst;
      day.takings += row.grandTotal;
      const m = view.payment?.method;
      if (m && m in day) day[m] += row.grandTotal;
    }
    byDay.set(istDay(view.createdAt), day);
  }
  const total = zeroDay();
  for (const [date, d] of [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const r = { date: displayDay(date) };
    for (const k of Object.keys(total)) {
      total[k] += d[k];
      r[k] = Number.isInteger(d[k]) ? d[k] : round2(d[k]);
    }
    summary.addRow(r);
  }
  styleTotal(summary.addRow({ date: 'Total', ...Object.fromEntries(Object.entries(total).map(([k, n]) => [k, round2(n)])) }));
  for (const k of ['subtotal', 'discount', 'gst', 'takings', 'cash', 'upi', 'card', 'online']) summary.getColumn(k).numFmt = MONEY_FMT;
  styleHeader(summary);
  summary.addRow([]);
  summary.addRow([`Money columns count paid bills only. Dates are in India time (IST).`]).font = { italic: true, color: { argb: 'FF6B5747' } };

  // ── Bills ───────────────────────────────────────────────────────────
  const billsSheet = wb.addWorksheet('Bills');
  billsSheet.columns = BILL_COLUMNS.map(({ header, key, width }) => ({ header, key, width }));
  for (const { row } of rows) billsSheet.addRow(row);
  const sums = Object.fromEntries(MONEY_KEYS.map((k) => [k, round2(rows.reduce((n, { row }) => n + (row[k] ?? 0), 0))]));
  styleTotal(billsSheet.addRow({ date: 'Total', itemCount: rows.reduce((n, { row }) => n + row.itemCount, 0), ...sums }));
  for (const k of MONEY_KEYS) billsSheet.getColumn(k).numFmt = MONEY_FMT;
  styleHeader(billsSheet);
  if (rows.length) billsSheet.autoFilter = { from: 'A1', to: { row: 1, column: BILL_COLUMNS.length } };

  // ── Items ───────────────────────────────────────────────────────────
  const itemsSheet = wb.addWorksheet('Items');
  itemsSheet.columns = [
    { header: 'Date', key: 'date', width: 12 },
    { header: 'Bill no.', key: 'billNumber', width: 14 },
    { header: 'Status', key: 'status', width: 10 },
    { header: 'Item', key: 'name', width: 30 },
    { header: 'Qty', key: 'quantity', width: 6 },
    { header: 'Price (₹)', key: 'unitPrice', width: 10 },
    { header: 'Line total (₹)', key: 'lineTotal', width: 13 },
    { header: 'Note', key: 'note', width: 24 },
  ];
  for (const { view, row } of rows) {
    for (const item of view.items ?? []) {
      itemsSheet.addRow({
        date: row.date,
        billNumber: row.billNumber,
        status: row.status,
        name: item.name ?? '',
        quantity: item.quantity ?? 0,
        unitPrice: item.unitPrice ?? 0,
        lineTotal: item.lineTotal ?? 0,
        note: (item.notes ?? []).join('; '),
      });
    }
  }
  itemsSheet.getColumn('unitPrice').numFmt = MONEY_FMT;
  itemsSheet.getColumn('lineTotal').numFmt = MONEY_FMT;
  styleHeader(itemsSheet);

  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const slug = String(restaurantName ?? 'restaurant').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'restaurant';
  const filename = range.from === range.to ? `bills-${slug}-${range.from}.xlsx` : `bills-${slug}-${range.from}-to-${range.to}.xlsx`;
  return { buffer, filename, count: views.length };
};
