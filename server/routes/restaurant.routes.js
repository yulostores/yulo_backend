import { Router } from 'express';
import {
  listRestaurants,
  getRestaurant,
  getMenu,
  searchRestaurantMenu,
  getMenuCategories,
  getReviews,
} from '../controllers/restaurant.controller.js';
import { create as createRequest, listMine as listMyRequests } from '../controllers/request.controller.js';
import { getTable, getSession, placeOrder } from '../controllers/publicTable.controller.js';
import { optionalAuthenticate } from '../middleware/optionalAuthenticate.js';
import { loadPublicRestaurant } from '../middleware/loadPublicRestaurant.js';
import { guestOrderLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// optionalAuthenticate, not authenticate: these stay public/unauthenticated routes —
// it only lets the handlers thread `isFavorited` in when a valid customer token happens
// to be present, never requires one.
//
// loadPublicRestaurant is what applies the approval rule to everything addressed by id;
// the collection route below carries the same rule inside its own query instead.
router.get('/', optionalAuthenticate, listRestaurants);
router.get('/:id', optionalAuthenticate, loadPublicRestaurant, getRestaurant);
router.get('/:id/menu', optionalAuthenticate, loadPublicRestaurant, getMenu);
router.get('/:id/menu/search', optionalAuthenticate, loadPublicRestaurant, searchRestaurantMenu);
router.get('/:id/menu/categories', loadPublicRestaurant, getMenuCategories);
router.get('/:id/reviews', loadPublicRestaurant, getReviews);

// Guest assistance requests (call waiter, need water, need the bill, …) — raised from
// a table, never gated behind the OTP login ordering requires. See RequestsBoard.jsx /
// CustomerHelp.jsx on the frontend and API-GAPS.md.
router.post('/:id/requests', optionalAuthenticate, loadPublicRestaurant, createRequest);
router.get('/:id/requests', loadPublicRestaurant, listMyRequests);

// Guest QR ordering (yulo_menu) — a diner scans the table QR and orders with no login.
// Same public shape as the requests routes above; the order-placing route additionally
// carries its own tighter rate limit (see middleware/rateLimiter.js#guestOrderLimiter).
router.get('/:id/tables/:tableId', loadPublicRestaurant, getTable);
router.get('/:id/tables/:tableId/session', loadPublicRestaurant, getSession);
router.post(
  '/:id/tables/:tableId/orders',
  guestOrderLimiter,
  optionalAuthenticate,
  loadPublicRestaurant,
  placeOrder
);

export default router;
