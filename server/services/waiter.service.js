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

  let session = await TableSession.findOne({ tableId: table._id, status: 'open' });
  if (!session) {
    session = await TableSession.create({ restaurantId, tableId: table._id, waiterId: staffId });
  }

  // Rounds still awaiting the restaurant's approval stay off the floor (same rule as the
  // waiter's session list in controllers/staff/waiter.controller.js).
  await session.populate({ path: 'orders', match: { status: { $ne: 'placed' } } });

  return { table, session };
};
