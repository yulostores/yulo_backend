import { env } from './env.js';

// Dispatch tuning that is operational, not financial. Every money rate that used to live
// here (commission, rider per-delivery/per-km pay, cart platform fee and tax) moved to Finance
// Settings — read them with services/financeSettings.service.js's getActiveSettings().

export const maxConcurrentOrdersPerPartner = env.DELIVERY_PARTNER_MAX_CONCURRENT_ORDERS;
// How long a partner has to accept/reject a pushed order offer before it's treated as missed
// and re-offered to the next candidate — matches the Delivery-Partner app's ~18-22s countdown
// (see Delivery-Partner/src/mocks/fixtures.js's mockOrders.countdownSeconds).
export const offerWindowSeconds = env.DELIVERY_OFFER_WINDOW_SECONDS;

// Suggested delivery-tip amounts (rupees) shown on the checkout page. A plain constant,
// not env-sourced, the same way config/appConfig.config.js's PAYMENT_GROUPS/PAYMENT_METHODS
// are — platform-wide UI config that belongs in a file, not typed into the app.
export const tipPresets = [10, 20, 30, 50];
