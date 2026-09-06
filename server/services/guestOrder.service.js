import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import * as orderService from './order.service.js';
import { ApiError } from '../utils/ApiError.js';

// Guest-triggered counterpart to services/waiter.service.js#scanTable — same table/QR
// validation and same "find-or-create the open session" behavior, but with no staffId
// (a guest opens their own session by landing on the QR link, no waiter involved).
const getOrOpenSession = async ({ restaurantId, tableId, guestName, guestPhone }) => {
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
      guestName: guestName || undefined,
      guestPhone: guestPhone || undefined,
    });
    return { table, session };
  }

  // The session may already have been opened without any guest details — by a waiter
  // scanning the table, or by an earlier round the guest placed before being asked. Fill
  // in whatever this round supplies that the sitting is still missing, so the details
  // land on the receipt and on every subsequent order's snapshot.
  //
  // Only ever fills blanks, never overwrites: a second person ordering from the same
  // table QR must not be able to replace the name the sitting is already under.
  const missing = {};
  if (guestName && !session.guestName) missing.guestName = guestName;
  if (guestPhone && !session.guestPhone) missing.guestPhone = guestPhone;
  if (Object.keys(missing).length > 0) {
    Object.assign(session, missing);
    await session.save();
  }

  return { table, session };
};

export const placeGuestOrder = async ({
  restaurantId,
  tableId,
  items,
  specialInstructions,
  // Set when the diner at the table is signed in — the controller resolves which of the
  // two identities applies before calling here, so exactly one of userId / guest details
  // ever arrives.
  userId,
  guestName,
  guestPhone,
  idempotencyKey,
}) => {
  const { session } = await getOrOpenSession({ restaurantId, tableId, guestName, guestPhone });

  // orderService.createOrder's dine-in branch (tableSessionId set) already does the item
  // snapshot/pricing, batchCount increment, TableSession.orders push and newOrder
  // notification — same path the waiter's POST /waiter/orders uses. userId/staffId are
  // left unset, exactly as the schema already allows; the guest's name/phone reach the
  // order through the session, which createOrder reads for exactly this case.
  const order = await orderService.createOrder({
    restaurantId,
    tableSessionId: session._id,
    userId,
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
