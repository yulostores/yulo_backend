import mongoose from 'mongoose';
import { refundSchema } from './refundSchema.js';

const batchItemSchema = new mongoose.Schema(
  {
    // Kept alongside the name so a bill line can be traced back to the live menu item
    // (re-order, dispute, item-level reporting) without string-matching on the name.
    menuItemId: { type: mongoose.Schema.Types.ObjectId },
    name: { type: String },
    quantity: { type: Number },
    price: { type: Number },
    lineTotal: { type: Number },
    // The guest's own note on that line ("no onion"), snapshotted from Order.items[].note.
    // A guest checking their bill has to be able to see what they asked for.
    note: { type: String, default: '' },
  },
  { _id: false }
);

const batchSchema = new mongoose.Schema(
  {
    batchNumber: { type: Number },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' },
    items: [batchItemSchema],
    batchTotal: { type: Number },
    placedAt: { type: Date },
    // The round's own lifecycle, snapshotted so the bill's "order history" panel can say
    // what happened to each round (including one that was cancelled and therefore does
    // not contribute to the total) without a second round-trip per order.
    status: { type: String },
    placedBy: { type: String },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember' },
    staffName: { type: String },
  },
  { _id: false }
);

const discountAppliedSchema = new mongoose.Schema(
  {
    discountId: { type: mongoose.Schema.Types.ObjectId },
    code: { type: String },
    description: { type: String },
    amount: { type: Number },
  },
  { _id: false }
);

// The issuing restaurant's own details, frozen onto the bill at issue time. A bill is a
// receipt: it has to keep reading correctly years later even if the restaurant is renamed,
// moves, re-registers under a different GSTIN, or is removed from the platform entirely.
// Live values come from Restaurant/Restaurant.settings; this is only ever a copy.
const restaurantSnapshotSchema = new mongoose.Schema(
  {
    name: { type: String },
    legalName: { type: String },
    logo: { type: String },
    phone: { type: String },
    email: { type: String },
    gstNumber: { type: String },
    panNumber: { type: String },
    fssaiNumber: { type: String },
    address: {
      street: { type: String },
      city: { type: String },
      state: { type: String },
      pincode: { type: String },
    },
  },
  { _id: false }
);

const billSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    // Human receipt number, unique per restaurant and running in issue order
    // (`INV-000001`). Assigned once, at creation, from the Counter collection — never
    // recomputed, so a settled bill's number is stable forever. Sparse-unique because
    // bills created before this field existed have none until the backfill script runs
    // (scripts/backfillBillDetails.js).
    billNumber: { type: String, default: null },
    tableSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'TableSession', default: null },
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null },
    // Which fulfilment this bill covers. Dine-in bills batch a whole table sitting;
    // delivery/takeaway bills wrap exactly one order (see billing.service.createOrderBill).
    type: { type: String, enum: ['dine_in', 'delivery', 'takeaway'], default: 'dine_in' },

    // ── Where the guest was sitting ────────────────────────────────────────────────
    // tableNumber is the human identifier (Table.identifier, e.g. "T4") snapshotted at
    // issue time so a renamed or deleted table doesn't erase it from the receipt;
    // tableId stays as the stable reference. Both null for delivery/takeaway.
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', default: null },
    tableNumber: { type: String, default: null },

    // ── Who the bill is for, and who served it ─────────────────────────────────────
    guestCount: { type: Number, default: null },
    guestPhone: { type: String, default: null },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    customerName: { type: String, default: null },
    customerPhone: { type: String, default: null },
    waiterId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember', default: null },
    waiterName: { type: String, default: null },
    // Where a delivery bill's food actually went — the delivery equivalent of tableNumber.
    deliveryAddress: {
      street: { type: String },
      city: { type: String },
    },

    // ── When the sitting ran ───────────────────────────────────────────────────────
    openedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },

    restaurantSnapshot: { type: restaurantSnapshotSchema, default: null },

    batches: [batchSchema],

    // ── Money ──────────────────────────────────────────────────────────────────────
    subtotal: { type: Number, required: true },
    gstPercent: { type: Number },
    gstAmount: { type: Number },
    serviceChargePercent: { type: Number },
    serviceChargeAmount: { type: Number },
    // Present on delivery/takeaway bills, mirrored from the order's frozen figures so the
    // bill total equals what the customer was actually charged at checkout. Always 0 for
    // dine-in, which has neither.
    deliveryFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    tip: { type: Number, default: 0 },
    discountsApplied: [discountAppliedSchema],
    // Sum of discountsApplied[].amount, stored rather than re-derived on every read so
    // the persisted document is self-consistent and aggregations don't need $unwind.
    discountTotal: { type: Number, default: 0 },
    grandTotal: { type: Number, required: true },
    // The engine's breakdown in PAISE (services/charges.service.js) behind the rupee totals
    // above: for a dine-in bill, recomputed on every re-assemble while open and frozen once
    // paid; for a delivery/takeaway bill, copied from its order. Exposed by billView as
    // `chargeBreakdown` (that payload's `charges` key is the older rupee summary).
    charges: { type: mongoose.Schema.Types.Mixed, default: null },
    // The bill's settlement line, frozen when it was paid (services/ledger.service.js) — same
    // meaning as Order.financials.
    financials: { type: mongoose.Schema.Types.Mixed, default: null, select: false },

    status: { type: String, enum: ['open', 'paid', 'cancelled'], default: 'open' },
    paidAt: { type: Date },
    paidBy: { type: String, enum: ['cash', 'upi', 'card', 'online'] },
    // Razorpay order id — set when a guest starts paying this bill online (see
    // controllers/publicBill.controller.js), read back by the verify endpoint and the
    // webhook to confirm a submitted payment actually belongs to this bill.
    paymentIntentId: { type: String, default: null },
    // The actual captured payment's own id, distinct from the order id above — set once
    // payment succeeds, same split as Order.razorpayPaymentId/paymentIntentId.
    razorpayPaymentId: { type: String, default: null },
    // Same meaning as on Order: 'online' = guest paid through Razorpay (money reaches Yulo),
    // 'counter' = settled with the restaurant directly (cash/UPI/card marked by staff).
    // Set by billing.service.js's markPaid; null while the bill is open.
    paymentChannel: { type: String, enum: ['online', 'counter', 'cod', null], default: null },
    // Same three as on Order — see the comments there.
    paymentAmountPaise: { type: Number, default: null },
    // Every Razorpay order id ever created for this payment, oldest first — a retry
    // (POST …/payment/retry) can replace paymentIntentId with a fresh one, and a payment that
    // completes late against an earlier one must still be recognised as this one's.
    paymentIntentHistory: { type: [String], default: [] },
    // When the guest last started (or resumed) paying online — the bill is held at its total
    // while they pay (billing.service.js assembleBill), and released if they abandon it.
    paymentStartedAt: { type: Date, default: null },
    // How the payment was confirmed: the app's own verify call, Razorpay's webhook, or dev
    // simulation. Lets an app that lost its verify response see that a webhook settled it.
    paymentConfirmedVia: { type: String, enum: ['verify', 'webhook', 'simulation', null], default: null },
    // select: false (with razorpayTax and financials) — platform-internal money: Razorpay's
    // cut and Yulo's margin. Never returned by any query unless the code asks for it
    // (.select('+razorpayFee …')); only the ledger, refund and admin-breakdown code does.
    razorpayFee: { type: Number, default: null, select: false },
    razorpayTax: { type: Number, default: null, select: false },
    // A Razorpay payment we refused to settle the bill with (wrong amount/currency/order).
    paymentFailureReason: { type: String, default: null },
    // Set to 'pending' when money was captured against this bill but we could not accept it
    // as payment — someone has to return it. Refund integration arrives in B5.
    refundStatus: { type: String, enum: ['none', 'pending', 'refunded'], default: 'none' },
    // Same as Order.refund — see models/refundSchema.js.
    refund: { type: refundSchema, default: () => ({}) },
  },
  { timestamps: true }
);

billSchema.index({ tableSessionId: 1 });
billSchema.index({ paymentIntentHistory: 1 });
// Refund webhooks and the "already owed back?" checks look bills up by payment.
billSchema.index({ razorpayPaymentId: 1 }, { partialFilterExpression: { razorpayPaymentId: { $type: 'string' } } });
billSchema.index({ restaurantId: 1, status: 1, createdAt: -1 });
// Partial, not sparse: a compound sparse index still indexes a document whose FIRST key
// is present, so every not-yet-numbered bill would collide on `billNumber: null`. The
// partial filter excludes them outright and enforces uniqueness only over real numbers.
billSchema.index(
  { restaurantId: 1, billNumber: 1 },
  { unique: true, partialFilterExpression: { billNumber: { $type: 'string' } } }
);
billSchema.index({ restaurantId: 1, tableId: 1, createdAt: -1 });
// Partial for the same reason as above — `orderId` defaults to null on every dine-in
// bill, so a plain (or sparse) index would carry the whole collection to serve a lookup
// only delivery/takeaway bills ever make.
billSchema.index({ orderId: 1 }, { partialFilterExpression: { orderId: { $type: 'objectId' } } });

export default mongoose.model('Bill', billSchema);
