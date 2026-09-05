import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import { authorizeRestaurant } from '../../middleware/authorizeRestaurant.js';
import { requireRestaurantApproved } from '../../middleware/requireRestaurantApproved.js';
import { createRestaurant, listMyRestaurants } from '../../controllers/owner/restaurant.controller.js';
import { getSettingsRequirements } from '../../controllers/owner/settings.controller.js';
import ownerAuthRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import restaurantRoutes from './restaurant.routes.js';
import settingsRoutes from './settings.routes.js';
import documentRoutes from './document.routes.js';
import categoryRoutes from './category.routes.js';
import menuItemRoutes from './menuItem.routes.js';
import tableRoutes from './table.routes.js';
import orderRoutes from './order.routes.js';
import billRoutes from './bill.routes.js';
import discountRoutes from './discount.routes.js';
import loyaltyRoutes from './loyalty.routes.js';
import liveMonitorRoutes from './liveMonitor.routes.js';
import staffRoutes from './staff.routes.js';
import requestRoutes from './request.routes.js';

const ownerRouter = Router();

// Owner signup/login — no auth required, kept separate from /api/auth/* so the owner
// portal has its own entry point (mirrors /api/staff/auth and /api/partner/auth).
ownerRouter.use('/auth', ownerAuthRoutes);

ownerRouter.use(authenticate, authorizeRole('restaurant_owner'));

// Top-level restaurant management (must come before /:restaurantId to avoid route conflict)
// Unrestricted by approval status — creating a restaurant IS the application that admin
// then reviews (see Restaurant.approvalStatus / PATCH /api/admin/stores/:id/approve).
ownerRouter.get('/restaurants', listMyRestaurants);
ownerRouter.post('/restaurants', createRestaurant);

// The store-settings field contract — which details are mandatory, what each has to look
// like, what the dropdowns offer. Not restaurant-scoped: the portal needs it to render the
// "Add Your Restaurant" step, which is what runs when the owner has no restaurant yet.
ownerRouter.get('/settings-requirements', getSettingsRequirements);

// Scoped per-restaurant sub-router — mergeParams exposes :restaurantId to children
const restaurantScopedRouter = Router({ mergeParams: true });
restaurantScopedRouter.use(authorizeRestaurant);
// Running the restaurant is locked until an admin approves it. Only the two things an
// owner needs in order to *get* approved stay open: their store profile and its settings,
// which are how an application is submitted and how a rejected one is corrected.
//
// Everything below used to be locked in the client alone (ApprovalGate, see the restaurant
// portal's lib/approval.js) while the API answered 200 to the same calls — so the lock held
// for anyone using the app and not at all for anyone holding the owner's token directly.
restaurantScopedRouter.use('/restaurant', restaurantRoutes);
restaurantScopedRouter.use('/settings', settingsRoutes);
// Compliance documents belong to the same open set: uploading them is how a pending
// restaurant gets approved, and how a rejected one answers what admin asked for.
restaurantScopedRouter.use('/documents', documentRoutes);

restaurantScopedRouter.use(requireRestaurantApproved);

restaurantScopedRouter.use('/dashboard', dashboardRoutes);
restaurantScopedRouter.use('/categories', categoryRoutes);
restaurantScopedRouter.use('/menu-items', menuItemRoutes);
restaurantScopedRouter.use('/tables', tableRoutes);
restaurantScopedRouter.use('/orders', orderRoutes);
restaurantScopedRouter.use('/bills', billRoutes);
restaurantScopedRouter.use('/discounts', discountRoutes);
restaurantScopedRouter.use('/loyalty', loyaltyRoutes);
restaurantScopedRouter.use('/live-monitor', liveMonitorRoutes);
restaurantScopedRouter.use('/staff', staffRoutes);
restaurantScopedRouter.use('/requests', requestRoutes);

ownerRouter.use('/:restaurantId', restaurantScopedRouter);

export default ownerRouter;
