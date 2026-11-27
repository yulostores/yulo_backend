import crypto from 'crypto';
import mongoose from 'mongoose';
import PartnerApplication from '../models/PartnerApplication.js';
import { nextSequence } from '../models/Counter.js';
import { env } from '../config/env.js';
import { paymentSimulationEnabled } from '../config/payments.config.js';
import {
  MAX_EMPLOYEES,
  PARTNER_APPLICATION_FEE_PAISE,
  PARTNER_APPLICATION_STATUSES,
  PARTNER_CATEGORIES,
  PARTNER_REVIEW_STATUSES,
  partnerCategoryLabel,
} from '../config/partnerApplication.config.js';
import { ApiError } from '../utils/ApiError.js';
import { now } from '../utils/clock.js';
import { csvCell } from '../utils/csv.js';
import logger from '../utils/logger.js';
import { createRazorpayOrder, confirmCapturedPayment } from './payment.service.js';
import { recordStrayPayment } from './refund.service.js';
import { getRazorpay } from './razorpayClient.js';
import { logActivity } from './activityLog.service.js';

// "Choose your business" on the careers portal: a shop applying to become a Yulo coupon partner,
// with a ₹100 form fee — the same flow as a job application (services/jobApplication.service.js):
//
//   create   POST /api/careers/partner-applications — saved unpaid (pending_payment), a Razorpay
//            order opened, and an access token handed to the browser.
//   pay      POST …/:id/pay — a fresh Razorpay order for a retry.
//   verify   POST …/:id/verify — Checkout's three fields; or the payment webhook
//            (settleFromWebhook). Either makes it `new`, numbered YB-000001.
//
// The super admin's Partner Applications page works the leads: contacted → onboarded / rejected.

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmacHex = (payload, secret) => crypto.createHmac('sha256', secret).update(payload).digest('hex');
const sameHex = (a, b) =>
  typeof a === 'string' && typeof b === 'string' && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

// ── Form ──────────────────────────────────────────────────────────────────────

/** GET /api/careers/partner-form — the categories and the fee. */
export const formInfo = () => ({
  categories: PARTNER_CATEGORIES,
  feePaise: PARTNER_APPLICATION_FEE_PAISE,
  feeRupees: PARTNER_APPLICATION_FEE_PAISE / 100,
  maxEmployees: MAX_EMPLOYEES,
});

// ── Views ─────────────────────────────────────────────────────────────────────

const categoryOf = (a) => partnerCategoryLabel(a.category, a.otherCategory);

/** What the applicant's browser sees. */
export const publicView = (a) => ({
  id: String(a._id),
  applicationNumber: a.applicationNumber ?? null,
  paid: a.payment?.status === 'paid',
  businessName: a.businessName,
  ownerName: a.ownerName,
  categoryLabel: categoryOf(a),
  feePaise: a.payment?.amountPaise ?? PARTNER_APPLICATION_FEE_PAISE,
  submittedAt: a.submittedAt ?? null,
});

/** A row in the admin list. */
export const adminListView = (a) => ({
  _id: String(a._id),
  applicationNumber: a.applicationNumber ?? null,
  businessName: a.businessName,
  category: a.category,
  otherCategory: a.otherCategory ?? null,
  categoryLabel: categoryOf(a),
  city: a.city,
  ownerName: a.ownerName,
  phone: a.phone,
  employees: a.employees,
  hasGst: a.hasGst,
  status: a.status,
  paid: a.payment?.status === 'paid',
  submittedAt: a.submittedAt ?? null,
  createdAt: a.createdAt,
});

/** The full record for the admin detail screen. */
export const adminDetailView = (a) => ({
  ...adminListView(a),
  address: a.address,
  alternatePhone: a.alternatePhone ?? null,
  questions: a.questions ?? null,
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

/** `fields` is the controller's validated body. Returns { application, accessToken, razorpayOrder, paymentSimulated }. */
export const createApplication = async (fields) => {
  if (fields.category === 'other' && !fields.otherCategory) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Tell us what kind of store it is', {
      fieldErrors: { otherCategory: ['Tell us what kind of store it is'] },
    });
  }
  // One live application per business mobile: a second paid one is refused up front, so nobody
  // pays the fee twice by mistake. A rejected business can apply again.
  const existing = await PartnerApplication.exists({ phone: fields.phone, 'payment.status': 'paid', status: { $ne: 'rejected' } });
  if (existing) {
    throw new ApiError(409, 'ALREADY_APPLIED', 'This mobile number has already applied — our team will call you');
  }

  const accessToken = crypto.randomBytes(32).toString('hex');
  const application = await PartnerApplication.create({
    ...fields,
    otherCategory: fields.category === 'other' ? fields.otherCategory : null,
    status: 'pending_payment',
    accessTokenHash: sha256(accessToken),
    payment: { amountPaise: PARTNER_APPLICATION_FEE_PAISE, status: 'pending' },
  });
  const razorpayOrder = await openOrder(application);
  return {
    application: publicView(application),
    accessToken,
    razorpayOrder,
    paymentSimulated: !razorpayOrder && paymentSimulationEnabled,
  };
};

