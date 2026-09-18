import { env } from './env.js';

export const commissionPercent = env.PLATFORM_COMMISSION_PERCENT;
export const perDeliveryRate = env.DELIVERY_PARTNER_PER_DELIVERY_RATE;
export const maxConcurrentOrdersPerPartner = env.DELIVERY_PARTNER_MAX_CONCURRENT_ORDERS;
// How long a partner has to accept/reject a pushed order offer before it's treated as missed
// and re-offered to the next candidate — matches the Delivery-Partner app's ~18-22s countdown
// (see Delivery-Partner/src/mocks/fixtures.js's mockOrders.countdownSeconds).
export const offerWindowSeconds = env.DELIVERY_OFFER_WINDOW_SECONDS;
// Placeholder distance-based rate for the itemized earnings breakdown (services/earnings.service.js) —
// no real geo/routing capability exists yet (services/geo.service.js is still an intentionally
// empty file), so this multiplies whatever real dropKm figure
// services/deliveryAssignment.service.js's computeDropKm can derive from actual restaurant/
// delivery-address coordinates (0 when unknown — never fabricated). This is NOT an admin-approved
// payout commitment the way perDeliveryRate is; see the comment on earnings.service.js for why it
// deliberately stays out of payout.service.js's real netPayable calculation.
export const perKmRate = env.DELIVERY_PARTNER_PER_KM_RATE;

export const computeCommission = (grossRevenue) => grossRevenue * (commissionPercent / 100);

// Cart bill computation (services/cart.service.js) — simple flat/percentage constants,
// not a per-restaurant or per-order-value rules engine. deliveryFee itself isn't here —
// it comes from each restaurant's own Restaurant.delivery config (baseCharge/freeThreshold),
// same as the rest of this codebase's per-restaurant settings.
export const cartPlatformFee = env.CART_PLATFORM_FEE;
export const cartTaxPercent = env.CART_TAX_PERCENT;

// Suggested delivery-tip amounts (rupees) shown on the checkout page. A plain constant,
// not env-sourced, the same way config/appConfig.config.js's PAYMENT_GROUPS/PAYMENT_METHODS
// are — platform-wide UI config that belongs in a file, not typed into the app.
export const tipPresets = [10, 20, 30, 50];
