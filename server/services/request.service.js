import Request from '../models/Request.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import { ApiError } from '../utils/ApiError.js';
import { notifyService } from './notify.service.js';

export const REQUEST_TYPES = ['call_waiter', 'water', 'bill', 'other'];

const VALID_TRANSITIONS = {
  pending: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
};

// A request is raised against a table, not a session — a guest can ask for water
// before a waiter has opened one. When one IS open, we link it anyway so staff see
// which active session it belongs to.
export const createRequest = async ({ restaurantId, tableId, type, note, userId }) => {
  const table = await Table.findOne({ _id: tableId, restaurantId, isActive: true }).lean();
  if (!table) throw new ApiError(404, 'NOT_FOUND', 'Table not found');

  const session = await TableSession.findOne({ tableId, status: 'open' }).select('_id').lean();

  const request = await Request.create({
    restaurantId,
    tableId,
    tableSessionId: session?._id ?? null,
    userId: userId ?? null,
    type,
    note: note ?? '',
  });

  notifyService.newRequest(request);
  return request;
};

// Staff/owner board — every request today by default, newest-first within status
// (pending/acknowledged surfaced before resolved so the floor sees what's outstanding).
export const listForRestaurant = async (restaurantId, { status } = {}) => {
  const filter = { restaurantId };
  if (status) filter.status = status;
  return Request.find(filter)
    .sort({ status: 1, createdAt: -1 })
    .limit(200)
    .populate('tableId', 'identifier')
    .lean();
};

// The guest's own view — scoped to the table they scanned, not to an account (raising
// "need water" isn't gated behind login). Recent-first, capped to what's still relevant
// on a phone screen.
export const listForTable = async (restaurantId, tableId) => {
  if (!tableId) throw new ApiError(400, 'VALIDATION_ERROR', 'tableId is required');
  return Request.find({ restaurantId, tableId }).sort({ createdAt: -1 }).limit(20).lean();
};

export const updateStatus = async ({ restaurantId, requestId, status, staffId }) => {
  const request = await Request.findOne({ _id: requestId, restaurantId });
  if (!request) throw new ApiError(404, 'NOT_FOUND', 'Request not found');

  const allowed = VALID_TRANSITIONS[request.status];
  if (!allowed?.includes(status)) {
    throw new ApiError(
      400,
      'INVALID_TRANSITION',
      `Cannot transition from '${request.status}' to '${status}'`
    );
  }

  request.status = status;
  if (status === 'resolved') {
    request.resolvedAt = new Date();
    request.resolvedBy = staffId ?? null;
  }
  await request.save();

  notifyService.requestStatusUpdated(request);
  return request;
};
