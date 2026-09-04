import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import * as orderService from './order.service.js';
import { ApiError } from '../utils/ApiError.js';

// Guest-triggered counterpart to services/waiter.service.js#scanTable — same table/QR
// validation and same "find-or-create the open session" behavior, but with no staffId
// (a guest opens their own session by landing on the QR link, no waiter involved).
const getOrOpenSession = async ({ restaurantId, tableId, guestPhone }) => {
  const table = await Table.findOne({ _id: tableId, restaurantId, isActive: true }).lean();
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');
  if (table.qrCode?.status === 'void') {
    throw new ApiError(400, 'QR_VOID', 'QR code has been voided — rescan with the new QR');
  }

  let session = await TableSession.findOne({ tableId: table._id, status: 'open' });
  if (!session) {
    session = await TableSession.create({
      restaurantId,
      tableId: table._id,
      guestPhone: guestPhone || undefined,
    });
  }

  return { table, session };
};

export const placeGuestOrder = async ({
  restaurantId,
  tableId,
  items,
  specialInstructions,
  guestPhone,
  idempotencyKey,
}) => {
  const { session } = await getOrOpenSession({ restaurantId, tableId, guestPhone });

  // orderService.createOrder's dine-in branch (tableSessionId set) already does the item
  // snapshot/pricing, batchCount increment, TableSession.orders push and newOrder
  // notification — same path the waiter's POST /waiter/orders uses. userId/staffId are
  // left unset, exactly as the schema already allows.
  const order = await orderService.createOrder({
    restaurantId,
    tableSessionId: session._id,
    items,
    specialInstructions,
    paymentMethod: 'cash',
    idempotencyKey,
  });

  return { order, tableSessionId: session._id };
};

export const getGuestSession = async ({ restaurantId, tableId }) => {
  const session = await TableSession.findOne({ tableId, restaurantId, status: 'open' })
    .populate('orders')
    .lean();
  return session;
};
