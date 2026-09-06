import Order from '../models/Order.js';
import TableSession from '../models/TableSession.js';
import Table from '../models/Table.js';
import MenuItem from '../models/MenuItem.js';
import OptionGroup from '../models/OptionGroup.js';
import Cart from '../models/Cart.js';
import Discount from '../models/Discount.js';
import User from '../models/User.js';
import Restaurant from '../models/Restaurant.js';
import { redis } from '../config/redis.js';
import { cartPlatformFee, cartTaxPercent } from '../config/finance.config.js';
import * as cartService from './cart.service.js';
import * as discountService from './discount.service.js';
import { VEG_FLEET_SEARCH_WINDOW_MS } from './deliveryAssignment.service.js';
import { ApiError } from '../utils/ApiError.js';
import { isPubliclyVisible } from '../utils/publicRestaurant.js';
import { notifyService } from './notify.service.js';

// The one place "who is this order for" is answered, for every door an order can come
// through. Returns the pair that gets snapshotted onto the order (see the comment on
// Order.customerName) — a signed-in account's current name/phone, or the guest details
// the table sitting captured, or nulls when neither exists (a waiter ringing in for a
// walk-in who gave nothing; `placedBy`/`staffId` still say who took it).
//
// Both are read fresh here rather than trusted from the caller: the phone in particular
// is the account's verified number, and a client must never be able to claim a different
// one on an order the restaurant will then use to call someone.
const resolveOrderCustomer = async ({ userId, session }) => {
  if (userId) {
    const user = await User.findById(userId).select('name phone').lean();
    return {
      customerName: user?.name?.trim() || null,
      customerPhone: user?.phone || null,
    };
  }

  return {
    customerName: session?.guestName?.trim() || null,
    customerPhone: session?.guestPhone || null,
  };
};

