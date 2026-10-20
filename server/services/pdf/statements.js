import Restaurant from '../../models/Restaurant.js';
import { ApiError } from '../../utils/ApiError.js';
import { getActiveSettings } from '../financeSettings.service.js';
import * as ownerPayments from '../ownerPayments.service.js';
import { payoutDetail } from '../payoutView.service.js';
import { getSettlementDetail } from '../settlement.service.js';
import { amountLines, createDocument, day, facts, heading, money, note, periodText, slug, table } from './document.js';

// The PDFs behind the download buttons — built from the very view the screen shows
// (services/ownerPayments.service.js for the owner, payoutView.service.js for the admin), so a
// PDF can never disagree with the page. Nothing here works money out.
//
// Owner documents never carry Razorpay's fee, Yulo's margin, rider pay or the staff hold note.
// Each builder returns { buffer, text, filename } — `text` is every string written, for checks.

const ELIGIBILITY = { pending: 'Pending', eligible: 'Eligible', on_hold: 'On hold' };
const ORDER_STATUS = { pending: 'Pending', eligible: 'Eligible', on_hold: 'On hold', settled: 'Settled', refunded: 'Refunded' };
const PAYMENT_TYPE = {
  online: 'Paid online',
  dine_in_online: 'Dine-in · paid online',
  dine_in_counter: 'Dine-in · paid at table',
  counter: 'Paid at the counter',
  cod: 'Cash on delivery',
};
const STAGE = {
  awaiting_delivery: 'Awaiting delivery',
  clearing: 'Payment clearing (Razorpay T+2)',
  eligible: 'Eligible — joins the next weekly statement',
  in_statement: 'In a weekly statement',
  settled: 'Paid to your bank',
  refunded: 'Refunded to the customer',
  counter: 'Paid at the restaurant',
};

const zone = async () => (await getActiveSettings()).settlementCycle?.timezone ?? 'Asia/Kolkata';
const restaurantName = async (id) => (await Restaurant.findById(id).select('name').lean())?.name ?? 'Restaurant';
const fileDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : 'undated');

const ordersTable = (doc, orders, timezone) =>
  table(
    doc,
    [
      { header: 'Order / bill', width: 0.16 },
      { header: 'Date', width: 0.15 },
      { header: 'Payment type', width: 0.24 },
      { header: 'Customer paid', width: 0.16, align: 'right' },
      { header: 'You receive', width: 0.15, align: 'right' },
      { header: 'Status', width: 0.14 },
    ],
    orders.map((o) => [
      o.displayNo ?? '—',
      day(o.date, timezone),
      `${PAYMENT_TYPE[o.paymentType] ?? o.paymentType}${o.counterMethod ? ` (${o.counterMethod})` : ''}`,
      o.customerPaidPaise == null ? 'Paid at table' : money(o.customerPaidPaise),
      money(o.youReceivePaise),
      ORDER_STATUS[o.status] ?? o.status,
    ])
  );

const transferFacts = (transfer, timezone) => [
  ['Bank transfer', transfer?.label ?? '—'],
  transfer?.scheduledFor && transfer.status !== 'paid' ? ['Scheduled for', day(transfer.scheduledFor, timezone)] : null,
  transfer?.paidAt ? ['Paid on', day(transfer.paidAt, timezone)] : null,
  transfer?.bankReference ? ['Bank reference', transfer.bankReference] : null,
  transfer?.lastFailure ? ['Last attempt', `${transfer.lastFailure.label ?? 'Failed'} · ${day(transfer.lastFailure.at, timezone)}`] : null,
];

// ── Owner: weekly statement ───────────────────────────────────────────────────

export const ownerStatementPdf = async (restaurantId, statementId, { now = new Date() } = {}) => {
  const [data, name, timezone] = await Promise.all([
    ownerPayments.statementDetail(restaurantId, statementId),
    restaurantName(restaurantId),
    zone(),
  ]);
  const s = data.statement;
  const { doc, done } = createDocument({
    title: 'Statement & payout detail',
    subtitle: `${name} · ${periodText(s.period, timezone)}`,
    timezone,
    now,
  });

  heading(doc, 'Statement summary');
  facts(doc, [
    ['Restaurant', name],
    ['Statement period', periodText(s.period, timezone)],
    ['Settlement eligibility', ELIGIBILITY[s.eligibility] ?? s.eligibility],
    ...transferFacts(s.transfer, timezone),
    s.holdLabel ? ['On hold', s.holdLabel] : null,
    ['Destination', s.destinationLast4 ? `Bank account ending ${s.destinationLast4}` : 'No bank account on file'],
    ['Net restaurant payout', money(s.netPayoutPaise)],
  ]);
  if (data.ownerView?.message) note(doc, data.ownerView.message);

  heading(doc, 'How this is calculated');
  amountLines(doc, data.calculation.lines, { total: { label: 'Net payout', amountPaise: data.calculation.netPayoutPaise } });
  const other = data.otherFeeCategories ?? [];
  if (other.every((o) => !o.amountPaise)) note(doc, 'Other fee categories (restaurant platform, ads, penalties): all ₹0.00.');
  else amountLines(doc, other);

  heading(doc, 'Yulo money');
  facts(doc, [['Customer-paid platform and delivery charges', money(data.yuloMoneyPaise)]]);
  note(doc, 'Paid by customers directly to Yulo for its services. Outside your restaurant payout — not an extra deduction.');

  heading(doc, 'Payout timeline');
  facts(doc, data.timeline.map((t) => [t.label, t.done ? `${day(t.at ?? t.date, timezone)}${t.reasonLabel ? ` · ${t.reasonLabel}` : ''}` : t.date ? `For ${day(t.date, timezone)}` : 'Not yet']));

  heading(doc, 'Orders in this statement');
  if (data.hasEntries) ordersTable(doc, data.orders, timezone);
  else note(doc, 'Order breakdown unavailable for this statement.');

  const { buffer, text } = await done();
  return { buffer, text, filename: `yulo-statement-${slug(name)}-${fileDate(s.period?.start)}.pdf` };
};

