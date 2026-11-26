// How restaurants are paid.
//
//   'anytime'  (default) — the super admin pays a restaurant any day, the full balance or part of
//              it (services/restaurantPayouts.service.js). No weekly statements are generated, and
//              the weekly schedule / release / bank-file actions are refused.
//   'weekly'   — the original weekly settlement statements (services/settlement.service.js,
//              jobs/settlementScheduler.js). Kept so the old flow's tests still run and the mode
//              can be switched back with RESTAURANT_PAYOUT_MODE=weekly.
//
// Weekly statements already paid stay readable in both modes.

let override = null;

export const payoutMode = () => override ?? (process.env.RESTAURANT_PAYOUT_MODE === 'weekly' ? 'weekly' : 'anytime');
export const isAnytimeMode = () => payoutMode() === 'anytime';

/** Tests only. Pass null to go back to the environment's value. */
export const __setPayoutModeForTests = (mode) => {
  override = mode;
};
