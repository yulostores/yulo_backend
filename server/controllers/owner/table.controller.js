import { z } from 'zod';
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

// What an owner may set on a table. The update used to `$set` the request body as sent, so a
// caller could overwrite the QR code block (token, status) or save a negative capacity.
const identifierSchema = z
  .string({ error: 'Add a table number' })
  .trim()
  .min(1, 'Add a table number')
  .max(30, 'Table number must be at most 30 characters');
const capacitySchema = z.number().int('Seats must be a whole number').min(1, 'Seats must be 1 or more').max(100, 'Seats must be 100 or fewer');
const createTableSchema = z.object({ identifier: identifierSchema, capacity: capacitySchema.nullish() });
const updateTableSchema = z
  .object({ identifier: identifierSchema.optional(), capacity: capacitySchema.nullish(), isActive: z.boolean().optional() })
  .strict();

const parse = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const flat = result.error.flatten();
    const first = Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid table details';
    throw new ApiError(400, 'VALIDATION_ERROR', first, flat);
  }
  return result.data;
};

export const createTable = asyncHandler(async (req, res) => {
  const { identifier, capacity } = parse(createTableSchema, req.body);
  // A deleted (deactivated) table keeps its number under the unique index, so adding the
  // same number again failed with a duplicate-key error forever. Bring the old one back.
  const restored = await Table.findOneAndUpdate(
    { restaurantId: req.restaurant._id, identifier, isActive: false },
    { $set: { isActive: true, ...(capacity != null && { capacity }) } },
    { new: true }
  );
  if (restored) return sendSuccess(res, 201, 'Table restored', { table: restored });

  const table = await Table.create({
    restaurantId: req.restaurant._id,
    identifier,
    capacity: capacity ?? undefined,
  });
  sendSuccess(res, 201, 'Table created', { table });
});

export const updateTable = asyncHandler(async (req, res) => {
  const updates = parse(updateTableSchema, req.body);
  const table = await Table.findOneAndUpdate(
    { _id: req.params.tableId, restaurantId: req.restaurant._id },
    { $set: updates },
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
