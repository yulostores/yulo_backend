import { Router } from 'express';
import staffAuthRoutes from './auth.routes.js';
import waiterRoutes from './waiter.routes.js';
import kitchenRoutes from './kitchen.routes.js';
import requestRoutes from './request.routes.js';

const staffRouter = Router();

// Staff login — no auth required
staffRouter.use('/auth', staffAuthRoutes);

// Restaurant-scoped routes — each sub-router applies its own auth + role + restaurant checks
const staffRestaurantRouter = Router({ mergeParams: true });
staffRestaurantRouter.use('/waiter', waiterRoutes);
staffRestaurantRouter.use('/kitchen', kitchenRoutes);
staffRestaurantRouter.use('/requests', requestRoutes);

staffRouter.use('/:restaurantId', staffRestaurantRouter);

export default staffRouter;
