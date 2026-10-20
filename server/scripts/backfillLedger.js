// Credits restaurants' ledgers (models/RestaurantLedgerEntry.js) for online-paid money that
// has no ledger row: orders delivered before the ledger existed (B4), orders whose ledger write
// failed at the time and was only logged (services/ledger.service.js never fails a delivery
// over it), and — on request — legacy dine-in bills paid online. Marked note: 'backfill'.
//
//   node scripts/backfillLedger.js --since 2026-10-20                          # report only
//   node scripts/backfillLedger.js --since 2026-10-20 --apply                  # write the rows
//   … --until 2026-10-27                       only money up to this date (default: now)
//   … --legacy-delivery restaurant             see "legacy delivery fees" below
//   … --include-bills                          also legacy dine-in bills paid online (below)
//
// ── Choosing --since (READ THIS) ─────────────────────────────────────────────────────────
// Every row written here lands in the restaurant's NEXT weekly settlement and is paid out —
// settlement sweeps up any unsettled row dated on or before the week it settles. So --since
// must be the go-live cut-off agreed with the business (the moment from which Yulo, not the
// old process, pays restaurants), normally the deploy time. An earlier date pays restaurants
// again for orders that may already have been settled with them some other way. The dry run
// prints the oldest and newest dates it would credit; check them before --apply.
//
// What it credits:
//   1. delivery/takeaway orders delivered in the window, paid online, with no order_earning row;
//   2. orders the customer cancelled after preparation started (no refund — the restaurant is
//      paid; services/refund.service.js), paid online, with no order_earning row;
//   3. with --include-bills: dine-in bills paid online in the window with no dine_in_earning row.
//      Off by default — bills paid before this release were settled outside the system.
// Simulated payments (razorpayPaymentId not starting with "pay_" — the old code fell back to
// them when no gateway was configured) are never credited: no money was collected.
//
// Which rates: an order with a frozen breakdown is settled under the Finance Settings version
// that priced it (charges.settingsVersionId); one without, under the version in force when it
// was placed — never simply today's rules. Finance Settings must already exist (run
// scripts/seedFinanceSettings.js first); this script never creates them.
//
// Legacy delivery fees: orders placed before the pricing engine (B3) have no frozen `charges`;
// their breakdown is rebuilt from the legacy rupee fields (settlementMath.service.js's
// chargesFromLegacyOrder). Their delivery fee was the RESTAURANT's own delivery.baseCharge, not
// Yulo's distance-based charge, so whose money it is is a business decision this script will
// not guess silently:
//   default (--legacy-delivery yulo)   it is treated as Yulo Money and kept out of the credit
//   --legacy-delivery restaurant       it stays in the restaurant's credit
//
// Safe to re-run: anything that already has its ledger row is skipped (and the ledger's unique
// indexes would refuse a duplicate anyway).

import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Bill from '../models/Bill.js';
import FinanceSettings from '../models/FinanceSettings.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import { recordOrderEarning } from '../services/ledger.service.js';
import { getActiveSettings } from '../services/financeSettings.service.js';
import { chargesFromLegacyOrder, computeRestaurantSettlementLine } from '../services/settlementMath.service.js';
import { toPaise } from '../utils/money.js';
import { recordMigrationRun } from './_migrationLog.js';
import { NO_SETTINGS_MESSAGE } from './_readSettings.js';

const REAL_PAYMENT = /^pay_/;
const ONLINE = [{ paymentChannel: 'online' }, { paymentChannel: null, paymentMethod: 'online' }];

// A rebuilt breakdown with the legacy delivery fee given to whoever --legacy-delivery says.
const legacyCharges = (order, legacyDeliveryTo) => {
  const charges = chargesFromLegacyOrder(order);
  return legacyDeliveryTo === 'restaurant' ? { ...charges, delivery: null } : charges;
};

// A bill paid before B3 has no frozen breakdown; settlement only needs what the guest paid and
// the platform fee in it (none, before B3).
const legacyBillCharges = (bill) => ({
  reconstructed: true,
  orderType: 'dine_in',
  platformFee: { total: toPaise(bill.platformFee ?? 0) },
  delivery: null,
  tip: 0,
  grandTotal: toPaise(bill.grandTotal ?? 0),
});

