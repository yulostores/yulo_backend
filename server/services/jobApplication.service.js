import crypto from 'crypto';
import mongoose from 'mongoose';
import JobApplication from '../models/JobApplication.js';
import { nextSequence } from '../models/Counter.js';
import { env } from '../config/env.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import {
  APPLICATION_FEE_PAISE,
  APPLICATION_STATUSES,
  EDUCATION_LEVELS,
  JOB_DEPARTMENTS,
  MAX_AGE,
  MIN_AGE,
  educationLabel,
  findDepartment,
  findRole,
  MAX_ROLES_PER_APPLICATION,
} from '../config/careers.config.js';
import { ApiError } from '../utils/ApiError.js';
import { now } from '../utils/clock.js';
import { csvCell } from '../utils/csv.js';
import logger from '../utils/logger.js';
import { createRazorpayOrder, confirmCapturedPayment } from './payment.service.js';
import { recordStrayPayment } from './refund.service.js';
import { getRazorpay } from './razorpayClient.js';
import * as uploadService from './upload.service.js';
import { logActivity } from './activityLog.service.js';
import * as followUp from './applicationFollowUp.service.js';

// The careers portal: a public application form with a ₹100 form fee paid through Razorpay.
//
//   create   POST /api/careers/applications — saves the application unpaid (pending_payment),
//            uploads the résumé, opens a Razorpay order and hands the browser an access token.
//   pay      POST /api/careers/applications/:id/pay — a fresh Razorpay order for a retry.
//   verify   POST /api/careers/applications/:id/verify — Checkout's three fields; or the payment
//            webhook (settleFromWebhook). Either one makes it `new`, numbered YJ-000001.
//
// The super admin's list shows every application, paid or not (unpaid ones are marked).

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const sameHex = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ── Dates and age ─────────────────────────────────────────────────────────────

const IST_OFFSET_MS = 330 * 60 * 1000;

/** Today's calendar date in India, as midnight UTC (how dates of birth are stored). */
export const todayIst = () => {
  const ist = new Date(now().getTime() + IST_OFFSET_MS);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
};

/** Whole years between a date of birth and `on` (both midnight-UTC calendar dates). */
export const ageOn = (dateOfBirth, on = todayIst()) => {
  if (!dateOfBirth) return null;
  const dob = new Date(dateOfBirth);
  let age = on.getUTCFullYear() - dob.getUTCFullYear();
  const beforeBirthday =
    on.getUTCMonth() < dob.getUTCMonth() || (on.getUTCMonth() === dob.getUTCMonth() && on.getUTCDate() < dob.getUTCDate());
  if (beforeBirthday) age -= 1;
  return age;
};

const isoDate = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

// ── Catalogue ─────────────────────────────────────────────────────────────────

/** GET /api/careers/positions — what the form offers, and what applying costs. */
export const catalogue = () => ({
  departments: JOB_DEPARTMENTS.filter((d) => d.open !== false).map((d) => ({
    key: d.key,
    label: d.label,
    roles: d.roles.filter((r) => r.open !== false).map((r) => ({ key: r.key, label: r.label })),
  })),
  educationLevels: EDUCATION_LEVELS,
  feePaise: APPLICATION_FEE_PAISE,
  feeRupees: APPLICATION_FEE_PAISE / 100,
  minAge: MIN_AGE,
  maxAge: MAX_AGE,
});

// ── Views ─────────────────────────────────────────────────────────────────────

// Every role on the application ([role] for one saved before several were allowed).
const rolesOf = (a) => (a.roles?.length ? a.roles : a.role ? [a.role] : []);

const positionLabels = (a) => {
  const roleLabels = rolesOf(a).map((r) => findRole(a.department, r)?.label ?? r);
  return {
    departmentLabel: findDepartment(a.department)?.label ?? a.department,
    // All chosen roles, joined — what every screen shows as "Role".
    roleLabel: roleLabels.join(', '),
    roleLabels,
  };
};

