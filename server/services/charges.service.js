// What the customer pays — the one pricing engine behind every price a customer is shown or
// charged: the cart preview, the checkout summary, the order frozen at placement, and the
// dine-in bill. Rules: PAYMENT_IMPLEMENTATION_PROMPTS.md § Business rules; rates: Finance
// Settings (services/financeSettings.service.js).
//
// computeCustomerCharges is pure — no database, no clock, no settings lookup of its own. The
// caller passes the active settings and the facts (food amount, distance, the restaurant's
// GST registration and free-delivery threshold), so the same inputs always price the same,
// and an order can be re-explained later from its frozen inputs.
//
// Everything is integer PAISE (utils/money.js). toLegacyTotals converts back to the rupee
// fields existing screens read (subtotal/deliveryFee/platformFee/tax/tip/grandTotal).
//
//   food       GST-EXCLUSIVE menu price; food GST added on top at foodGstPercent — only for a
//              GST-registered restaurant. Taxed on what is actually charged for the food:
//              after item markdowns AND after any discount (the discount reduces the food's
//              taxable value; it never reduces fees).
//   delivery   deliveryPerKmRate × distance (rounded UP to deliveryDistanceRounding km),
//              floored at deliveryMinCharge, + serviceGstPercent GST. When the order meets the
//              restaurant's free-delivery threshold the customer pays nothing and the
//              restaurant bears the full charge (paidBy: 'restaurant'). Dine-in and takeaway
//              have none.
//   platform   customerPlatformFee, already GST-inclusive; split only to show the GST in it.
//   tip        passed through untouched; 100 % to the rider.
//   round-off  the payable total is rounded to the nearest rupee; the difference is a line.

import { percentOf, splitInclusiveGst, roundToRupee, toPaise, toRupees } from '../utils/money.js';
import { haversineKm } from './geo.service.js';
import { effectiveDeliveryRadiusKm } from '../config/delivery.config.js';
import { ApiError } from '../utils/ApiError.js';

// The most a customer may tip on one order (₹500). Guards against a typo or a tampered client
// turning a ₹300 order into a ₹30,300 charge; well above the presets (config/finance.config.js).
export const MAX_TIP_PAISE = 50_000;

const rupeeText = (paise) => `₹${(paise / 100).toFixed(2)}`;

const isUsablePair = (c) => Array.isArray(c) && c.length === 2 && c.every(Number.isFinite);

// Rounds a distance UP to the next multiple of `step` km (3.14 km at 0.1 → 3.2 km). The
// toFixed guards against 3.2 / 0.1 = 32.000000000000004 ceiling to 33.
const roundUpKm = (km, step) => {
  const units = Math.ceil(Number((km / step).toFixed(9)));
  return Number((units * step).toFixed(3));
};

/**
 * How far the food travels, and whether this restaurant will take it there.
 * Returns { distanceKm, issue } — distanceKm is the raw straight-line figure (null when it
 * can't be measured); issue is null, 'ADDRESS_NOT_LOCATED', 'RESTAURANT_NOT_LOCATED' or
 * 'OUT_OF_DELIVERY_RANGE'. Callers decide whether an issue blocks (checkout) or is only
 * reported (cart preview, checkout summary).
 */
export const resolveDeliveryDistance = (restaurant, dropCoordinates) => {
  if (!isUsablePair(dropCoordinates)) return { distanceKm: null, issue: 'ADDRESS_NOT_LOCATED' };
  const origin = restaurant?.location?.coordinates;
  if (!isUsablePair(origin)) return { distanceKm: null, issue: 'RESTAURANT_NOT_LOCATED' };

  const distanceKm = haversineKm(origin, dropCoordinates);
  if (distanceKm > effectiveDeliveryRadiusKm(restaurant.delivery)) {
    return { distanceKm, issue: 'OUT_OF_DELIVERY_RANGE' };
  }
  return { distanceKm, issue: null };
};

// Customer-facing wording for each issue, used by the API errors and summaries alike.
export const DELIVERY_ISSUE_MESSAGES = {
  ADDRESS_NOT_LOCATED: 'We could not place this address on the map — please pick the location on the map again',
  RESTAURANT_NOT_LOCATED: 'This restaurant cannot take delivery orders right now',
  OUT_OF_DELIVERY_RANGE: 'This restaurant does not deliver to this address',
};

/**
 * @param {object}  args
 * @param {'delivery'|'takeaway'|'dine_in'} args.orderType
 * @param {number}  args.foodSubtotalPaise   food at menu prices after item markdowns, before discount
 * @param {number}  [args.discountPaise=0]   order/bill discount, taken off the food
 * @param {object}  args.restaurant          needs gstRegistered and delivery.freeThreshold (rupees)
 * @param {number|null} [args.distanceKm]    delivery only; null = not known yet (preview)
 * @param {number}  [args.tipPaise=0]
 * @param {number}  [args.serviceChargePaise=0]  dine-in service charge, restaurant income, no GST added here
 * @param {number}  [args.platformFeeCount=1]    how many platform fees apply (dine-in per-order unit; 0 for an empty bill)
 * @param {object}  args.settings            active Finance Settings
 */