const withoutRow = async (docs, type, key) => {
  if (!docs.length) return [];
  const done = new Set(
    (await RestaurantLedgerEntry.find({ type, [key]: { $in: docs.map((d) => d._id) } }).select(key).lean()).map((e) =>
      String(e[key])
    )
  );
  return docs.filter((d) => !done.has(String(d._id)));
};

const span = (dates) => {
  const ts = dates.filter(Boolean).map((d) => new Date(d).getTime());
  if (!ts.length) return 'none';
  return `${new Date(Math.min(...ts)).toISOString()} → ${new Date(Math.max(...ts)).toISOString()}`;
};

/** The backfill itself, on an open connection. Exported for tests. */
export const backfillLedger = async ({
  since,
  until = new Date(),
  legacyDeliveryTo = 'yulo',
  includeBills = false,
  apply = false,
  log = console.log,
}) => {
  if (!(since instanceof Date) || Number.isNaN(since.getTime())) throw new Error('--since must be a date');
  if (!(until instanceof Date) || Number.isNaN(until.getTime()) || until < since) {
    throw new Error('--until must be a date on or after --since');
  }
  if (!['yulo', 'restaurant'].includes(legacyDeliveryTo)) throw new Error('--legacy-delivery must be yulo or restaurant');
  if ((await FinanceSettings.countDocuments()) === 0) {
    throw new Error(NO_SETTINGS_MESSAGE);
  }
  const window = { $gte: since, $lte: until };

  // 1. Delivered.
  const delivered = await withoutRow(
    await Order.find({
      type: { $in: ['delivery', 'takeaway'] },
      status: 'delivered',
      paymentStatus: 'paid',
      razorpayPaymentId: REAL_PAYMENT,
      $or: ONLINE,
      deliveredAt: window,
    }).lean(),
    'order_earning',
    'orderId'
  );
  // 2. Cancelled by the customer after preparation started (paid, no refund).
  const cancelled = await withoutRow(
    await Order.find({
      type: { $in: ['delivery', 'takeaway'] },
      status: 'cancelled',
      cancelledBy: 'customer',
      paymentStatus: 'paid',
      razorpayPaymentId: REAL_PAYMENT,
      $or: ONLINE,
      'refund.status': { $in: [null, 'none'] },
      refundStatus: { $ne: 'pending' },
      'statusHistory.status': { $in: ['preparing', 'ready'] },
      cancelledAt: window,
    }).lean(),
    'order_earning',
    'orderId'
  );
  // 3. Dine-in bills paid online (opt-in).
  const bills = includeBills
    ? await withoutRow(
        await Bill.find({
          type: 'dine_in',
          status: 'paid',
          razorpayPaymentId: REAL_PAYMENT,
          $or: [{ paymentChannel: 'online' }, { paymentChannel: null, paidBy: 'online' }],
          paidAt: window,
        })
          .select('+razorpayFee +razorpayTax')
          .lean(),
        'dine_in_earning',
        'billId'
      )
    : [];

  const simulated = await Order.countDocuments({
    status: { $in: ['delivered', 'cancelled'] },
    paymentStatus: 'paid',
    razorpayPaymentId: { $exists: true, $nin: [null], $not: REAL_PAYMENT },
    $or: [{ deliveredAt: window }, { cancelledAt: window }],
  });
  const legacy = [...delivered, ...cancelled].filter((o) => !o.charges);
  const legacyDelivery = legacy.filter((o) => (o.deliveryFee ?? 0) > 0);
  const legacyDeliveryTotal = legacyDelivery.reduce((sum, o) => sum + o.deliveryFee, 0);

  log(`window ${since.toISOString()} → ${until.toISOString()}`);
  log(`${delivered.length} delivered order(s) to credit — dated ${span(delivered.map((o) => o.deliveredAt))}`);
  log(`${cancelled.length} cancelled-after-preparation order(s) to credit — dated ${span(cancelled.map((o) => o.cancelledAt))}`);
  log(
    includeBills
      ? `${bills.length} dine-in bill(s) paid online to credit — dated ${span(bills.map((b) => b.paidAt))}`
      : 'dine-in bills: not included (pass --include-bills)'
  );
  log(`${legacy.length} order(s) priced from legacy fields (no frozen breakdown)`);
  log(
    `${legacyDelivery.length} legacy order(s) carry a delivery fee (₹${legacyDeliveryTotal.toFixed(2)}) — ` +
      `treated as ${legacyDeliveryTo === 'yulo' ? "Yulo's" : "the restaurant's"} money (--legacy-delivery)`
  );
  if (simulated) log(`${simulated} order(s) on a simulated payment skipped — no money was collected`);

  const counts = { delivered: 0, cancelled: 0, bills: 0 };
  if (!apply) return { ...counts, found: { delivered: delivered.length, cancelled: cancelled.length, bills: bills.length } };

  const credit = async (order, eligibleAt, note) =>
    recordOrderEarning(
      { ...order, paymentChannel: order.paymentChannel ?? 'online' },
      {
        eligibleAt,
        note,
        charges: order.charges ?? legacyCharges(order, legacyDeliveryTo),
        // Used only when the breakdown names no settings version (legacy orders).
        settingsAt: order.createdAt ?? eligibleAt,
      }
    );
  for (const o of delivered) if (await credit(o, o.deliveredAt, 'backfill')) counts.delivered += 1;
  for (const o of cancelled) {
    if (await credit(o, o.cancelledAt, 'backfill — cancelled by the customer after preparation started')) {
      counts.cancelled += 1;
    }
  }

  for (const bill of bills) {
    const charges = bill.charges ?? legacyBillCharges(bill);
    const versionId = charges.settingsVersionId;
    const settings =
      (versionId && mongoose.isValidObjectId(versionId) && (await FinanceSettings.findById(versionId).lean())) ||
      (await getActiveSettings(bill.paidAt ?? bill.createdAt));
    const line = computeRestaurantSettlementLine({
      charges,
      paymentChannel: 'online',
      razorpayFeePaise: bill.razorpayFee ?? 0,
      razorpayTaxPaise: bill.razorpayTax ?? 0,
      settings,
    });
    try {
      await RestaurantLedgerEntry.create({
        restaurantId: bill.restaurantId,
        type: 'dine_in_earning',
        direction: line.restaurantNet >= 0 ? 'credit' : 'debit',
        amountPaise: Math.abs(line.restaurantNet),
        billId: bill._id,
        breakdown: line,
        eligibleAt: bill.paidAt,
        note: 'backfill',
      });
      await Bill.updateOne({ _id: bill._id, financials: null }, { $set: { financials: line } });
      counts.bills += 1;
    } catch (err) {
      if (err?.code !== 11000) throw err; // already credited meanwhile
    }
  }

  log(`credited ${counts.delivered} delivered, ${counts.cancelled} cancelled-after-preparation, ${counts.bills} bill(s)`);
  return counts;
};