/** What the applicant's browser sees. */
export const publicView = (a) => ({
  id: String(a._id),
  applicationNumber: a.applicationNumber ?? null,
  paid: a.payment?.status === 'paid',
  fullName: a.fullName,
  ...positionLabels(a),
  feePaise: a.payment?.amountPaise ?? APPLICATION_FEE_PAISE,
  submittedAt: a.submittedAt ?? null,
});

const resumeView = (r) =>
  r ? { name: r.name ?? 'resume.pdf', mimeType: r.mimeType ?? 'application/pdf', size: r.size ?? null, uploadedAt: r.uploadedAt ?? null } : null;

/** A row in the admin list. */
export const adminListView = (a) => ({
  _id: String(a._id),
  applicationNumber: a.applicationNumber ?? null,
  fullName: a.fullName,
  phone: a.phone,
  dateOfBirth: isoDate(a.dateOfBirth),
  age: ageOn(a.dateOfBirth),
  gender: a.gender,
  city: a.city,
  department: a.department,
  role: a.role,
  roles: rolesOf(a),
  ...positionLabels(a),
  expectedSalaryMin: a.expectedSalaryMin,
  expectedSalaryMax: a.expectedSalaryMax,
  hasResume: !!a.resume?.url,
  status: a.status,
  paid: a.payment?.status === 'paid',
  submittedAt: a.submittedAt ?? null,
  createdAt: a.createdAt,
  ...followUp.followUpView(a),
});

/** The full record for the admin detail screen. */
export const adminDetailView = (a) => ({
  ...adminListView(a),
  alternatePhone: a.alternatePhone ?? null,
  currentSalary: a.currentSalary ?? null,
  availableFrom: isoDate(a.availableFrom),
  education: a.education ?? null,
  educationLabel: a.education ? educationLabel(a.education) : null,
  experienceYears: a.experienceYears ?? null,
  experience: a.experience ?? null,
  resume: resumeView(a.resume),
  statusChangedAt: a.statusChangedAt ?? null,
  notes: (a.notes ?? [])
    .map((n) => ({ _id: String(n._id), text: n.text, status: n.status ?? null, by: n.by ? String(n.by) : null, at: n.at }))
    .reverse(),
  payment: {
    amountPaise: a.payment?.amountPaise ?? null,
    status: a.payment?.status ?? 'pending',
    razorpayPaymentId: a.payment?.razorpayPaymentId ?? null,
    confirmedVia: a.payment?.confirmedVia ?? null,
    paidAt: a.payment?.paidAt ?? null,
  },
});

// ── Create ────────────────────────────────────────────────────────────────────

// A PDF starts with "%PDF-" — the browser's mime type is the uploader's say-so, the bytes are not.
const looksLikePdf = (buffer) => Buffer.isBuffer(buffer) && buffer.subarray(0, 5).toString('latin1') === '%PDF-';

/**
 * `fields` is the controller's validated body (dates already Date objects). `file` is multer's
 * résumé, if one was attached. Returns { application, accessToken, razorpayOrder, paymentSimulated }.
 */
