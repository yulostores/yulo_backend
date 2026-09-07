import { getIO } from '../socket.js';

// Partner presence (like restaurant presence before it) is tracked directly in socket.js's
// join_partner/disconnect handlers via a Redis set (live:active_partners), not delegated through
// this file — this module only emits to already-joined rooms, it doesn't own connection
// bookkeeping, and restaurant presence already established that convention (see
// live:active_restaurants in socket.js, not here). No partnerConnected/partnerDisconnected stub
// is added for the same reason there's no restaurantConnected/restaurantDisconnected one today.

export const notifyService = {
  newOrder(order) {
    const io = getIO();
    const payload = {
      orderId: order._id,
      type: order.type,
      tableId: order.tableId,
      tableNumber: order.tableNumber,
      staffId: order.staffId,
      placedBy: order.placedBy,
      // Who it's for, so a ticket landing live on the kitchen/owner screen reads the same
      // as one fetched through orderView.service.js's enrichOrders — before this, a new
      // order arrived anonymous over the socket and only gained a customer on refresh.
      customerName: order.customerName ?? null,
      customerPhone: order.customerPhone ?? null,
      batchNumber: order.batchNumber,
      items: order.items,
      specialInstructions: order.specialInstructions,
      subtotal: order.subtotal,
      // Restaurant-fulfillment toggles (screen 19) — the kitchen/restaurant needs these,
      // not the delivery partner (deliveryInstructions below is the partner-facing one).
      cookingRequests: order.cookingRequests,
      extraCutlery: order.extraCutlery,
    };
    io.to(`restaurant:${order.restaurantId}`).emit('new_order', payload);
    io.to(`kitchen:${order.restaurantId}`).emit('new_order', payload);
  },

  // Fired whenever Order.vegFleetAssignmentStatus changes (order placement, keep-waiting,
  // fallback, the auto-extend sweep, or a partner accepting) so the customer's tracking
  // screen doesn't have to poll GET /api/orders/:id/veg-fleet/status.
  vegFleetStatusUpdated(order) {
    const io = getIO();
    io.to(`order:${order._id}`).emit('veg_fleet_status_updated', {
      orderId: order._id,
      status: order.vegFleetAssignmentStatus,
      remainingSeconds: order.vegFleetSearchDeadline
        ? Math.max(0, Math.round((order.vegFleetSearchDeadline.getTime() - Date.now()) / 1000))
        : null,
    });
  },

  orderStatusUpdated(order, { etaMinutes = null } = {}) {
    const io = getIO();
    // tableNumber and the last history entry ride along so a listening client can update
    // its row in place — naming the table and who moved it — without a refetch.
    // etaMinutes is only meaningful for out_for_delivery, and only when the partner has
    // a fresh location ping; null otherwise — the tracking screen treats null as "no ETA"
    // and hides the "Arriving in X mins" row rather than guessing.
    const lastChange = order.statusHistory?.at?.(-1) ?? null;
    const payload = {
      orderId: order._id,
      status: order.status,
      etaMinutes,
      tableId: order.tableId,
      tableNumber: order.tableNumber,
      updatedAt: order.updatedAt,
      changedBy: lastChange
        ? { staffId: lastChange.byStaffId, name: lastChange.byStaffName, role: lastChange.byRole }
        : null,
    };
    io.to(`restaurant:${order.restaurantId}`).emit('order_status_updated', payload);
    io.to(`kitchen:${order.restaurantId}`).emit('order_status_updated', payload);
    io.to(`order:${order._id}`).emit('order_status_updated', payload);
    if (order.staffId) {
      io.to(`waiter:${order.restaurantId}:${order.staffId}`).emit('order_status_updated', payload);
    }
  },

  billUpdated({ _id, tableId, grandTotal, discountsApplied, batches }) {
    const io = getIO();
    io.to(`table:${tableId}`).emit('bill_updated', {
      billId: _id,
      grandTotal,
      discountsApplied,
      lastBatch: batches?.at(-1),
    });
  },

  tableStatusChanged(restaurantId, table, sessionStatus) {
    const io = getIO();
    io.to(`restaurant:${restaurantId}`).emit('table_status_changed', {
      tableId: table._id,
      identifier: table.identifier,
      sessionStatus,
    });
  },

  newRequest(request) {
    const io = getIO();
    io.to(`restaurant:${request.restaurantId}`).emit('new_request', {
      requestId: request._id,
      tableId: request.tableId,
      type: request.type,
      note: request.note,
      status: request.status,
      createdAt: request.createdAt,
    });
  },

  requestStatusUpdated(request) {
    const io = getIO();
    io.to(`restaurant:${request.restaurantId}`).emit('request_status_updated', {
      requestId: request._id,
      tableId: request.tableId,
      status: request.status,
      resolvedAt: request.resolvedAt,
    });
  },
};
