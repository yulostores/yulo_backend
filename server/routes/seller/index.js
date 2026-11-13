import { Router } from 'express';
import { authenticateSeller } from '../../middleware/authenticateSeller.js';
import { authorizeSellerRole } from '../../middleware/authorizeSellerRole.js';
import { getStatus } from '../../controllers/seller/onboarding.controller.js';
import sellerAuthRoutes from './auth.routes.js';
import onboardingRoutes from './onboarding.routes.js';
import { requireSellerActive } from '../../middleware/requireSellerActive.js';
import {
  listPlans,
  listSubscriptions,
  buyPlan,
  verifyPlanPayment,
  simulatePlanPayment,
} from '../../controllers/seller/plans.controller.js';
import offerRoutes from './offer.routes.js';
import redeemRoutes from './redeem.routes.js';
import reportsRoutes from './reports.routes.js';
import teamRoutes from './team.routes.js';
import { dashboard } from '../../controllers/seller/reports.controller.js';
import { getAgreement, acceptAgreement, getProfile, updateProfile } from '../../controllers/seller/account.controller.js';
import { getCredits, purchase as purchaseCredits, verify as verifyCredits, simulate as simulateCredits, reminders } from '../../controllers/seller/sms.controller.js';

// The seller (coupon partner) portal API — /api/seller. Every route but /auth sits behind
// authenticateSeller; business routes add requireSellerActive and authorizeSellerRole
// (owner / manager / employee). Later prompts mount plans, offers, redemption, reports and
// team here.
const sellerRouter = Router();

sellerRouter.use('/auth', sellerAuthRoutes);

sellerRouter.use(authenticateSeller);

// Any role, any seller status: the portal shows "under review" / "rejected" / "suspended" from it.
sellerRouter.get('/status', getStatus);
// Owner only, and open while pending or rejected (the service locks what an approved seller can't change).
sellerRouter.use('/onboarding', authorizeSellerRole('owner'), onboardingRoutes);

// ── Approved sellers only from here ──
const ownerOrManager = authorizeSellerRole('owner', 'manager');
const ownerOnly = authorizeSellerRole('owner');

// Plans and purchases (CB4): owner and manager read, only the owner buys.
sellerRouter.get('/plans', requireSellerActive, ownerOrManager, listPlans);
sellerRouter.get('/subscriptions', requireSellerActive, ownerOrManager, listSubscriptions);
sellerRouter.post('/subscriptions', requireSellerActive, ownerOnly, buyPlan);
sellerRouter.post('/subscriptions/:id/verify', requireSellerActive, ownerOnly, verifyPlanPayment);
sellerRouter.post('/subscriptions/:id/simulate-payment', requireSellerActive, ownerOnly, simulatePlanPayment);

// Coupon offers (CB5): owner and manager.
sellerRouter.use('/offers', requireSellerActive, ownerOrManager, offerRoutes);

// Redemption at the counter (CB7): every role, including employees.
sellerRouter.use('/redeem', requireSellerActive, authorizeSellerRole('owner', 'manager', 'employee'), redeemRoutes);

// Dashboard, reports and team (CB8): owner and manager. The team service decides who may manage whom.
sellerRouter.get('/dashboard', requireSellerActive, ownerOrManager, dashboard);
sellerRouter.use('/reports', requireSellerActive, ownerOrManager, reportsRoutes);
sellerRouter.use('/users', requireSellerActive, ownerOrManager, teamRoutes);
sellerRouter.get('/profile', requireSellerActive, ownerOrManager, getProfile);
sellerRouter.patch('/profile', requireSellerActive, ownerOnly, updateProfile);
// The partner agreement can be read and accepted before approval too (during onboarding).
sellerRouter.get('/agreement', ownerOrManager, getAgreement);
sellerRouter.post('/agreement/accept', ownerOnly, acceptAgreement);

// Reminder SMS (CB10): credits and the reminder screen — owner and manager (both may buy credits).
sellerRouter.get('/sms-credits', requireSellerActive, ownerOrManager, getCredits);
sellerRouter.post('/sms-credits/purchase', requireSellerActive, ownerOrManager, purchaseCredits);
sellerRouter.post('/sms-credits/purchase/:id/verify', requireSellerActive, ownerOrManager, verifyCredits);
sellerRouter.post('/sms-credits/purchase/:id/simulate-payment', requireSellerActive, ownerOrManager, simulateCredits);
sellerRouter.get('/reminders', requireSellerActive, ownerOrManager, reminders);

export default sellerRouter;
