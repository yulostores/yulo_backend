import { z } from 'zod';
import * as jobs from '../../services/jobApplication.service.js';
import { streamDocument } from '../../services/restaurantDocument.service.js';
import { APPLICATION_STATUSES, GENDERS, JOB_DEPARTMENTS, REVIEW_STATUSES } from '../../config/careers.config.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

const parseOr400 = (schema, input, message = 'Invalid request') => {
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new ApiError(400, 'VALIDATION_ERROR', message, parsed.error.flatten());
  return parsed.data;
};

const blank = (v) => (v === '' || v === 'all' ? undefined : v);

const filtersSchema = z.object({
  q: z.preprocess(blank, z.string().trim().max(100).optional()),
  department: z.preprocess(blank, z.enum(JOB_DEPARTMENTS.map((d) => d.key)).optional()),
  role: z.preprocess(blank, z.string().trim().max(60).optional()),
  status: z.preprocess(blank, z.enum(APPLICATION_STATUSES).optional()),
  gender: z.preprocess(blank, z.enum(GENDERS).optional()),
  city: z.preprocess(blank, z.string().trim().max(80).optional()),
  called: z.preprocess(blank, z.enum(['yes', 'no']).optional()),
  interest: z.preprocess(blank, z.enum(['interested', 'not_interested', 'none']).optional()),
});

const listSchema = filtersSchema.extend({
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** GET /api/admin/job-applications */
export const list = asyncHandler(async (req, res) => {
  const query = parseOr400(listSchema, req.query, 'Invalid filters');
  sendSuccess(res, 200, 'Job applications', await jobs.adminList(query));
});

/** GET /api/admin/job-applications/export.csv */
export const exportCsv = asyncHandler(async (req, res) => {
  const filters = parseOr400(filtersSchema.passthrough(), req.query, 'Invalid filters');
  const csv = await jobs.exportCsv(filters);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="job-applications-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(`﻿${csv}`);
});

/** GET /api/admin/job-applications/:id */
export const getOne = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Job application', { application: await jobs.adminDetail(req.params.id) });
});

const statusSchema = z
  .object({
    status: z.enum(REVIEW_STATUSES, { message: 'Choose a status' }),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

/** PATCH /api/admin/job-applications/:id/status */
export const setStatus = asyncHandler(async (req, res) => {
  const body = parseOr400(statusSchema, req.body);
  sendSuccess(res, 200, 'Status updated', { application: await jobs.setStatus(req.params.id, req.user._id, body) });
});

/** POST /api/admin/job-applications/:id/notes */
export const addNote = asyncHandler(async (req, res) => {
  const { text } = parseOr400(z.object({ text: z.string().trim().min(1, 'Write a note').max(1000) }).strict(), req.body);
  sendSuccess(res, 201, 'Note added', { application: await jobs.addNote(req.params.id, req.user._id, text) });
});

/** GET /api/admin/job-applications/:id/resume — the PDF, streamed through the API. */
export const resumeFile = asyncHandler(async (req, res) => {
  await streamDocument(await jobs.resumeDocument(req.params.id), res);
});

// ── Follow-up (services/applicationFollowUp.service.js) ───────────────────────

/** POST …/:id/call { called } — the Call button marks it called (green); false undoes it. */
export const markCalled = asyncHandler(async (req, res) => {
  const { called } = parseOr400(z.object({ called: z.boolean().default(true) }).strict(), req.body ?? {});
  sendSuccess(res, 200, called ? 'Marked called' : 'Marked not called', { application: await jobs.markCalled(req.params.id, req.user._id, called) });
});

/** PATCH …/:id/interest { interest: 'interested' | 'not_interested' | null } */
export const setInterest = asyncHandler(async (req, res) => {
  const { interest } = parseOr400(z.object({ interest: z.enum(['interested', 'not_interested']).nullable() }).strict(), req.body);
  sendSuccess(res, 200, 'Saved', { application: await jobs.setInterest(req.params.id, req.user._id, interest) });
});

/** DELETE …/:id — only an entry whose form fee is unpaid. */
export const remove = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Application deleted', await jobs.deleteApplication(req.params.id, req.user._id));
});