export const createOrder = async ({
  restaurantId,
  tableSessionId,
  userId,
  staffId,
  type,
  items,
  specialInstructions = '',
  paymentMethod,
  deliveryAddress,
  idempotencyKey,
}) => {
  // Step 0 — Idempotency check
  if (idempotencyKey) {
    const cached = await redis.get(`idem:${idempotencyKey}:${restaurantId}`);
    if (cached) return { orderId: cached, duplicate: true };
  }

  // Step 1 — Validate restaurant
  const restaurant = await Restaurant.findById(restaurantId).lean();
  // isPubliclyVisible, not just isActive: a suspended or not-yet-approved restaurant is
  // one a customer should never have reached a checkout for in the first place, and this
  // is the last point at which that can still be caught.
  if (!isPubliclyVisible(restaurant)) {
    throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  }

  // Step 2 — Validate and snapshot items
  const itemIds = items.map((i) => i.menuItemId);
  const menuItems = await MenuItem.find({
    _id: { $in: itemIds },
    restaurantId,
    isAvailable: true,
  }).lean();

  if (menuItems.length !== itemIds.length) {
    throw new ApiError(400, 'ORDER_ITEM_UNAVAILABLE', 'One or more items are unavailable');
  }

  const menuItemMap = new Map(menuItems.map((m) => [m._id.toString(), m]));

  const snapshots = items.map((i) => {
    const mi = menuItemMap.get(i.menuItemId.toString());
    const price = mi.discountedPrice ?? mi.sellingPrice;
    return {
      menuItemId: mi._id,
      name: mi.name,
      price,
      quantity: i.quantity,
      note: i.note || '',
    };
  });

  const subtotal = snapshots.reduce((sum, i) => sum + i.price * i.quantity, 0);

  // Step 3 — Dine-in path (no transaction — works with standalone MongoDB)
  if (tableSessionId) {
    const updatedSession = await TableSession.findOneAndUpdate(
      { _id: tableSessionId, status: 'open' },
      { $inc: { batchCount: 1 } },
      { new: true }
    );
    if (!updatedSession) {
      throw new ApiError(400, 'TABLE_SESSION_CLOSED', 'Session is not open');
    }

    const batchNumber = updatedSession.batchCount;

    // Snapshot the table onto the order itself. The session already knows its tableId,
    // but every consumer of an order (kitchen ticket, owner's Manage Orders, the
    // dashboard's live feed, the notify payload) would otherwise have to re-resolve
    // TableSession -> Table just to name the table the food is going to — and until now
    // none of them did, so `tableNumber` sat null on every dine-in order ever placed.
    const table = await Table.findById(updatedSession.tableId).select('identifier').lean();

    // The sitting is the guest's identity when there is no account — a QR guest and a
    // walk-in a waiter rang in are both "no userId", and the session is the only place
    // their name/number was ever collected.
    const customer = await resolveOrderCustomer({ userId, session: updatedSession });

    const order = await Order.create({
      restaurantId,
      tableSessionId,
      tableId: updatedSession.tableId,
      tableNumber: table?.identifier ?? null,
      userId,
      staffId,
      ...customer,
      placedBy: staffId ? 'waiter' : userId ? 'customer' : 'guest',
      type: 'dine_in',
      batchNumber,
      items: snapshots,
      subtotal,
      specialInstructions,
      paymentMethod: paymentMethod || 'cash',
      statusHistory: [
        {
          status: 'placed',
          at: new Date(),
          byStaffId: staffId ?? null,
          byRole: staffId ? 'waiter' : userId ? 'customer' : 'guest',
        },
      ],
    });

    await TableSession.findByIdAndUpdate(tableSessionId, {
      $push: { orders: order._id },
    });

    if (idempotencyKey) {
      await redis.set(
        `idem:${idempotencyKey}:${restaurantId}`,
        order._id.toString(),
        'EX',
        86400
      );
    }

    notifyService.newOrder(order);
    return order;
  }

  // Step 4 — Delivery / takeaway path
  const customer = await resolveOrderCustomer({ userId, session: null });

  const order = await Order.create({
    restaurantId,
    userId,
    staffId: null,
    placedBy: 'customer',
    ...customer,
    type,
    batchNumber: 1,
    items: snapshots,
    subtotal,
    specialInstructions,
    paymentMethod,
    // The address the caller passed, with the account's own name/number filled in as the
    // door contact when it carries none — an order the restaurant can't get a person at
    // is the failure this whole field exists to prevent.
    deliveryAddress: deliveryAddress
      ? {
          ...deliveryAddress,
          contactName: deliveryAddress.contactName || customer.customerName,
          contactPhone: deliveryAddress.contactPhone || customer.customerPhone,
        }
      : deliveryAddress,
    statusHistory: [{ status: 'placed', at: new Date(), byRole: 'customer' }],
  });

  if (idempotencyKey) {
    await redis.set(
      `idem:${idempotencyKey}:${restaurantId}`,
      order._id.toString(),
      'EX',
      86400
    );
  }

  notifyService.newOrder(order);
  return order;
};

