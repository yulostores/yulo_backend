import Table from '../../models/Table.js';
import * as qrService from '../../services/qr.service.js';
import { notifyService } from '../../services/notify.service.js';
import { env } from '../../config/env.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const listTables = asyncHandler(async (req, res) => {
  const tables = await Table.find({ restaurantId: req.restaurant._id, isActive: true }).lean();
  sendSuccess(res, 200, 'Tables', { tables });
});

export const createTable = asyncHandler(async (req, res) => {
  const { identifier, capacity } = req.body;
  const table = await Table.create({
    restaurantId: req.restaurant._id,
    identifier,
    capacity,
  });
  sendSuccess(res, 201, 'Table created', { table });
});

export const updateTable = asyncHandler(async (req, res) => {
  const table = await Table.findOneAndUpdate(
    { _id: req.params.tableId, restaurantId: req.restaurant._id },
    { $set: req.body },
    { new: true }
  );
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');
  sendSuccess(res, 200, 'Table updated', { table });
});

export const deleteTable = asyncHandler(async (req, res) => {
  const table = await Table.findOneAndUpdate(
    { _id: req.params.tableId, restaurantId: req.restaurant._id },
    { $set: { isActive: false } },
    { new: true }
  );
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');
  sendSuccess(res, 200, 'Table deactivated', null);
});

export const generateQR = asyncHandler(async (req, res) => {
  const table = await Table.findOne({
    _id: req.params.tableId,
    restaurantId: req.restaurant._id,
    isActive: true,
  }).lean();
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');

  const qr = await qrService.generateTableQR({
    restaurantId: req.restaurant._id.toString(),
    tableId: table._id.toString(),
    tableNumber: table.identifier,
    baseUrl: env.MENU_APP_URL || env.CUSTOMER_APP_URL || 'http://localhost:5174',
  });

  sendSuccess(res, 200, 'QR code generated', { qr });
});

export const voidQR = asyncHandler(async (req, res) => {
  const table = await Table.findOneAndUpdate(
    { _id: req.params.tableId, restaurantId: req.restaurant._id },
    { $set: { 'qrCode.status': 'void' } },
    { new: true }
  );
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');

  notifyService.tableStatusChanged(
    req.restaurant._id.toString(),
    table,
    'qr_voided'
  );

  sendSuccess(res, 200, 'QR voided', { table });
});
