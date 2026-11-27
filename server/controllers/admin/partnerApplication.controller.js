import { z } from 'zod';
import * as partners from '../../services/partnerApplication.service.js';
import { PARTNER_APPLICATION_STATUSES, PARTNER_CATEGORIES, PARTNER_REVIEW_STATUSES } from '../../config/partnerApplication.config.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Super admin — "Choose your business" applications from the careers portal.

const parseOr400 = (schema, input, message = 'Invalid request') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

const blank = (v) => (v === '' || v === 'all' ? undefined : v);

const filtersSchema = z.object({
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  category: z.preprocess(blank, z.enum(PARTNER_CATEGORIES.map((c) => c.key)).optional()),
  status: z.preprocess(blank, z.enum(PARTNER_APPLICATION_STATUSES).optional()),
  city: z.preprocess(blank, z.string().trim().max(80).optional()),
  called: z.preprocess(blank, z.enum(['yes', 'no']).optional()),
  interest: z.preprocess(blank, z.enum(['interested', 'not_interested', 'none']).optional()),
});

const listSchema = filtersSchema.extend({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/admin/partner-applications */
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Seller applications', await partners.adminList(parseOr400(listSchema, req.query, 'Invalid filters')));
});

/** GET /api/admin/partner-applications/export.csv */
export const exportCsv = asyncHandler(async (req, res) => {
  const csv = await partners.exportCsv(parseOr400(filtersSchema.passthrough(), req.query, 'Invalid filters'));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="seller-applications-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(`﻿${csv}`);
});

/** GET /api/admin/partner-applications/:id */
export const getOne = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Seller application', { application: await partners.adminDetail(req.params.id) });
});

const statusSchema = z
  .object({ status: z.enum(PARTNER_REVIEW_STATUSES, { message: 'Choose a status' }), note: z.string().trim().max(1000).optional() })
  .strict();

/** PATCH /api/admin/partner-applications/:id/status */
export const setStatus = asyncHandler(async (req, res) => {
  const body = parseOr400(statusSchema, req.body);
  sendSuccess(res, 200, 'Status updated', { application: await partners.setStatus(req.params.id, req.user._id, body) });
});

/** POST /api/admin/partner-applications/:id/notes */
export const addNote = asyncHandler(async (req, res) => {
  const { text } = parseOr400(z.object({ text: z.string().trim().min(1, 'Write a note').max(1000) }).strict(), req.body);
  sendSuccess(res, 201, 'Note added', { application: await partners.addNote(req.params.id, req.user._id, text) });
});

// ── Follow-up (services/applicationFollowUp.service.js) ───────────────────────

/** POST …/:id/call { called } — the Call button marks it called (green); false undoes it. */
export const markCalled = asyncHandler(async (req, res) => {
  const { called } = parseOr400(z.object({ called: z.boolean().default(true) }).strict(), req.body ?? {});
  sendSuccess(res, 200, called ? 'Marked called' : 'Marked not called', { application: await partners.markCalled(req.params.id, req.user._id, called) });
});

/** PATCH …/:id/interest { interest: 'interested' | 'not_interested' | null } */
export const setInterest = asyncHandler(async (req, res) => {
  const { interest } = parseOr400(z.object({ interest: z.enum(['interested', 'not_interested']).nullable() }).strict(), req.body);
  sendSuccess(res, 200, 'Saved', { application: await partners.setInterest(req.params.id, req.user._id, interest) });
});

/** DELETE …/:id — only an entry whose form fee is unpaid. */
export const remove = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Application deleted', await partners.deleteApplication(req.params.id, req.user._id));
});