// ── Owner: one order's / bill's payment statement ─────────────────────────────

export const ownerPaymentPdf = async (restaurantId, kind, id, { now = new Date() } = {}) => {
  const [d, name, timezone] = await Promise.all([
    ownerPayments.paymentDetail(restaurantId, kind, id, { now }),
    restaurantName(restaurantId),
    zone(),
  ]);
  const { doc, done } = createDocument({
    title: `${kind === 'bill' ? 'Bill' : 'Order'} ${d.displayNo ?? ''} — payment statement`.trim(),
    subtitle: `${name} · ${day(d.date, timezone, true)}`,
    timezone,
    now,
  });

  facts(doc, [
    ['Payment type', `${PAYMENT_TYPE[d.paymentType] ?? d.paymentType}${d.customerBill?.counterMethod ? ` (${d.customerBill.counterMethod})` : ''}`],
    d.tableNumber ? ['Table', String(d.tableNumber)] : null,
    ['Settlement eligibility', ORDER_STATUS[d.status] ?? d.status],
    [d.restaurantSettlement?.projected ? 'Expected restaurant settlement' : 'Restaurant settlement', money(d.restaurantSettlement?.receivedPaise)],
  ]);
  if (d.restaurantSettlement?.projected) note(doc, 'Expected, not confirmed: payment clearance and settlement eligibility must be confirmed before this joins a weekly payout.');

  heading(doc, 'Customer bill');
  if (d.customerBill?.paidAtTable) note(doc, 'Paid at the restaurant — not collected through Yulo.');
  amountLines(
    doc,
    (d.customerBill?.lines ?? []).map((l) => ({
      label: l.freeDelivery ? `${l.label} (free delivery — restaurant pays)` : l.label,
      amountPaise: l.amountPaise,
      sub: l.basePaise != null && l.gstPaise ? `${money(l.basePaise)} + ${money(l.gstPaise)} GST` : null,
    })),
    d.customerBill?.paidAmountPaise != null ? { total: { label: 'Paid amount', amountPaise: d.customerBill.paidAmountPaise } } : {}
  );

  heading(doc, 'Restaurant settlement');
  amountLines(
    doc,
    (d.restaurantSettlement?.lines ?? []).map((l) => ({
      label: l.label,
      amountPaise: l.amountPaise,
      sub:
        l.key === 'settlementFee'
          ? `${l.percent}% of ${money(l.onAmountPaise)} · ${money(l.basePaise)} + ${money(l.gstPaise)} GST`
          : null,
    })),
    { total: { label: 'Received amount', amountPaise: d.restaurantSettlement?.receivedPaise } }
  );
  const other = d.otherFeeCategories ?? [];
  if (other.every((o) => !o.amountPaise)) note(doc, 'Other fee categories (restaurant platform, ads, penalties): all ₹0.00.');
  else amountLines(doc, other);

  heading(doc, 'Clearance & eligibility');
  facts(doc, [
    ['Stage', STAGE[d.clearance?.stage] ?? d.clearance?.stage],
    d.clearance?.paidAt ? ['Customer payment received', day(d.clearance.paidAt, timezone, true)] : null,
    d.clearance?.clearsAt ? ['Payment clears', day(d.clearance.clearsAt, timezone)] : null,
    d.clearance?.scheduledFor ? ['Weekly bank payout', day(d.clearance.scheduledFor, timezone)] : null,
  ]);

  heading(doc, 'Linked weekly statement');
  if (d.linkedStatement) {
    facts(doc, [
      ['Statement period', periodText(d.linkedStatement.period, timezone)],
      ['This order contributes', money(d.linkedStatement.contributionPaise)],
      ['Statement net payout', money(d.linkedStatement.netPayoutPaise)],
    ]);
  } else {
    note(doc, 'Not in a weekly statement yet.');
  }
  if (d.yuloMoneyPaise) facts(doc, [['Yulo money (customer-paid, outside your payout)', money(d.yuloMoneyPaise)]]);
  if (d.refund) {
    heading(doc, 'Refund');
    facts(doc, [
      ['Status', d.refund.status],
      ['Amount refunded to the customer', money(d.refund.amountPaise)],
      d.refund.reason ? ['Reason', d.refund.reason] : null,
    ]);
  }

  const { buffer, text } = await done();
  return { buffer, text, filename: `yulo-${kind}-${slug(d.displayNo ?? id)}-${fileDate(d.date)}.pdf` };
};

