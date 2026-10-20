import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import { ApiError } from '../utils/ApiError.js';

export const scanTable = async ({ restaurantId, qrToken, staffId }) => {
  // qrToken is the tableId embedded in the QR URL
  const table = await Table.findOne({
    _id: qrToken,
    restaurantId,
    isActive: true,
  }).lean();

  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found or invalid QR code');
  if (table.qrCode?.status === 'void') throw new ApiError(400, 'QR_VOID', 'QR code has been voided');

  // A sitting whose guest is paying online is returned as it is (the waiter can release the
  // payment or settle at the counter) — never a second sitting at the same table.
  let session = await TableSession.findOne({ tableId: table._id, status: { $in: ['open', 'bill_requested'] } }).sort({ openedAt: -1 });
  if (!session) {
    session = await TableSession.create({ restaurantId, tableId: table._id, waiterId: staffId });
  }

  // Rounds still awaiting the restaurant's approval stay off the floor (same rule as the
  // waiter's session list in controllers/staff/waiter.controller.js).
  await session.populate({ path: 'orders', match: { status: { $ne: 'placed' } } });

  return { table, session };
};
