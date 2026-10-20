// What each order or bill means for the restaurant's settlement, and what the rider earns —
// pure arithmetic over a frozen price breakdown (services/charges.service.js) and the active
// Finance Settings. No database, no clock: services/ledger.service.js decides WHEN a line is
// written; this decides WHAT it says. Integer paise throughout (utils/money.js).
//
// Rules (PAYMENT_IMPLEMENTATION_PROMPTS.md § Business rules):
//   online (Pay Now)  the customer paid Yulo. Yulo keeps its own money — the platform fee and
//                     the delivery charge the customer paid ("Yulo Money") — plus the
//                     settlement charge (settlementChargePercent, GST-inclusive) taken on the
//                     amount the customer paid. When delivery was free to the customer, the
//                     restaurant bears that delivery charge. The rest is the restaurant's.
//   counter           the guest paid the restaurant directly (cash/UPI/card at the table).
//                     Yulo received nothing, so the restaurant OWES the platform fee plus the
//                     settlement charge on that fee — a negative line.
//   tips              100 % the rider's. Never part of the restaurant's money and never part of
//                     the base the settlement charge is taken on.

import { percentOf, splitInclusiveGst, toPaise } from '../utils/money.js';

/**
 * @param {object} args
 * @param {object} args.charges           frozen computeCustomerCharges() breakdown
 * @param {'online'|'counter'} args.paymentChannel
 * @param {number} [args.razorpayFeePaise=0]  Razorpay's `fee` on the payment (includes its GST)
 * @param {number} [args.razorpayTaxPaise=0]  Razorpay's `tax` — the GST inside that fee
 * @param {number} [args.riderPayPaise=0]     rider's base + distance pay (Yulo pays it from the
 *                                            delivery charge; shown to admin only)
 * @param {object} args.settings          active Finance Settings
 */
export const computeRestaurantSettlementLine = ({
  charges,
  paymentChannel,
  razorpayFeePaise = 0,
  razorpayTaxPaise = 0,
  riderPayPaise = 0,
  settings,
}) => {
  if (!charges) throw new TypeError('charges breakdown is required');
  if (paymentChannel !== 'online' && paymentChannel !== 'counter') {
    throw new TypeError(`paymentChannel must be 'online' or 'counter', got ${paymentChannel}`);
  }

  const tip = charges.tip ?? 0;
  const platformFee = charges.platformFee?.total ?? 0;
  const customerDelivery = charges.delivery?.customerPays ?? 0;
  const restaurantBorneDelivery = charges.delivery?.paidBy === 'restaurant' ? charges.delivery.total : 0;

  const placeholders = { planCharge: 0, adCharge: 0, penalty: 0 };

  if (paymentChannel === 'counter') {
    // Only the platform fee is Yulo's to collect; the settlement charge applies to it.
    const settlementTotal = percentOf(platformFee, settings.settlementChargePercent);
    const split = splitInclusiveGst(settlementTotal, settings.serviceGstPercent);
    return {
      paymentChannel,
      customerPaid: 0,
      yuloMoney: { platformFee, deliveryCharge: 0 },
      settlementCharge: { base: split.base, gst: split.gst, total: settlementTotal, percent: settings.settlementChargePercent },
      restaurantBorneDelivery: 0,
      ...placeholders,
      restaurantNet: -(platformFee + settlementTotal),
      gateway: { fee: 0, tax: 0, total: 0 },
      yuloSettlementMargin: settlementTotal,
      riderPay: 0,
      tip: 0,
      settingsVersionId: settings._id != null ? String(settings._id) : null,
    };
  }

  const customerPaid = charges.grandTotal;
  const paidExcludingTip = customerPaid - tip;
  // 'restaurant_share': only the part of the payment that is the restaurant's (food, its GST,
  // service charge, round-off) — not Yulo's own fees.
  const chargeBase =
    settings.settlementChargeBase === 'restaurant_share'
      ? paidExcludingTip - platformFee - customerDelivery
      : paidExcludingTip;
  const settlementTotal = percentOf(chargeBase, settings.settlementChargePercent);
  const split = splitInclusiveGst(settlementTotal, settings.serviceGstPercent);

  const restaurantNet =
    paidExcludingTip - platformFee - customerDelivery - restaurantBorneDelivery - settlementTotal;

  return {
    paymentChannel,
    customerPaid,
    yuloMoney: { platformFee, deliveryCharge: customerDelivery },
    settlementCharge: { base: split.base, gst: split.gst, total: settlementTotal, percent: settings.settlementChargePercent },
    restaurantBorneDelivery,
    ...placeholders,
    restaurantNet,
    // Razorpay's `fee` already includes its GST (`tax`).
    gateway: { fee: razorpayFeePaise - razorpayTaxPaise, tax: razorpayTaxPaise, total: razorpayFeePaise },
    yuloSettlementMargin: settlementTotal - razorpayFeePaise,
    riderPay: riderPayPaise,
    tip,
    settingsVersionId: settings._id != null ? String(settings._id) : null,
  };
};

/**
 * Rider pay for one delivery: riderBasePay covers the first riderBaseKm km of the
 * restaurant → customer distance; every km beyond earns riderPerKmRate. The tip is the
 * rider's in full, on top. distanceKm null (an unmeasurable drop) earns the base only.
 * Returns paise.
 */
export const computeRiderPay = ({ distanceKm, tipPaise = 0, settings }) => {
  const extraKm = distanceKm == null ? 0 : Math.max(0, distanceKm - settings.riderBaseKm);
  // Rounded to 3 decimals first so 3.4 − 2 = 1.4, not 1.3999999999999999.
  const distancePay = Math.round(settings.riderPerKmRate * Number(extraKm.toFixed(3)));
  return {
    basePay: settings.riderBasePay,
    distanceKm,
    extraKm: Number(extraKm.toFixed(3)),
    distancePay,
    tip: tipPaise,
    total: settings.riderBasePay + distancePay + tipPaise,
  };
};

/**
 * A price breakdown rebuilt from an order's legacy rupee fields, for orders placed before
 * the pricing engine froze one (scripts/backfillLedger.js). Only the fields settlement reads
 * are reconstructed; the delivery fee is treated as customer-paid (pre-B3 orders never
 * recorded a restaurant-borne charge).
 */
export const chargesFromLegacyOrder = (order) => {
  const subtotal = toPaise(order.subtotal ?? 0);
  const discount = toPaise(order.discountAmount ?? 0);
  const tax = toPaise(order.tax ?? 0);
  const deliveryFee = toPaise(order.deliveryFee ?? 0);
  const platformFee = toPaise(order.platformFee ?? 0);
  const tip = toPaise(order.tip ?? 0);
  const computed = subtotal - discount + tax + deliveryFee + platformFee + tip;
  const grandTotal = order.grandTotal != null ? toPaise(order.grandTotal) : computed;
  return {
    reconstructed: true,
    orderType: order.type,
    food: { subtotal, discount, base: subtotal - discount, gst: tax, total: subtotal - discount + tax },
    delivery: order.type === 'delivery'
      ? { base: deliveryFee, gst: 0, total: deliveryFee, paidBy: 'customer', customerPays: deliveryFee }
      : null,
    platformFee: { count: platformFee > 0 ? 1 : 0, base: platformFee, gst: 0, total: platformFee },
    tip,
    roundOff: grandTotal - computed,
    grandTotal,
  };
};
