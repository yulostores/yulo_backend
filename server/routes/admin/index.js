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
router.use('/orders', orderRoutes);
router.use('/bills', billRoutes);

export default router;