const openOrder = async (application) => {
  const razorpayOrder = await createRazorpayOrder({
    amountPaise: application.payment.amountPaise,
    receipt: `partner_${application._id}`,
    notes: { kind: 'partner_application', applicationId: String(application._id) },
  });
  if (razorpayOrder) {
    await PartnerApplication.updateOne(
      { _id: application._id },
      { $set: { 'payment.razorpayOrderId': razorpayOrder.id }, $addToSet: { 'payment.razorpayOrderHistory': razorpayOrder.id } }
    );
  }
  return razorpayOrder;
};

// ── Access (no accounts: the token from create) ───────────────────────────────

const loadOwned = async (id, token) => {
  if (!mongoose.isValidObjectId(id) || typeof token !== 'string' || !token) {
    throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  }
  const application = await PartnerApplication.findById(id).select('+accessTokenHash').lean();
  if (!application || !sameHex(application.accessTokenHash, sha256(token))) {
    throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  }
  return application;
};

export const getOwned = async (id, token) => publicView(await loadOwned(id, token));

export const retryPayment = async (id, token) => {
  const application = await loadOwned(id, token);
  if (application.payment?.status === 'paid') throw new ApiError(409, 'ALREADY_PAID', 'The form fee is already paid');
  const razorpayOrder = await openOrder(application);
  return { application: publicView(application), razorpayOrder, paymentSimulated: !razorpayOrder && paymentSimulationEnabled };
};

// ── Payment ───────────────────────────────────────────────────────────────────

const orderIdsOf = (a) => new Set([a.payment?.razorpayOrderId, ...(a.payment?.razorpayOrderHistory ?? [])].filter(Boolean));

const refuse = async (application, { payment, reason }, kind = 'partner_application_payment_refused') => {
  logger.error({ partnerApplicationId: String(application._id), razorpayPaymentId: payment?.id, reason }, 'Partner application payment refused');
  if (payment?.status === 'captured') {
    await recordStrayPayment({ kind, payment, partnerApplicationId: application._id, reason });
  }
};

const formatNumber = (n) => `YB-${String(n).padStart(6, '0')}`;

const markPaid = async (application, payment, via) => {
  const number = formatNumber(await nextSequence('partner_application'));
  const at = now();
  const updated = await PartnerApplication.findOneAndUpdate(
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
      },
    },
    { new: true }
  ).lean();
  if (updated) return { application: updated };
  const current = await PartnerApplication.findById(application._id).lean();
  if (payment?.id && current?.payment?.razorpayPaymentId !== payment.id) {
    await refuse(current, { payment: await withGatewayState(payment), reason: 'A second payment for an application already paid' }, 'partner_application_duplicate_payment');
    return { application: current, duplicate: true };
  }
  return { application: current };
};

const withGatewayState = async (payment) => {
  if (payment?.status) return payment;
  try {
    return (await getRazorpay()?.payments.fetch(payment.id)) ?? payment;
  } catch (err) {
    logger.error({ razorpayPaymentId: payment?.id, err: err?.error?.description ?? err?.message }, 'Could not fetch a duplicate partner application payment');
    return payment;
  }
};