// ── Admin: statement (owner content + platform figures) ───────────────────────

export const adminStatementPdf = async (id, { now = new Date() } = {}) => {
  const [d, timezone] = await Promise.all([payoutDetail(id), zone()]);
  const { platformTotals } = await getSettlementDetail(id);
  const s = d.settlement;
  const name = d.restaurant?.name ?? 'Restaurant';
  const { doc, done } = createDocument({
    title: 'Payout statement (admin)',
    subtitle: `${name} · ${periodText({ start: s.periodStart, end: s.periodEnd }, timezone)}`,
    timezone,
    now,
  });

  heading(doc, 'Payout');
  facts(doc, [
    ['Restaurant', name],
    ['Statement period', periodText({ start: s.periodStart, end: s.periodEnd }, timezone)],
    ['Eligibility', ELIGIBILITY[d.eligibility] ?? d.eligibility],
    ...transferFacts(d.transfer, timezone),
    s.payout?.attemptRef ? ['Attempt reference', s.payout.attemptRef] : null,
    s.hold ? ['On hold', s.hold.label ?? s.hold.reason] : null,
    s.hold?.internalNote ? ['Internal note (staff only)', s.hold.internalNote] : null,
    ['Destination', d.destination?.accountNumberLast4 ? `Account ending ${d.destination.accountNumberLast4}${d.destination.verified ? ' · verified' : ''}` : '—'],
    ['Net payable', money(s.totals?.netPayable)],
  ]);
  if (d.ownerView?.message) note(doc, `What the owner sees: ${d.ownerView.message}`);

  heading(doc, 'How this is calculated');
  amountLines(doc, d.calculation.lines, { total: { label: 'Net payout', amountPaise: d.calculation.netPayoutPaise } });

  heading(doc, 'Platform figures (admin only)');
  facts(doc, [
    ['Razorpay fees (actual)', money(platformTotals.gatewayFees)],
    ['Yulo margin on settlement charge', money(platformTotals.yuloSettlementMargin)],
    ['Rider pay', money(platformTotals.riderPay)],
    ['Yulo money (platform fees + delivery)', money((s.totals?.yuloMoneyPlatformFee ?? 0) + (s.totals?.yuloMoneyDelivery ?? 0))],
  ]);

  heading(doc, 'Records in this statement');
  table(
    doc,
    [
      { header: 'Record', width: 0.18 },
      { header: 'Type', width: 0.26 },
      { header: 'Date', width: 0.18 },
      { header: 'Amount to restaurant', width: 0.22, align: 'right' },
      { header: 'Status', width: 0.16 },
    ],
    d.records.map((r) => [r.displayNo ?? '—', r.type, day(r.datedAt, timezone), money(r.amountToRestaurantPaise), ORDER_STATUS[r.status] ?? r.status])
  );

  const { buffer, text } = await done();
  return { buffer, text, filename: `yulo-admin-statement-${slug(name)}-${fileDate(s.periodStart)}.pdf`, restaurantId: s.restaurantId };
};

// ── Admin: payout receipt (paid payouts only) ─────────────────────────────────

export const payoutReceiptPdf = async (id, { now = new Date() } = {}) => {
  const [d, timezone] = await Promise.all([payoutDetail(id), zone()]);
  const s = d.settlement;
  if (s.status !== 'paid') throw new ApiError(409, 'NOT_PAID', 'A receipt exists only once the payout is recorded as paid');
  const name = d.restaurant?.name ?? 'Restaurant';
  const { doc, done } = createDocument({ title: 'Payout receipt', subtitle: `${name} · Yulo Stores`, timezone, now });
  facts(doc, [
    ['Restaurant', name],
    ['Statement period', periodText({ start: s.periodStart, end: s.periodEnd }, timezone)],
    ['Amount paid', money(s.totals?.netPayable)],
    ['Destination', d.destination?.accountNumberLast4 ? `Bank account ending ${d.destination.accountNumberLast4}` : '—'],
    ['Bank reference', s.payout?.bankReference ?? '—'],
    ['Date credited', day(s.payout?.creditedAt, timezone)],
    s.payout?.releasedAt ? ['Released', day(s.payout.releasedAt, timezone, true)] : null,
    s.payout?.attemptRef ? ['Attempt reference', s.payout.attemptRef] : null,
    ['Recorded by', 'Yulo Stores'],
  ]);
  note(doc, 'This receipt records the bank transfer Yulo Stores made for the statement above. Check the bank reference against your bank statement.');
  const { buffer, text } = await done();
  return { buffer, text, filename: `yulo-payout-receipt-${slug(name)}-${fileDate(s.periodStart)}.pdf`, restaurantId: s.restaurantId };
};
