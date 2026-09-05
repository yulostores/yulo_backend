import mongoose from 'mongoose';

const orderSelectedOptionSchema = new mongoose.Schema(
  { optionId: { type: mongoose.Schema.Types.ObjectId, required: true }, qty: { type: Number, default: 1 } },
  { _id: false }
);

const orderItemSchema = new mongoose.Schema(
  {
    menuItemId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true },
    price: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    note: { type: String, default: '' },
    // Snapshotted from Cart.items[].selectedOptions at checkout (Prompt 10) — without
    // this, an order's price reflects its customization but there'd be no record of
    // WHICH options were actually picked, and Prompt 13's reorder would have nothing to
    // re-seed a new cart with. Empty for the raw-items POST /api/orders path (which has
    // no option-groups concept) and for orders placed before this field existed.
    selectedOptions: [orderSelectedOptionSchema],
  },
  { _id: false }
);

const deliveryAssignmentHistorySchema = new mongoose.Schema(
  {
    partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryPartner' },
    assignedAt: { type: Date },
    assignedBy: { type: String, enum: ['auto', 'admin'] },
    unassignedAt: { type: Date },
    reason: { type: String },
  },
  { _id: false }
);

// Every status the order has passed through, with who moved it and when. The kitchen
// (chef KDS) and the waiter portal both drive transitions, so a single `status` field
// alone can't answer "who marked this served, and at what time" — which is exactly what
// the owner's per-order detail view needs. Appended to on every accepted transition in
// services/kitchen.service.js's updateOrderStatus; seeded with the 'placed' entry at
// creation time so the timeline is never missing its own first step.
const orderStatusHistorySchema = new mongoose.Schema(
  {
    status: { type: String, required: true },
    at: { type: Date, default: Date.now },
    byStaffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember', default: null },
    // Snapshotted, not just referenced — a staff member can later be renamed or soft
    // deleted (StaffMember.isActive:false), and the audit trail must still read correctly.
    byStaffName: { type: String, default: null },
    byRole: {
      type: String,
      enum: ['waiter', 'chef', 'owner', 'customer', 'guest', 'system'],
      default: 'system',
    },
  },
  { _id: false }
);

const orderSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    tableSessionId: { type: mongoose.Schema.Types.ObjectId, ref: 'TableSession', default: null },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'StaffMember', default: null },
    type: { type: String, enum: ['dine_in', 'delivery', 'takeaway'], required: true },
    // The table this order belongs to. tableNumber is the human-facing identifier
    // (Table.identifier, e.g. "T4") snapshotted at placement so the order still reads
    // correctly if the table is renamed or deleted; tableId is the stable reference used
    // for grouping orders by table. Both are set from the order's TableSession in
    // services/order.service.js — before that they were left null on every dine-in order,
    // which is why the owner portal could not say which table an order came from.
    tableNumber: { type: String, default: null },
    tableId: { type: mongoose.Schema.Types.ObjectId, ref: 'Table', default: null },
    // Who put the order in: a waiter on the floor (staffId is set), a guest scanning the
    // table QR with no account, or a signed-in customer. Distinct from staffId, which is
    // null for both guest and customer orders and so can't distinguish them on its own.
    placedBy: {
      type: String,
      enum: ['waiter', 'guest', 'customer', 'system'],
      default: 'customer',
    },
    batchNumber: { type: Number, default: 1 },
    items: { type: [orderItemSchema], required: true },
    subtotal: { type: Number, required: true },
    // Bill breakdown for delivery/checkout orders (services/order.service.js's
    // createOrderFromCart) — not part of the original prompt's field list, but without
    // these an order can't show what the customer actually paid beyond item subtotal, the
    // same way Bill.js separately holds gstAmount/serviceChargeAmount for dine-in. All
    // plain rupee numbers (not minor/paise units) — same convention as `subtotal` above
    // and every other price field in this codebase; see the naming note under
    // Public — Restaurants in API.md.
    deliveryFee: { type: Number, default: 0 },
    platformFee: { type: Number, default: 0 },
    tax: { type: Number, default: 0 },
    tip: { type: Number, default: 0 },
    appliedDiscountId: { type: mongoose.Schema.Types.ObjectId, ref: 'Discount', default: null },
    discountAmount: { type: Number, default: 0 },
    // Frozen at placement (subtotal + deliveryFee + platformFee + tax + tip - discountAmount)
    // — never recomputed later, same "never re-priced after the fact" convention as `items[].price`.
    grandTotal: { type: Number, default: null },
    // Free-text note "for the delivery partner" (screen 19) — distinct from
    // specialInstructions above, which is kitchen-facing prep notes; deliberately not the
    // same field, since the two have different audiences and this one flows to
    // buildOfferPayload (services/deliveryAssignment.service.js), not the kitchen.
    deliveryInstructions: { type: String, default: '' },
    // Simple restaurant-fulfillment toggles (screen 19's chip buttons) — flow to the
    // kitchen via notify.service.js's newOrder payload, not the delivery partner.
    cookingRequests: { type: Boolean, default: false },
    extraCutlery: { type: Boolean, default: false },
    // A customer-chosen, opt-in, per-order delivery-ASSIGNMENT preference — distinct from
    // User.preferences.vegModeEnabled (menu-content filtering) and
    // User.preferences.vegFleetPreferenceEnabled (just the default pre-fill for this
    // toggle at checkout). See services/deliveryAssignment.service.js's rankCandidates —
    // this is the "Order has no fleet concept of its own" placeholder finally being filled in.
    vegFleetOptIn: { type: Boolean, default: false },
    vegFleetAssignmentStatus: {
      type: String,
      enum: ['not_requested', 'searching', 'assigned', 'fallback_any_partner'],
      default: 'not_requested',
    },
    // Drives the screen 23 countdown ("Auto-defaults to keep waiting in 02:48") — extended
    // by POST .../veg-fleet/keep-waiting and the background sweep
    // (deliveryAssignment.service.js's sweepExpiredVegFleetSearches), both of which leave
    // vegFleetAssignmentStatus as 'searching' rather than relaxing it automatically.
    vegFleetSearchDeadline: { type: Date, default: null },
    // True for the entire lifetime of a vegFleetOptIn order, in BOTH 'searching' and
    // 'fallback_any_partner' states — screen 23's fallback copy still promises a
    // sanitised, unbatched bag even when the strict veg-fleet-partner search is relaxed.
    // No order-batching/pooling feature exists anywhere in this codebase yet (each
    // partner already handles exactly one active delivery assignment at a time by
    // default — see finance.config.js's maxConcurrentOrdersPerPartner), so there is
    // nothing to batch this order INTO regardless; this field just documents the intent
    // for whenever a batching feature is eventually built.
    dedicatedBagRequired: { type: Boolean, default: false },
    specialInstructions: { type: String, default: '' },
    // 'served' is the dine-in terminal state: the food actually reached the table. It sits
    // between 'ready' (kitchen is done, food is on the pass) and the bill being settled,
    // and is set by the waiter, not the kitchen — see the waiter status endpoint in
    // controllers/staff/waiter.controller.js. Delivery/takeaway orders never enter it;
    // they go 'ready' -> 'out_for_delivery' -> 'delivered' as before.
    status: {
      type: String,
      enum: ['placed', 'confirmed', 'preparing', 'ready', 'served', 'out_for_delivery', 'delivered', 'cancelled'],
      default: 'placed',
    },
    servedAt: { type: Date, default: null },
    statusHistory: { type: [orderStatusHistorySchema], default: [] },
    paymentStatus: {
      type: String,
      // 'pending_cod' is distinct from 'pending' — set by checkout (Prompt 10/11) for
      // paymentMethod:'cash' orders so it reads as "cash to be collected on delivery"
      // rather than "payment attempt in progress" (what 'pending' means for an online
      // order awaiting Razorpay verification/webhook). Existing non-checkout paths
      // (dine-in, the raw-items POST /api/orders) are unaffected — they still default to
      // plain 'pending', unchanged.
      enum: ['pending', 'pending_cod', 'paid', 'failed', 'refunded'],
      default: 'pending',
    },
    paymentMethod: { type: String, enum: ['cash', 'upi', 'card', 'online'], default: null },
    // Razorpay order id (created up front, before payment) — set when the Razorpay order
    // is created (controllers/order.controller.js's createRazorpayOrderIfNeeded), read
    // back by POST /api/orders/:id/payment/verify and the webhook to confirm a payment
    // actually belongs to this order before trusting its signature.
    paymentIntentId: { type: String, default: null },
    // The actual captured payment's own id — a distinct Razorpay identifier from the
    // order id above, set once payment succeeds (verify endpoint or webhook). Kept
    // separate rather than overwriting paymentIntentId, since a real refund flow would
    // need this payment-level id, not the order-level one.
    razorpayPaymentId: { type: String, default: null },
    deliveryAddress: {
      street: { type: String },
      city: { type: String },
      coordinates: { type: [Number], default: null },
    },
    estimatedDeliveryTime: { type: Date },
    deliveredAt: { type: Date, default: null },
    deliveryAssignment: {
      partnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryPartner', default: null },
      // Set only once a partner ACCEPTS an offer — stays 'unassigned' while an offer is
      // outstanding (offerStatus below tracks that in-flight state instead).
      status: {
        type: String,
        enum: ['unassigned', 'assigned', 'picked_up', 'delivered', 'failed'],
        default: 'unassigned',
      },
      assignedAt: { type: Date },
      assignedBy: { type: String, enum: ['auto', 'admin'] },
      // Pending-offer state (see services/deliveryAssignment.service.js) — a candidate is
      // "offered" the order in real time over Socket.IO and has offerExpiresAt to accept/reject
      // before it's treated as missed and re-offered to the next candidate.
      offeredTo: { type: mongoose.Schema.Types.ObjectId, ref: 'DeliveryPartner', default: null },
      offerExpiresAt: { type: Date, default: null },
      offerStatus: {
        type: String,
        enum: ['none', 'offered', 'accepted', 'rejected', 'expired'],
        default: 'none',
      },
      // Generated on accept (controllers/partner/order.controller.js). No SMS/push channel
      // exists in this codebase (notify.service.js is Socket.IO-only) — the customer's only
      // current way to see it is the customer-facing GET /api/orders/:id response, see the
      // comment on getOrder in controllers/order.controller.js.
      pickupOtp: { type: String, default: null },
      pickupOtpVerifiedAt: { type: Date, default: null },
      // Self-reported at delivery time (CodCollection.jsx has no real payment-gateway/QR
      // verification today) — codDiscrepancy is set instead of hard-failing the delivery when
      // it doesn't match `subtotal`; see the comment on deliverOrder for why.
      codCollected: { type: Number, default: null },
      codDiscrepancy: { type: Number, default: null },
      // Computed and frozen once at delivery time (controllers/partner/order.controller.js's
      // deliverOrder) — never recomputed afterward, so a partner's historical earnings don't
      // shift if rates change later. distanceKm is the actual haversine figure used for
      // distancePay, stored alongside it so the frozen breakdown is self-consistent rather than
      // relying on recomputing the same number again later. surgePay/tip/penalty are always 0
      // today — no surge-pricing engine, tipping mechanism, or penalty-rules engine exists
      // anywhere in this codebase; see services/earnings.service.js for the full picture of
      // which of these components are real (funded, reconciled with admin payouts) vs
      // informational placeholders.
      earningsBreakdown: {
        basePay: { type: Number, default: 0 },
        distanceKm: { type: Number, default: null },
        distancePay: { type: Number, default: 0 },
        surgePay: { type: Number, default: 0 },
        tip: { type: Number, default: 0 },
        penalty: { type: Number, default: 0 },
      },
      history: [deliveryAssignmentHistorySchema],
    },
  },
  { timestamps: true }
);

orderSchema.index({ 'deliveryAssignment.partnerId': 1, 'deliveryAssignment.status': 1 });

orderSchema.index({ restaurantId: 1, createdAt: -1 });
orderSchema.index({ tableSessionId: 1 });
orderSchema.index({ restaurantId: 1, tableId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ status: 1, restaurantId: 1 });
orderSchema.index({ paymentIntentId: 1 }, { sparse: true });

export default mongoose.model('Order', orderSchema);
