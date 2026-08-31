import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { authorizeRole } from '../../middleware/authorizeRole.js';
import { authorizeRestaurant } from '../../middleware/authorizeRestaurant.js';
import { requireRestaurantApproved } from '../../middleware/requireRestaurantApproved.js';
import { createRestaurant, listMyRestaurants } from '../../controllers/owner/restaurant.controller.js';
import ownerAuthRoutes from './auth.routes.js';
import dashboardRoutes from './dashboard.routes.js';
import restaurantRoutes from './restaurant.routes.js';
import settingsRoutes from './settings.routes.js';
import categoryRoutes from './category.routes.js';
import menuItemRoutes from './menuItem.routes.js';
import tableRoutes from './table.routes.js';
import orderRoutes from './order.routes.js';
import billRoutes from './bill.routes.js';
import discountRoutes from './discount.routes.js';
import loyaltyRoutes from './loyalty.routes.js';
import liveMonitorRoutes from './liveMonitor.routes.js';
import staffRoutes from './staff.routes.js';

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

// Scoped per-restaurant sub-router — mergeParams exposes :restaurantId to children
const restaurantScopedRouter = Router({ mergeParams: true });
restaurantScopedRouter.use(authorizeRestaurant);
restaurantScopedRouter.use('/dashboard', dashboardRoutes);
restaurantScopedRouter.use('/restaurant', restaurantRoutes);
restaurantScopedRouter.use('/settings', settingsRoutes);
// Staff and menu build-out are locked until admin approves the restaurant — an owner can
// view/edit their pending restaurant's profile, but can't staff it or publish a menu yet.
restaurantScopedRouter.use('/categories', requireRestaurantApproved, categoryRoutes);
restaurantScopedRouter.use('/menu-items', requireRestaurantApproved, menuItemRoutes);
restaurantScopedRouter.use('/tables', tableRoutes);
restaurantScopedRouter.use('/orders', orderRoutes);
restaurantScopedRouter.use('/bills', billRoutes);
restaurantScopedRouter.use('/discounts', discountRoutes);
restaurantScopedRouter.use('/loyalty', loyaltyRoutes);
restaurantScopedRouter.use('/live-monitor', liveMonitorRoutes);
restaurantScopedRouter.use('/staff', requireRestaurantApproved, staffRoutes);

ownerRouter.use('/:restaurantId', restaurantScopedRouter);

export default ownerRouter;