const argAfter = (flag) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : undefined);

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const apply = process.argv.includes('--apply');
  const since = argAfter('--since') ? new Date(argAfter('--since')) : null;
  const until = argAfter('--until') ? new Date(argAfter('--until')) : new Date();
  const legacyDeliveryTo = argAfter('--legacy-delivery') ?? 'yulo';
  const includeBills = process.argv.includes('--include-bills');
  if (!since || Number.isNaN(since.getTime())) {
    console.error(
      'Usage: node scripts/backfillLedger.js --since <go-live cut-off> [--until <date>] ' +
        '[--legacy-delivery yulo|restaurant] [--include-bills] [--apply]'
    );
    process.exitCode = 1;
  } else {
    mongoose
      .connect(process.env.MONGODB_URI)
      .then(async () => {
        console.log(`connected — ${apply ? 'APPLY mode' : 'dry run (pass --apply to write)'}`);
        const counts = await backfillLedger({ since, until, legacyDeliveryTo, includeBills, apply });
        if (apply && counts.delivered + counts.cancelled + counts.bills > 0) {
          await recordMigrationRun('backfillLedger', {
            since: since.toISOString(),
            until: until.toISOString(),
            legacyDeliveryTo,
            includeBills,
            ...counts,
          });
        }
      })
      .catch((err) => {
        console.error(err.message ?? err);
        process.exitCode = 1;
      })
      .finally(() => mongoose.disconnect());
  }
}
