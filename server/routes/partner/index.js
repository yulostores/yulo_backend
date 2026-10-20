import { Router } from 'express';
import partnerAuthRoutes from './auth.routes.js';
import partnerOnboardingRoutes from './onboarding.routes.js';
import partnerDutyRoutes from './duty.routes.js';
import partnerOrderRoutes from './order.routes.js';
import partnerEarningsRoutes from './earnings.routes.js';
import partnerDepositRoutes from './deposit.routes.js';
import partnerTrainingRoutes from './training.routes.js';
import partnerProfileRoutes from './profile.routes.js';
import partnerNotificationsRoutes from './notifications.routes.js';
import partnerFleetChangeRequestRoutes from './fleetChangeRequest.routes.js';
import partnerSupportRoutes from './support.routes.js';
import { authenticatePartner } from '../../middleware/authenticatePartner.js';
import { getPartnerConfig } from '../../controllers/partner/config.controller.js';
import partnerLocationRoutes from './location.routes.js';

const partnerRouter = Router();

// Auth stays unauthenticated; everything else sits behind authenticatePartner (each sub-router
// applies it itself, at the top of its own routes file).
partnerRouter.use('/auth', partnerAuthRoutes);
partnerRouter.use('/onboarding', partnerOnboardingRoutes);
partnerRouter.use('/duty', partnerDutyRoutes);
partnerRouter.use('/orders', partnerOrderRoutes);
partnerRouter.use('/earnings', partnerEarningsRoutes);
partnerRouter.use('/deposits', partnerDepositRoutes);
partnerRouter.use('/training', partnerTrainingRoutes);
partnerRouter.use('/profile', partnerProfileRoutes);
partnerRouter.use('/notifications', partnerNotificationsRoutes);
partnerRouter.use('/fleet-change-requests', partnerFleetChangeRequestRoutes);
partnerRouter.use('/support', partnerSupportRoutes);
partnerRouter.use('/location', partnerLocationRoutes);
// Runtime switches for the rider app (e.g. whether cash on delivery is on).
partnerRouter.get('/config', authenticatePartner, getPartnerConfig);

export default partnerRouter;