const settle = async (application, payment, via) => {
  if (application.payment?.status === 'paid') {
    if (application.payment.razorpayPaymentId !== payment.id) {
      await refuse(application, { payment: await withGatewayState(payment), reason: 'A second payment for an application already paid' }, 'partner_application_duplicate_payment');
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
  if (result.duplicate) throw new ApiError(409, 'ALREADY_PAID', 'This application was already paid — the second payment will be refunded');
  return publicView(result.application);
};

/** The payment webhook's branch for partner applications. False when the order isn't one. */
export const settleFromWebhook = async (payment) => {
  const application = await PartnerApplication.findOne({
    $or: [{ 'payment.razorpayOrderId': payment.order_id }, { 'payment.razorpayOrderHistory': payment.order_id }],
  }).lean();
  if (!application) return false;
  await settle(application, payment, 'webhook');
  return true;
};

export const isPartnerApplicationOrder = (razorpayOrderId) =>
  PartnerApplication.exists({
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

const listFilter = ({ q, category, status, city } = {}) => {
  const filter = {};
  if (status) filter.status = status;
  if (category) filter.category = category;
  if (city) filter.city = new RegExp(`^${escapeRegex(city.trim())}`, 'i');
  if (q?.trim()) {
    const text = q.trim();
    const digits = text.replace(/\D/g, '');
    const or = [
      { businessName: new RegExp(escapeRegex(text), 'i') },
      { ownerName: new RegExp(escapeRegex(text), 'i') },
      { applicationNumber: new RegExp(`^${escapeRegex(text)}`, 'i') },
    ];
    if (digits.length >= 3) or.push({ phone: new RegExp(escapeRegex(digits)) }, { alternatePhone: new RegExp(escapeRegex(digits)) });
    filter.$or = or;
  }
  return filter;
};

/** GET /api/admin/partner-applications — newest first, with counts per status. */
export const adminList = async ({ page = 1, limit = 20, ...filters }) => {
  const p = Math.max(1, Number.parseInt(page, 10) || 1);
  const l = Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20));
  const filter = listFilter(filters);
  const [rows, total, counts] = await Promise.all([
    PartnerApplication.find(filter).sort({ submittedAt: -1, createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
    PartnerApplication.countDocuments(filter),
    PartnerApplication.aggregate([{ $match: listFilter({ ...filters, status: undefined }) }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
  ]);
  const byStatus = Object.fromEntries(PARTNER_APPLICATION_STATUSES.map((s) => [s, 0]));
  for (const c of counts) byStatus[c._id] = c.n;
  return { applications: rows.map(adminListView), total, page: p, pages: Math.ceil(total / l), counts: byStatus, categories: PARTNER_CATEGORIES };
};

const loadForAdmin = async (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  const a = await PartnerApplication.findById(id).lean();
  if (!a) throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  return a;
};

export const adminDetail = async (id) => adminDetailView(await loadForAdmin(id));

/** PATCH …/:id/status { status, note? } — only paid applications move through review. */
export const setStatus = async (id, adminId, { status, note }) => {
  if (!PARTNER_REVIEW_STATUSES.includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unknown status');
  const a = await loadForAdmin(id);
  if (a.payment?.status !== 'paid') throw new ApiError(409, 'NOT_PAID', 'The form fee is not paid yet');
  const set = { status, statusChangedAt: now() };
  const push = note?.trim() ? { notes: { text: note.trim(), status, by: adminId, at: now() } } : null;
  const updated = await PartnerApplication.findByIdAndUpdate(id, { $set: set, ...(push ? { $push: push } : {}) }, { new: true }).lean();
  await logActivity({ adminId, action: 'PARTNER_APPLICATION_STATUS', targetType: 'partner_application', targetId: id, metadata: { from: a.status, to: status } });
  return adminDetailView(updated);
};

/** POST …/:id/notes { text } */
export const addNote = async (id, adminId, text) => {
  const clean = String(text ?? '').trim();
  if (!clean) throw new ApiError(400, 'VALIDATION_ERROR', 'Write a note');
  await loadForAdmin(id);
  const updated = await PartnerApplication.findByIdAndUpdate(
    id,
    { $push: { notes: { text: clean.slice(0, 2000), by: adminId, at: now() } } },
    { new: true }
  ).lean();
  return adminDetailView(updated);
};

/** GET …/export.csv — the filtered list. */
export const exportCsv = async (filters) => {
  const rows = await PartnerApplication.find(listFilter(filters)).sort({ submittedAt: -1, createdAt: -1 }).limit(5000).lean();
  const header = [
    'Application No', 'Submitted', 'Business Name', 'Category', 'Address', 'City', 'GST', 'Employees',
    'Owner Name', 'Owner Mobile', 'Alternate Mobile', 'Questions', 'Status', 'Fee Paid',
  ];
  const lines = rows.map((a) =>
    [
      a.applicationNumber ?? '', a.submittedAt ? a.submittedAt.toISOString() : '', a.businessName, categoryOf(a), a.address,
      a.city, a.hasGst ? 'Yes' : 'No', a.employees, a.ownerName, a.phone, a.alternatePhone ?? '', a.questions ?? '',
      a.status, a.payment?.status === 'paid' ? 'Yes' : 'No',
    ].map(csvCell).join(',')
  );
  return [header.map(csvCell).join(','), ...lines].join('\r\n');
};
