import { env } from './env.js';
import { getActiveSettings } from '../services/financeSettings.service.js';

// The two switches every payment path consults, in one place so the order flow, the dine-in
// bill flow and GET /api/app/config can never disagree about them.

// Simulated payments mark an order/bill paid with no money moving. Never in production,
// whatever the flag says — a forgotten flag on a production deploy must not turn into free
// food. When simulation IS on, the backend also skips creating Razorpay orders entirely, so a
// local .env that happens to hold real gateway keys can't reach Razorpay from a dev session.
export const paymentSimulationEnabled = env.NODE_ENV !== 'production' && env.ALLOW_PAYMENT_SIMULATION;

// Cash on delivery for delivery orders. Dine-in "pay at the counter" is a different thing (the
// restaurant collects it) and is not governed by this switch. Lives in Finance Settings so an
// admin can flip it without a deploy; COD_ENABLED in the environment only seeds it.
export const isCodEnabled = async () => (await getActiveSettings()).codEnabled;
