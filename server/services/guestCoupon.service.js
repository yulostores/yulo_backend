// Partner coupons for a guest paying the table's bill from the QR menu (yulo_menu) — someone with
// no customer account. Before paying they may fill in name, gender, mobile number and date of
// birth ("Get free coupons"); it is optional, and paying never depends on it.
//
//   1. The details ride along with POST …/bill/pay and are kept on the bill (Bill.couponClaim),
//      with the hash of a random token that only the paying device gets back.
//   2. When the bill is paid online, couponIssue.service.js issues as usual — to the customer
//      account with that mobile number, created here if there is none. The number is NOT
//      verified: a guest signing in to the customer app later with the same number (by OTP)
//      simply finds the coupons waiting.
//   3. The paying device shows its coupons right away: GET …/bill/coupons with its token.
//
// A number that belongs to a restaurant owner / admin account never gets coupons, and an
// existing customer's own name, gender and date of birth are never overwritten.

import crypto from 'node:crypto';
import { z } from 'zod';

import Bill from '../models/Bill.js';
import Coupon from '../models/Coupon.js';
import User from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { normalizeIndianPhone } from '../utils/phone.js';
import { couponViews } from './myCoupons.service.js';

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const MIN_AGE = 10;
const MAX_AGE = 100;
// Coupons are issued just after the payment lands; how long the device keeps being told "coming".
const ISSUING_WINDOW_MS = 60 * 1000;

const ageOn = (dob, now) => {
  let age = now.getUTCFullYear() - dob.getUTCFullYear();
  const m = now.getUTCMonth() - dob.getUTCMonth();
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.getUTCDate())) age -= 1;
  return age;
};

const schema = z.object({
  name: z.string().trim().min(2, 'Enter your name').max(60, 'Name is too long'),
  gender: z.enum(['male', 'female', 'other'], { errorMap: () => ({ message: 'Choose your gender' }) }),
  phone: z.string().trim().min(1, 'Enter your mobile number'),
  dateOfBirth: z.string().trim().regex(DATE_ONLY, 'Enter your date of birth'),
});

/** Validates the form; returns { name, gender, phone (10 digits), dateOfBirth (Date) } or throws 400. */
export const parseCouponDetails = (input, now = new Date()) => {
  const r = schema.safeParse(input ?? {});
  if (!r.success) throw new ApiError(400, 'VALIDATION_ERROR', r.error.issues[0]?.message ?? 'Check your details', r.error.flatten());
  const phone = normalizeIndianPhone(r.data.phone);
  if (!phone) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a valid 10-digit mobile number');
  const [y, m, d] = r.data.dateOfBirth.split('-').map(Number);
  const dob = new Date(Date.UTC(y, m - 1, d));
  if (dob.getUTCFullYear() !== y || dob.getUTCMonth() !== m - 1 || dob.getUTCDate() !== d) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Enter a real date of birth');
  }
  const age = ageOn(dob, now);
  if (age < MIN_AGE || age > MAX_AGE) throw new ApiError(400, 'VALIDATION_ERROR', 'Enter your real date of birth');
  return { name: r.data.name, gender: r.data.gender, phone, dateOfBirth: dob };
};

const hashToken = (token) => crypto.createHash('sha256').update(String(token)).digest('hex');

/**
 * Keeps the guest's details on the open bill and returns the token the paying device uses to see
 * its coupons. Also fills the bill's customer name / phone when the bill has none, so the
 * restaurant's receipt shows who paid. Returns null when the bill is no longer open.
 */
export const attachClaim = async (billId, details) => {
  const token = crypto.randomBytes(24).toString('base64url');
  const bill = await Bill.findOneAndUpdate(
    { _id: billId, status: 'open' },
    {
      $set: {
        couponClaim: { ...details, claimedAt: new Date(), tokenHash: hashToken(token) },
      },
    },
    { new: true }
  ).select('customerName customerPhone');
  if (!bill) return null;
  const fill = {};
  if (!bill.customerName) fill.customerName = details.name;
  if (!bill.customerPhone) fill.customerPhone = details.phone;
  if (Object.keys(fill).length) await Bill.updateOne({ _id: billId }, { $set: fill });
  return token;
};

/**
 * The customer account a guest's coupons go to: the one with that mobile number, or a new one.
 * null when the number belongs to a non-customer account (owner, admin) or a deactivated one.
 */
export const resolveClaimCustomer = async (claim) => {
  const phone = normalizeIndianPhone(claim?.phone);
  if (!phone) return null;
  let user = await User.findOne({ phone }).select('name role isActive gender dateOfBirth');
  if (!user) {
    try {
      user = await User.create({
        phone,
        role: 'customer',
        name: claim.name ?? undefined,
        gender: claim.gender ?? null,
        dateOfBirth: claim.dateOfBirth ?? null,
      });
    } catch (err) {
      if (err?.code !== 11000) throw err;
      // Created by a concurrent payment with the same number.
      user = await User.findOne({ phone }).select('name role isActive gender dateOfBirth');
    }
  }
  if (!user || user.role !== 'customer' || user.isActive === false) return null;

  // Only fill what the account is missing — never overwrite a customer's own profile.
  const fill = {};
  if (!user.name && claim.name) fill.name = claim.name;
  if (!user.gender && claim.gender) fill.gender = claim.gender;
  if (!user.dateOfBirth && claim.dateOfBirth) fill.dateOfBirth = claim.dateOfBirth;
  if (Object.keys(fill).length) {
    await User.updateOne({ _id: user._id }, { $set: fill });
    Object.assign(user, fill);
  }
  return user.toObject ? user.toObject() : user;
};

/**
 * The coupons a paid bill earned, for the device holding its token. `issuing` is true for a short
 * while after payment, while coupons may still be on their way.
 */
export const couponsForToken = async ({ restaurantId, token, now = new Date() }) => {
  if (!token || String(token).length < 20) throw new ApiError(404, 'NOT_FOUND', 'No coupons found');
  const bill = await Bill.findOne({ restaurantId, 'couponClaim.tokenHash': hashToken(token) })
    .select('status paidAt paymentChannel couponClaim.phone')
    .lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'No coupons found');
  if (bill.status !== 'paid') return { paid: false, issuing: false, coupons: [], phoneLast4: bill.couponClaim?.phone?.slice(-4) ?? null };

  const rows = await Coupon.find({ kind: 'customer', 'source.type': 'bill', 'source.id': bill._id, status: { $ne: 'void' } })
    .sort({ issuedAt: 1, _id: 1 })
    .lean();
  const recentlyPaid = bill.paidAt && now.getTime() - new Date(bill.paidAt).getTime() < ISSUING_WINDOW_MS;
  return {
    paid: true,
    issuing: rows.length === 0 && Boolean(recentlyPaid) && bill.paymentChannel === 'online',
    coupons: await couponViews(rows, now),
    phoneLast4: bill.couponClaim?.phone?.slice(-4) ?? null,
  };
};