export const computeCustomerCharges = ({
  orderType,
  foodSubtotalPaise,
  discountPaise = 0,
  restaurant,
  distanceKm = null,
  tipPaise = 0,
  serviceChargePaise = 0,
  platformFeeCount = 1,
  settings,
}) => {
  for (const [name, value] of Object.entries({ foodSubtotalPaise, discountPaise, tipPaise, serviceChargePaise })) {
    if (!Number.isInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative integer (paise)`);
  }
  if (tipPaise > MAX_TIP_PAISE) {
    throw new ApiError(400, 'TIP_TOO_HIGH', `A tip can be at most ${rupeeText(MAX_TIP_PAISE)}`);
  }

  // ── Food ────────────────────────────────────────────────────────────────────
  const discount = Math.min(discountPaise, foodSubtotalPaise);
  const foodBase = foodSubtotalPaise - discount;
  const foodGstPercent = restaurant?.gstRegistered ? settings.foodGstPercent : 0;
  const foodGst = percentOf(foodBase, foodGstPercent);
  const food = {
    subtotal: foodSubtotalPaise,
    discount,
    base: foodBase,
    gstPercent: foodGstPercent,
    gst: foodGst,
    total: foodBase + foodGst,
  };

  // ── Delivery ────────────────────────────────────────────────────────────────
  let delivery = null;
  if (orderType === 'delivery') {
    if (distanceKm == null) {
      // Preview without a measurable address: shown as "calculated at checkout", left out of
      // the total. Checkout itself never prices an order in this state.
      delivery = { pending: true, distanceKm: null, base: 0, gst: 0, total: 0, paidBy: 'customer', customerPays: 0 };
    } else {
      const chargedKm = roundUpKm(distanceKm, settings.deliveryDistanceRounding);
      const base = Math.max(settings.deliveryMinCharge, Math.round(settings.deliveryPerKmRate * chargedKm));
      const gst = percentOf(base, settings.serviceGstPercent);
      const freeThreshold = restaurant?.delivery?.freeThreshold;
      // Compared against the food at menu prices (before the discount), as the threshold has
      // always been — "free delivery above ₹X" is about the size of the order.
      const isFree = freeThreshold != null && foodSubtotalPaise >= toPaise(Number(freeThreshold));
      delivery = {
        pending: false,
        distanceKm: chargedKm,
        base,
        gst,
        total: base + gst,
        paidBy: isFree ? 'restaurant' : 'customer',
        customerPays: isFree ? 0 : base + gst,
      };
    }
  }

  // ── Platform fee (GST-inclusive) ────────────────────────────────────────────
  const perFee = splitInclusiveGst(settings.customerPlatformFee, settings.serviceGstPercent);
  const count = Math.max(0, Math.trunc(platformFeeCount));
  const platformFee = {
    count,
    base: perFee.base * count,
    gst: perFee.gst * count,
    total: settings.customerPlatformFee * count,
  };

  // ── Total ───────────────────────────────────────────────────────────────────
  const subtotalBeforeRoundOff =
    food.total + (delivery?.customerPays ?? 0) + serviceChargePaise + platformFee.total + tipPaise;
  const { rounded: grandTotal, roundOff } = roundToRupee(subtotalBeforeRoundOff);

  // ── Display lines (in the order a bill reads) ───────────────────────────────
  const lines = [{ key: 'item_total', label: 'Item total', amountPaise: food.subtotal, sublabel: null }];
  if (discount > 0) {
    lines.push({ key: 'discount', label: 'Discount', amountPaise: -discount, sublabel: null });
  }
  if (foodGst > 0) {
    lines.push({
      key: 'food_gst',
      label: 'GST on food',
      amountPaise: foodGst,
      sublabel: `${foodGstPercent}% of ${rupeeText(foodBase)}`,
    });
  }
  if (delivery) {
    let sublabel;
    if (delivery.pending) sublabel = 'Calculated at checkout';
    else if (delivery.paidBy === 'restaurant') sublabel = 'Free delivery';
    else sublabel = `${delivery.distanceKm} km · incl. ${rupeeText(delivery.gst)} GST`;
    lines.push({
      key: 'delivery_fee',
      label: 'Delivery fee',
      amountPaise: delivery.pending ? null : delivery.customerPays,
      sublabel,
    });
  }
  if (serviceChargePaise > 0) {
    lines.push({ key: 'service_charge', label: 'Service charge', amountPaise: serviceChargePaise, sublabel: null });
  }
  if (platformFee.total > 0) {
    lines.push({
      key: 'platform_fee',
      label: 'Platform fee',
      amountPaise: platformFee.total,
      sublabel: `incl. ${rupeeText(platformFee.gst)} GST`,
    });
  }
  if (tipPaise > 0) {
    lines.push({ key: 'tip', label: 'Delivery partner tip', amountPaise: tipPaise, sublabel: null });
  }
  if (roundOff !== 0) {
    lines.push({ key: 'round_off', label: 'Round off', amountPaise: roundOff, sublabel: null });
  }
  lines.push({ key: 'grand_total', label: 'To pay', amountPaise: grandTotal, sublabel: null });

  return {
    orderType,
    food,
    delivery,
    serviceCharge: serviceChargePaise,
    platformFee,
    tip: tipPaise,
    subtotalBeforeRoundOff,
    roundOff,
    grandTotal,
    // A string, so the frozen snapshot is plain JSON wherever it is stored or sent.
    settingsVersionId: settings._id != null ? String(settings._id) : null,
    settingsVersion: settings.version ?? null,
    lines,
  };
};

/**
 * The rupee fields existing screens and models read, from a charges breakdown. `tax` is the
 * food GST only (the delivery charge and platform fee are GST-inclusive figures already),
 * `deliveryFee` what the CUSTOMER pays for delivery, `subtotal` the food before discount.
 * subtotal + deliveryFee + platformFee + tax + tip − discountAmount + roundOff = grandTotal.
 */
export const toLegacyTotals = (charges) => ({
  subtotal: toRupees(charges.food.subtotal),
  deliveryFee: toRupees(charges.delivery?.customerPays ?? 0),
  platformFee: toRupees(charges.platformFee.total),
  tax: toRupees(charges.food.gst),
  tip: toRupees(charges.tip),
  discountAmount: toRupees(charges.food.discount),
  grandTotal: toRupees(charges.grandTotal),
});
