import mongoose from 'mongoose';
import { z } from 'zod';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import * as payoutBatchService from '../../services/payoutBatch.service.js';

// Weekly restaurant payouts by bank bulk upload — see services/payoutBatch.service.js for the
// whole flow (batch → file → upload in net banking → reconcile → retry / carry forward).

const parse = (schema, data) => {
  const r = schema.safeParse(data ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid request', r.error.flatten());
  return r.data;
};
const objectId = z.string().refine(mongoose.isValidObjectId, 'Invalid id');

// GET /api/admin/finance/payout-batches?status&page&limit
export const list = asyncHandler(async (req, res) => {
  const q = parse(
    z.object({
      status: z.enum(['created', 'downloaded', 'partially_reconciled', 'reconciled', 'cancelled']).optional(),
      page: z.coerce.number().int().min(1).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    }),
    req.query
  );
  sendSuccess(res, 200, 'Payout batches', await payoutBatchService.listBatches(q));
});

// POST /api/admin/finance/payout-batches — body { settlementIds?: [...], note? }. Without ids,
// every approved settlement goes on the batch.
export const create = asyncHandler(async (req, res) => {
  const body = parse(z.object({ settlementIds: z.array(objectId).optional(), note: z.string().max(300).optional() }), req.body);
  const result = await payoutBatchService.createBatch({ ...body, adminId: req.user._id });
  sendSuccess(res, 201, 'Payout batch created', result);
});

// GET /api/admin/finance/payout-batches/:id
export const detail = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Payout batch', await payoutBatchService.getBatchDetail(req.params.id));
});

// GET /api/admin/finance/payout-batches/:id/file — the bulk-payment file to upload to net
// banking. Holds full account numbers: audit-logged, never cached.
export const file = asyncHandler(async (req, res) => {
  const { fileName, mime, content } = await payoutBatchService.buildBatchFile(req.params.id, req.user._id);
  res.set('Content-Type', mime);
  res.set('Content-Disposition', `attachment; filename="${fileName}"`);
  res.set('Cache-Control', 'no-store');
  res.send(content);
});

// POST /api/admin/finance/payout-batches/:id/reconcile — body { rows: [{ reference, status,
// utr?, reason? }] } or { csv: "<the bank's response file>" }.
export const reconcile = asyncHandler(async (req, res) => {
  const body = parse(
    z
      .object({
        rows: z
          .array(
            z.object({
              reference: z.string().min(1),
              status: z.enum(['paid', 'failed', 'returned']),
              utr: z.string().trim().min(4).max(40).optional(),
              reason: z.string().max(300).optional(),
            })
          )
          .optional(),
        csv: z.string().max(2_000_000).optional(),
      })
      .refine((b) => b.rows?.length || b.csv, 'Provide rows or csv'),
    req.body
  );
  sendSuccess(res, 200, 'Batch reconciled', await payoutBatchService.reconcileBatch(req.params.id, body, req.user._id));
});

// POST /api/admin/finance/payout-batches/:id/cancel — body { confirmNotUploaded: true }.
export const cancel = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Batch cancelled', {
    batch: await payoutBatchService.cancelBatch(req.params.id, req.body ?? {}, req.user._id),
  });
});

// PATCH /api/admin/finance/settlements/:id/retry-payout — a failed payout back to approved.
export const retrySettlement = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Payout will be retried on the next batch', {
    settlement: await payoutBatchService.retrySettlement(req.params.id, req.user._id),
  });
});

// PATCH /api/admin/finance/settlements/:id/carry-forward — a failed payout's amount moved into
// the restaurant's next settlement.
export const carryForward = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Carried forward to the next settlement', await payoutBatchService.carryForwardFailed(req.params.id, req.user._id));
});