export const createApplication = async (fields, file) => {
  // Every role must be an open one in the chosen (open) position.
  const department = findDepartment(fields.department);
  const roles = fields.roles?.length ? fields.roles : [fields.role];
  const offered = (key) => {
    const r = findRole(fields.department, key);
    return r && r.open !== false;
  };
  if (!department || department.open === false || !roles.length || !roles.every(offered)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Choose a role from the selected position', {
      fieldErrors: { role: ['Choose a role from the selected position'] },
    });
  }
  if (roles.length > MAX_ROLES_PER_APPLICATION) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Choose at most ${MAX_ROLES_PER_APPLICATION} roles`, {
      fieldErrors: { role: [`Choose at most ${MAX_ROLES_PER_APPLICATION} roles`] },
    });
  }
  fields = { ...fields, roles, role: roles[0] };
  const age = ageOn(fields.dateOfBirth);
  if (age === null || age < MIN_AGE || age > MAX_AGE) {
    throw new ApiError(400, 'VALIDATION_ERROR', `Applicants must be between ${MIN_AGE} and ${MAX_AGE} years old`, {
      fieldErrors: { dateOfBirth: [`You must be between ${MIN_AGE} and ${MAX_AGE} years old`] },
    });
  }
  if (fields.availableFrom && fields.availableFrom < todayIst()) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'The joining date cannot be in the past', {
      fieldErrors: { availableFrom: ['Pick today or a later date'] },
    });
  }
  if (file && (file.mimetype !== 'application/pdf' || !looksLikePdf(file.buffer))) {
    throw new ApiError(400, 'INVALID_FILE_TYPE', 'The resume must be a PDF file');
  }

  // One live application per person per role: a second paid one for the same role is refused
  // up front, so nobody pays the fee twice by mistake. A rejected application can reapply.
  // With several roles: refused if any of them is already in a live application.
  const existing = await JobApplication.findOne({
    phone: fields.phone,
    $or: [{ role: { $in: roles } }, { roles: { $in: roles } }],
    'payment.status': 'paid',
    status: { $ne: 'rejected' },
  })
    .select('department role roles')
    .lean();
  if (existing) {
    const taken = rolesOf(existing).filter((r) => roles.includes(r)).map((r) => findRole(existing.department, r)?.label ?? r);
    throw new ApiError(
      409,
      'ALREADY_APPLIED',
      `You have already applied for ${taken.join(', ') || 'this role'} with this mobile number`
    );
  }

  const accessToken = crypto.randomBytes(32).toString('hex');
  const application = new JobApplication({
    ...fields,
    status: 'pending_payment',
    accessTokenHash: sha256(accessToken),
    payment: { amountPaise: APPLICATION_FEE_PAISE, status: 'pending' },
  });

  if (file) {
    let uploaded;
    try {
      uploaded = await uploadService.uploadBuffer({
        buffer: file.buffer,
        folder: `yulostores/careers/${application._id}`,
        // No extension — raw assets are addressed without one (see owner/document.controller.js).
        publicId: `resume_${Date.now()}`,
        resourceType: 'raw',
      });
    } catch (err) {
      logger.error({ applicationId: String(application._id), size: file.size, err: err?.message ?? String(err) }, 'Resume upload failed');
      throw new ApiError(502, 'UPLOAD_FAILED', 'Sorry, we could not save your resume right now. Please try again in a moment.');
    }
    application.resume = {
      url: uploaded.secureUrl,
      publicId: uploaded.publicId,
      resourceType: 'raw',
      name: file.originalname,
      mimeType: 'application/pdf',
      size: file.size,
      uploadedAt: now(),
    };
  }

  try {
    await application.save();
  } catch (err) {
    if (application.resume?.publicId) await uploadService.deleteAsset(application.resume.publicId, 'raw').catch(() => {});
    throw err;
  }

  const razorpayOrder = await openOrder(application);
  return {
    application: publicView(application),
    accessToken,
    razorpayOrder,
    paymentSimulated: !razorpayOrder && paymentSimulationEnabled,
  };
};

// A Razorpay order for the fee, stamped onto the application (any earlier one kept in history,
// so a late payment on it is still recognised as this application's).
const openOrder = async (application) => {
  const razorpayOrder = await createRazorpayOrder({
    amountPaise: application.payment.amountPaise,
    receipt: `job_${application._id}`,
    notes: { kind: 'job_application', applicationId: String(application._id) },
  });
  if (razorpayOrder) {
    await JobApplication.updateOne(
      { _id: application._id },
      {
        $set: { 'payment.razorpayOrderId': razorpayOrder.id },
        $addToSet: { 'payment.razorpayOrderHistory': razorpayOrder.id },
      }
    );
  }
  return razorpayOrder;
};

// ── Access (no accounts: the token from create) ───────────────────────────────

const loadOwned = async (id, token) => {
  if (!mongoose.isValidObjectId(id) || typeof token !== 'string' || !token) {
    throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  }
  const application = await JobApplication.findById(id).select('+accessTokenHash').lean();
  if (!application || !sameHex(application.accessTokenHash, sha256(token))) {
    throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  }
  return application;
};

/** GET /api/careers/applications/:id */
export const getOwned = async (id, token) => publicView(await loadOwned(id, token));

/** POST /api/careers/applications/:id/pay — a new Razorpay order for an unpaid application. */
export const retryPayment = async (id, token) => {
  const application = await loadOwned(id, token);
  if (application.payment?.status === 'paid') {
    throw new ApiError(409, 'ALREADY_PAID', 'The form fee for this application is already paid');
  }
  const razorpayOrder = await openOrder(application);
  return { application: publicView(application), razorpayOrder, paymentSimulated: !razorpayOrder && paymentSimulationEnabled };
};

// ── Payment ───────────────────────────────────────────────────────────────────

const orderIdsOf = (a) => new Set([a.payment?.razorpayOrderId, ...(a.payment?.razorpayOrderHistory ?? [])].filter(Boolean));

const refuse = async (application, { payment, reason }, kind = 'job_application_payment_refused') => {
  logger.error({ applicationId: String(application._id), razorpayPaymentId: payment?.id, reason }, 'Job application payment refused');
  if (payment?.status === 'captured') {
    await recordStrayPayment({ kind, payment, jobApplicationId: application._id, reason });
  }
};

const formatNumber = (n) => `YJ-${String(n).padStart(6, '0')}`;

// The one place an application becomes paid. Conditional on still being unpaid, so a verify and
// a webhook racing each other count one payment; the loser, if it was a different payment, is
// owed back.
const markPaid = async (application, payment, via) => {
  const number = formatNumber(await nextSequence('job_application'));
  const at = now();
  const updated = await JobApplication.findOneAndUpdate(
    { _id: application._id, 'payment.status': 'pending' },
    {
      $set: {
        applicationNumber: number,
        status: 'new',
        statusChangedAt: at,
        submittedAt: at,
        'payment.status': 'paid',
        'payment.razorpayPaymentId': payment?.id ?? null,
        'payment.confirmedVia': via,
        'payment.paidAt': at,
        // Paid after an admin deleted it as unpaid: it comes back (applicationFollowUp.service.js).
        deletedAt: null,
        deletedBy: null,
      },
    },
    { new: true }
  ).lean();
  if (updated) return { application: updated };
  const current = await JobApplication.findById(application._id).lean();
  if (payment?.id && current?.payment?.razorpayPaymentId !== payment.id) {
    await refuse(current, { payment: await withGatewayState(payment), reason: 'A second payment for an application already paid' }, 'job_application_duplicate_payment');
    return { application: current, duplicate: true };
  }
  return { application: current };
};

// The verify call only knows a payment's id — what Razorpay says about it decides whether it is
// money owed back (captured) or an authorisation left to lapse.
const withGatewayState = async (payment) => {
  if (payment?.status) return payment;
  try {
    return (await getRazorpay()?.payments.fetch(payment.id)) ?? payment;
  } catch (err) {
    logger.error({ razorpayPaymentId: payment?.id, err: err?.error?.description ?? err?.message }, 'Could not fetch a duplicate job application payment');
    return payment;
  }
};

// One payment, from the verify call or the webhook → the application.
const settle = async (application, payment, via) => {
  if (application.payment?.status === 'paid') {
    if (application.payment.razorpayPaymentId !== payment.id) {
      const second = await withGatewayState(payment);
      await refuse(application, { payment: second, reason: 'A second payment for an application already paid' }, 'job_application_duplicate_payment');
      return { application, duplicate: true };
    }
    return { application };
  }
  const result = await confirmCapturedPayment({
    paymentId: payment.id,
    razorpayOrderId: payment.order_id,
    expectedPaise: application.payment.amountPaise,
  });
  if (!result.ok) {
    await refuse(application, result);
    return { refused: true, reason: result.reason };
  }
  return markPaid(application, result.payment, via);
};

/** POST /api/careers/applications/:id/verify */
export const verifyPayment = async (id, token, body) => {
  const application = await loadOwned(id, token);
  if (!orderIdsOf(application).has(body.razorpay_order_id)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'This payment does not belong to this application');
  }
  if (!env.RAZORPAY_KEY_SECRET) throw new ApiError(503, 'PAYMENT_GATEWAY_UNAVAILABLE', 'Payment verification is not configured');
  const expected = hmacHex(`${body.razorpay_order_id}|${body.razorpay_payment_id}`, env.RAZORPAY_KEY_SECRET);
  if (!sameHex(expected, body.razorpay_signature)) {
    throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'Payment signature verification failed');
  }
  const result = await settle(application, { id: body.razorpay_payment_id, order_id: body.razorpay_order_id }, 'verify');
  if (result.refused) throw new ApiError(400, 'PAYMENT_VERIFICATION_FAILED', 'This payment could not be accepted for this application');
  if (result.duplicate) {
    throw new ApiError(409, 'ALREADY_PAID', 'This application was already paid — the second payment will be refunded');
  }
  return publicView(result.application);
};

/** The payment webhook's branch for job applications. False when the order isn't one. */
export const settleFromWebhook = async (payment) => {
  const application = await JobApplication.findOne({
    $or: [{ 'payment.razorpayOrderId': payment.order_id }, { 'payment.razorpayOrderHistory': payment.order_id }],
  }).lean();
  if (!application) return false;
  await settle(application, payment, 'webhook');
  return true;
};

export const isApplicationOrder = (razorpayOrderId) =>
  JobApplication.exists({
    $or: [{ 'payment.razorpayOrderId': razorpayOrderId }, { 'payment.razorpayOrderHistory': razorpayOrderId }],
  });

/** Local development only (ALLOW_PAYMENT_SIMULATION, never production). */
export const simulatePayment = async (id, token) => {
  if (!paymentSimulationEnabled) throw new ApiError(404, 'NOT_FOUND', 'Not found');
  const application = await loadOwned(id, token);
  if (application.payment?.status === 'paid') return publicView(application);
  const { application: updated } = await markPaid(application, null, 'simulation');
  return publicView(updated);
};

// ── Admin ─────────────────────────────────────────────────────────────────────

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const listFilter = ({ q, department, role, status, gender, city, called, interest } = {}) => {
  const filter = followUp.followUpFilter({ called, interest });
  if (status) filter.status = status;
  if (department) filter.department = department;
  // A role matches any application that names it, first or not.
  if (role) filter.$and = [{ $or: [{ role }, { roles: role }] }];
  if (gender) filter.gender = gender;
  if (city) filter.city = new RegExp(`^${escapeRegex(city.trim())}`, 'i');
  if (q?.trim()) {
    const text = q.trim();
    const digits = text.replace(/\D/g, '');
    const or = [{ fullName: new RegExp(escapeRegex(text), 'i') }, { applicationNumber: new RegExp(`^${escapeRegex(text)}`, 'i') }];
    if (digits.length >= 3) or.push({ phone: new RegExp(escapeRegex(digits)) }, { alternatePhone: new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  return filter;
};

/** GET /api/admin/job-applications */
export const adminList = async ({ page = 1, limit = 20, ...filters }) => {
  const filter = listFilter(filters);
  const [rows, total, counts] = await Promise.all([
    JobApplication.find(filter)
      .sort({ submittedAt: -1, createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    JobApplication.countDocuments(filter),
    JobApplication.aggregate([{ $match: { deletedAt: null } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  return {
    applications: rows.map(adminListView),
    total,
    page,
    limit,
    pages: Math.max(1, Math.ceil(total / limit)),
    counts: Object.fromEntries(APPLICATION_STATUSES.map((s) => [s, counts.find((c) => c._id === s)?.n ?? 0])),
  };
};

const loadForAdmin = async (id) => {
  const application = mongoose.isValidObjectId(id) ? await JobApplication.findOne({ _id: id, deletedAt: null }).lean() : null;
  if (!application) throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  return application;
};

/** GET /api/admin/job-applications/:id */
export const adminDetail = async (id) => adminDetailView(await loadForAdmin(id));

/** PATCH /api/admin/job-applications/:id/status  { status, note? } */
export const setStatus = async (id, adminId, { status, note }) => {
  const application = await loadForAdmin(id);
  if (application.payment?.status !== 'paid') {
    throw new ApiError(409, 'INVALID_STATE', 'This application has not paid the form fee yet');
  }
  const at = now();
  const update = { $set: { status, statusChangedAt: at } };
  if (note) update.$push = { notes: { text: note, status, by: adminId, at } };
  const updated = await JobApplication.findByIdAndUpdate(id, update, { new: true }).lean();
  await logActivity({ adminId, action: 'job_application_status', targetType: 'job_application', targetId: application._id, metadata: { from: application.status, to: status } });
  return adminDetailView(updated);
};

/** POST /api/admin/job-applications/:id/notes  { text } */
export const addNote = async (id, adminId, text) => {
  await loadForAdmin(id);
  const updated = await JobApplication.findByIdAndUpdate(
    id,
    { $push: { notes: { text, by: adminId, at: now() } } },
    { new: true }
  ).lean();
  return adminDetailView(updated);
};

/** The résumé as a document streamDocument() can serve. */
export const resumeDocument = async (id) => {
  const application = await loadForAdmin(id);
  if (!application.resume?.url) throw new ApiError(404, 'NOT_FOUND', 'This applicant did not upload a resume');
  return { ...application.resume, type: 'resume' };
};

const EXPORT_LIMIT = 5000;

/** GET /api/admin/job-applications/export.csv — the filtered list, newest first. */
export const exportCsv = async (filters) => {
  const rows = await JobApplication.find(listFilter(filters)).sort({ submittedAt: -1, createdAt: -1 }).limit(EXPORT_LIMIT).lean();
  const header = [
    'Application No', 'Submitted', 'Full Name', 'Mobile', 'Alternate Mobile', 'Date of Birth', 'Age', 'Gender', 'City',
    'Position', 'Roles', 'Expected Salary Min', 'Expected Salary Max', 'Current Salary', 'Available From',
    'Education', 'Experience (years)', 'Experience', 'Resume', 'Status', 'Fee Paid', 'Called', 'Interest',
  ];
  const lines = rows.map((a) => {
    const labels = positionLabels(a);
    return [
      a.applicationNumber ?? '', a.submittedAt ? a.submittedAt.toISOString() : '', a.fullName, a.phone, a.alternatePhone ?? '',
      isoDate(a.dateOfBirth), ageOn(a.dateOfBirth), a.gender, a.city, labels.departmentLabel, labels.roleLabel,
      a.expectedSalaryMin, a.expectedSalaryMax, a.currentSalary ?? '', isoDate(a.availableFrom) ?? '',
      a.education ? educationLabel(a.education) : '', a.experienceYears ?? '', a.experience ?? '',
      a.resume?.url ? 'Yes' : 'No', a.status, a.payment?.status === 'paid' ? 'Yes' : 'No',
      a.followUp?.calledAt ? 'Yes' : 'No', INTEREST_LABEL[a.followUp?.interest] ?? '',
    ].map(csvCell).join(',');
  });
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
};

const MODEL = JobApplication;
const TARGET = 'job_application';
const INTEREST_LABEL = { interested: 'Interested', not_interested: 'Not interested' };

// ── Follow-up: called, interested / not, delete unpaid (services/applicationFollowUp.service.js) ──

/** POST …/:id/call { called } */
export const markCalled = async (id, adminId, called) => adminDetailView(await followUp.setCalled(MODEL, id, adminId, called));

/** PATCH …/:id/interest { interest } */
export const setInterest = async (id, adminId, interest) => adminDetailView(await followUp.setInterest(MODEL, id, adminId, interest));

/** DELETE …/:id — only while the fee is unpaid. */
export const deleteApplication = (id, adminId) => followUp.deleteUnpaid(MODEL, id, adminId, TARGET);