// Turns the caller's cart (Prompt 9) into a real Order. Sequential writes, not wrapped in
// a Mongo transaction — no transaction pattern actually exists anywhere in this codebase
// today (createOrder's own dine-in path above is explicitly commented "no transaction —
// works with standalone MongoDB"), and introducing one here would require replica-set
// infrastructure this project doesn't run. This accepts the same class of non-atomicity
// the dine-in path above already does (its TableSession batchCount increments before
// Order.create, with no rollback if that create then fails) — if the cart-clear below
// fails after the order was already created, the customer keeps a stale cart alongside a
// real order, recoverable via DELETE /api/cart.
export const createOrderFromCart = async ({
  userId,
  addressId,
  deliveryInstructions = '',
  cookingRequests = false,
  extraCutlery = false,
  tip = 0,
  vegFleetOptIn = false,
  paymentMethod,
  idempotencyKey,
}) => {
  const cart = await Cart.findOne({ userId });
  if (!cart || cart.items.length === 0 || !cart.restaurantId) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Cart is empty');
  }

  // Step 0 — Idempotency, same key shape/TTL as the items-array createOrder above.
  if (idempotencyKey) {
    const cached = await redis.get(`idem:${idempotencyKey}:${cart.restaurantId}`);
    if (cached) return { orderId: cached, duplicate: true };
  }

  const restaurant = await Restaurant.findById(cart.restaurantId).lean();
  if (!isPubliclyVisible(restaurant)) {
    throw new ApiError(404, 'NOT_FOUND', 'Restaurant not found');
  }

  // name/phone as well as the addresses: the order snapshots WHO ordered, not just where
  // it goes (see the comment on Order.customerName).
  const user = await User.findById(userId).select('name phone savedAddresses').lean();
  const address = addressId
    ? user.savedAddresses.find((a) => String(a._id) === String(addressId))
    : user.savedAddresses.find((a) => a.isDefault) || user.savedAddresses[0];
  if (!address) throw new ApiError(400, 'VALIDATION_ERROR', 'No delivery address available');

  // Step 1 — Re-validate item prices/availability fresh (menu items may have changed
  // since they were added to cart) — the cart's own unitPrice snapshot is only for
  // display continuity while browsing; the actual order commit never trusts it blindly.
  const menuItemIds = cart.items.map((i) => i.menuItemId);
  const [menuItems, optionGroups] = await Promise.all([
    MenuItem.find({ _id: { $in: menuItemIds } }).lean({ virtuals: true }),
    OptionGroup.find({ menuItemId: { $in: menuItemIds } }).lean(),
  ]);
  const menuItemById = new Map(menuItems.map((m) => [String(m._id), m]));
  const groupsByMenuItemId = new Map();
  for (const group of optionGroups) {
    const key = String(group.menuItemId);
    if (!groupsByMenuItemId.has(key)) groupsByMenuItemId.set(key, []);
    groupsByMenuItemId.get(key).push(group);
  }

  const unavailable = [];
  const priceChanged = [];
  const snapshots = [];

  for (const item of cart.items) {
    const menuItem = menuItemById.get(String(item.menuItemId));
    if (!menuItem || !menuItem.isAvailable) {
      unavailable.push({ menuItemId: item.menuItemId, name: item.name });
      continue;
    }

    const groups = groupsByMenuItemId.get(String(item.menuItemId)) ?? [];
    const pricing = cartService.priceItemSelection(menuItem, groups, item.selectedOptions);
    if (!pricing.valid) {
      // A previously-valid customization became invalid (e.g. the owner deleted that
      // option group) — treated the same as "item unavailable", not a separate error
      // class, since either way this line can no longer be checked out as-is.
      unavailable.push({ menuItemId: item.menuItemId, name: item.name });
      continue;
    }

    if (pricing.totalPriceMinor !== item.unitPrice) {
      // Never silently charge a different amount than what the cart showed — surface it
      // so the client can prompt "prices changed, please review your cart" instead.
      priceChanged.push({
        menuItemId: item.menuItemId,
        name: item.name,
        oldPrice: item.unitPrice,
        newPrice: pricing.totalPriceMinor,
      });
      continue;
    }

    snapshots.push({
      menuItemId: menuItem._id,
      name: menuItem.name,
      price: pricing.totalPriceMinor,
      quantity: item.qty,
      note: '',
      selectedOptions: item.selectedOptions,
    });
  }

  if (unavailable.length > 0) {
    throw new ApiError(
      400,
      'ORDER_ITEM_UNAVAILABLE',
      'One or more cart items are no longer available',
      { items: unavailable }
    );
  }
  if (priceChanged.length > 0) {
    throw new ApiError(
      409,
      'CART_PRICE_CHANGED',
      'Some item prices have changed — please review your cart',
      { items: priceChanged }
    );
  }

  // Step 2 — Bill, recomputed fresh from the re-validated snapshots above (not the
  // cart's own possibly-stale computeBill) — same fee logic (computeDeliveryFee), reused
  // rather than re-implemented.
  const subtotal = snapshots.reduce((sum, s) => sum + s.price * s.quantity, 0);
  const deliveryFee = cartService.computeDeliveryFee(subtotal, restaurant.delivery);
  const platformFee = cartPlatformFee;
  const tax = subtotal * (cartTaxPercent / 100);

  let discountAmount = 0;
  let appliedDiscountId = null;
  if (cart.appliedDiscountId) {
    const discount = await Discount.findById(cart.appliedDiscountId).lean();
    try {
      discountService.validateDiscountForOrder(discount, { subtotal, orderType: 'delivery' });
      discountAmount = await discountService.computeDiscountAmount(discount, subtotal);
      appliedDiscountId = discount._id;
    } catch {
      // Same "silently stop applying rather than block checkout" behavior as
      // cart.service.js's computeBill — see that comment for the reasoning.
    }
  }

  const grandTotal = subtotal + deliveryFee + platformFee + tax + tip - discountAmount;

  // Never trust the client's raw vegFleetOptIn claim — only honor it if this restaurant
  // actually has veg-fleet coverage. A restaurant without it gets a normal order,
  // regardless of what the client sent.
  const effectiveVegFleetOptIn = Boolean(vegFleetOptIn && restaurant.vegFleetAvailable);

  const order = await Order.create({
    restaurantId: cart.restaurantId,
    userId,
    staffId: null,
    placedBy: 'customer',
    statusHistory: [{ status: 'placed', at: new Date(), byRole: 'customer' }],
    type: 'delivery',
    batchNumber: 1,
    items: snapshots,
    subtotal,
    deliveryFee,
    platformFee,
    tax,
    tip,
    appliedDiscountId,
    discountAmount,
    grandTotal,
    deliveryInstructions,
    cookingRequests,
    extraCutlery,
    paymentMethod: paymentMethod === 'online' ? 'online' : 'cash',
    // COD reads as "cash to be collected on delivery" from the moment the order exists —
    // distinct from the schema default 'pending', which for an 'online' order here means
    // "awaiting Razorpay verification/webhook" (see controllers/order.controller.js's
    // payment/verify endpoint and the /api/webhooks/razorpay handler).
    paymentStatus: paymentMethod === 'online' ? 'pending' : 'pending_cod',
    customerName: user.name?.trim() || null,
    customerPhone: user.phone || null,
    // The whole address, not the two fields it used to keep: state and pincode were
    // dropped here, which left the restaurant and the delivery partner with a street line
    // and a city and no PIN to navigate by. contactName/contactPhone fall back to the
    // account holder — an address saved for someone else carries its own.
    deliveryAddress: {
      label: address.customLabel?.trim() || address.label || null,
      street: address.street,
      city: address.city,
      state: address.state,
      pincode: address.pincode,
      coordinates: address.location?.coordinates ?? null,
      contactName: address.contactName?.trim() || user.name?.trim() || null,
      contactPhone: address.contactPhone || user.phone || null,
    },
    vegFleetOptIn: effectiveVegFleetOptIn,
    dedicatedBagRequired: effectiveVegFleetOptIn,
    vegFleetAssignmentStatus: effectiveVegFleetOptIn ? 'searching' : 'not_requested',
    vegFleetSearchDeadline: effectiveVegFleetOptIn ? new Date(Date.now() + VEG_FLEET_SEARCH_WINDOW_MS) : null,
  });

  if (idempotencyKey) {
    await redis.set(`idem:${idempotencyKey}:${cart.restaurantId}`, order._id.toString(), 'EX', 86400);
  }

  // Clear the cart on success — see the file-level comment on this function for why this
  // isn't (and can't cheaply be) wrapped in the same transaction as Order.create above.
  cart.items = [];
  cart.restaurantId = null;
  cart.appliedDiscountId = null;
  await cart.save();

  // NOT autoAssign(order) here — kitchen.service.js's updateOrderStatus already triggers
  // delivery-partner search when the restaurant confirms the order ('placed' -> 'confirmed'),
  // and that trigger point is unchanged by this feature. autoAssign now reads
  // order.vegFleetOptIn/vegFleetAssignmentStatus itself (see rankCandidates), so whenever
  // that existing trigger fires, it automatically respects veg-fleet filtering — no new
  // call site needed here.
  notifyService.newOrder(order);

  return order;
};

