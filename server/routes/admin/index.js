import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import adminAuthRoutes from './auth.routes.js';
import storeRoutes from './store.routes.js';
import customerRoutes from './customer.routes.js';
import deliveryPartnerRoutes from './deliveryPartner.routes.js';
import ticketRoutes from './ticket.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import reportRoutes from './report.routes.js';
import financeRoutes from './finance.routes.js';
import orderRoutes from './order.routes.js';
import billRoutes from './bill.routes.js';
import bankRequestRoutes from './bankRequests.routes.js';
import sellerRoutes from './seller.routes.js';
import couponPlanRoutes from './couponPlan.routes.js';
import { categoryRouter as couponCategoryRoutes, offerRouter as couponOfferRoutes } from './coupon.routes.js';
import { couponsRouter, couponReportsRouter, couponSettingsRouter } from './couponAdmin.routes.js';
import reminderCampaignRoutes from './reminderCampaign.routes.js';
import sellerBillRoutes from './sellerBill.routes.js';
import jobApplicationRoutes from './jobApplication.routes.js';
import partnerApplicationRoutes from './partnerApplication.routes.js';
import transactionRoutes from './transactions.routes.js';

const router = Router();

// Admin login — no auth required, kept separate from /api/auth/* so the admin portal
// has its own entry point (mirrors /api/staff/auth and /api/partner/auth).
router.use('/auth', adminAuthRoutes);

router.use(authenticate, authorizeRole('admin'));

router.use('/stores', storeRoutes);
router.use('/customers', customerRoutes);
router.use('/delivery-partners', deliveryPartnerRoutes);
router.use('/tickets', ticketRoutes);
router.use('/dashboard', dashboardRoutes);
router.use('/reports', reportRoutes);
router.use('/finance', financeRoutes);
// Every payment in and out, from all sources (services/transactions.service.js).
router.use('/transactions', transactionRoutes);
router.use('/orders', orderRoutes);
router.use('/bills', billRoutes);
router.use('/bank-requests', bankRequestRoutes);
// Coupon partners (COUPON_IMPLEMENTATION_PROMPTS.md).
router.use('/sellers', sellerRoutes);
router.use('/coupon-plans', couponPlanRoutes);
router.use('/coupon-categories', couponCategoryRoutes);
router.use('/coupon-offers', couponOfferRoutes);
router.use('/coupons', couponsRouter);
router.use('/coupon-reports', couponReportsRouter);
router.use('/coupon-settings', couponSettingsRouter);
router.use('/reminder-campaigns', reminderCampaignRoutes);
router.use('/seller-bills', sellerBillRoutes);
// Careers portal applications.
router.use('/job-applications', jobApplicationRoutes);
router.use('/partner-applications', partnerApplicationRoutes);

export default router;