// Seeds a fresh Cart from a past order rather than creating an Order directly — the
// customer still goes through checkout normally (screen 25's "Reorder" button, screen
// 28's per-order-history-card version). Each item is added via cartService.addItem
// UNCHANGED, so a reordered cart behaves identically to one built by hand: same pricing
// re-validation, same single-restaurant rule, same CART_RESTAURANT_CONFLICT behavior if
// the customer already has an unrelated cart going — this deliberately does NOT
// pre-emptively clear their existing cart, so that conflict surfaces exactly the same
// "Discard cart from X?" dialog the client already knows how to render for any other add.
export const reorderOrder = async (orderId, userId) => {
  const order = await Order.findOne({ _id: orderId, userId }).lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');
  if (order.type !== 'delivery') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Only delivery orders can be reordered');
  }

  const user = await User.findById(userId).select('preferences').lean();
  const vegModeEnabled = Boolean(user?.preferences?.vegModeEnabled);

  const menuItemIds = order.items.map((i) => i.menuItemId);
  const menuItems = await MenuItem.find({ _id: { $in: menuItemIds } }).lean({ virtuals: true });
  const menuItemById = new Map(menuItems.map((m) => [String(m._id), m]));

  // Batch-resolve veg substitutes for any current non-veg item that has one — same
  // pattern as services/home.service.js's getRecommendedItems. Comparing each item's
  // CURRENT foodType against the CUSTOMER'S CURRENT preference (rather than trying to
  // recall what vegModeEnabled was back when this order was placed, which Order doesn't
  // record) already naturally no-ops for items that don't need to change — e.g. if veg
  // mode was already on at order time, the stored item is already the veg variant, so
  // `foodType === 'veg'` here and nothing gets substituted a second time.
  const variantIds = menuItems
    .filter((m) => m.foodType !== 'veg' && m.vegVariantId)
    .map((m) => m.vegVariantId);
  const variants = variantIds.length > 0
    ? await MenuItem.find({ _id: { $in: variantIds }, isAvailable: true }).lean({ virtuals: true })
    : [];
  const variantById = new Map(variants.map((v) => [String(v._id), v]));

  const removedItems = [];
  const toAdd = [];

  for (const original of order.items) {
    const menuItem = menuItemById.get(String(original.menuItemId));
    if (!menuItem || !menuItem.isAvailable) {
      removedItems.push({ menuItemId: original.menuItemId, name: original.name, reason: 'unavailable' });
      continue;
    }

    if (vegModeEnabled && menuItem.foodType !== 'veg') {
      const variant = menuItem.vegVariantId ? variantById.get(String(menuItem.vegVariantId)) : null;
      if (!variant) {
        removedItems.push({ menuItemId: original.menuItemId, name: original.name, reason: 'no_veg_substitute' });
        continue;
      }
      // Substituting to a different item resets customization — the original
      // selectedOptions belong to the OLD item's option groups, which essentially never
      // apply to the substitute's.
      toAdd.push({ menuItemId: variant._id, qty: original.quantity, selectedOptions: [] });
      continue;
    }

    toAdd.push({
      menuItemId: menuItem._id,
      qty: original.quantity,
      selectedOptions: original.selectedOptions || [],
    });
  }

  // Structural conflicts (a different restaurant already in the cart) abort the whole
  // reorder immediately, since every remaining item would hit the same conflict — that's
  // not a per-item "availability" problem, so it isn't folded into removedItems.
  for (const item of toAdd) {
    try {
      await cartService.addItem(userId, item);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'CART_RESTAURANT_CONFLICT') throw err;
      removedItems.push({ menuItemId: item.menuItemId, name: null, reason: 'invalid_customization' });
    }
  }

  const { cart, bill } = await cartService.getCart(userId);
  return { cart, bill, removedItems };
};
