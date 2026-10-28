import { z } from 'zod';
import CashDeposit from '../../models/CashDeposit.js';
import Restaurant from '../../models/Restaurant.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getCashInHand } from '../../services/cashLedger.service.js';

// activityLog.service.js isn't used here either, same reason as onboarding.controller.js:
// AdminActivityLog.adminId is required and refs User — these are partner-initiated writes with
// no admin actor to attribute them to.

const createDepositSchema = z.object({
  amount: z.number().positive(),
  depositPointRestaurantId: z.string().optional(),
  notes: z.string().optional(),
});

export const createDeposit = asyncHandler(async (req, res) => {
  const result = createDepositSchema.safeParse(req.body);
  if (!result.success) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid deposit', result.error.flatten());
  }
  const { amount, depositPointRestaurantId, notes } = result.data;
  // Never more than the rider holds: cash in hand is collected minus deposited, so an over-sized
  // deposit (a typo, or a deliberate one) would silently write off the next cash they collect
  // too — the balance just reads ₹0 until that credit is used up.
  const held = await getCashInHand(req.partner._id);
  if (amount > held + 0.005) {
    throw new ApiError(400, 'AMOUNT_EXCEEDS_CASH_IN_HAND', `You can deposit up to ₹${held.toFixed(2)} — the cash you hold.`, {
      cashInHand: held,
    });
  }

  if (depositPointRestaurantId) {
    const exists = await Restaurant.exists({ _id: depositPointRestaurantId });
    if (!exists) throw new ApiError(400, 'VALIDATION_ERROR', 'depositPointRestaurantId does not exist');
  }

  // No reconciliation authority exists anywhere in this codebase to drive a submitted->confirmed
  // transition (no cashier/restaurant-side confirm action) — self-confirmed immediately, per the
  // plan's own resolution of this exact question. 'submitted'/'disputed' stay in the model's enum
  // for a future admin-driven dispute flow, they're just not reachable from this endpoint today.
  const deposit = await CashDeposit.create({
    partnerId: req.partner._id,
    amount,
    depositPointRestaurantId: depositPointRestaurantId ?? null,
    notes,
    status: 'confirmed',
  });

  const cashInHand = await getCashInHand(req.partner._id);

  sendSuccess(res, 201, 'Deposit recorded', { deposit, cashInHand });
});

export const listDeposits = asyncHandler(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const skip = (Number(page) - 1) * Number(limit);

  const [rows, total] = await Promise.all([
    CashDeposit.find({ partnerId: req.partner._id })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean(),
    CashDeposit.countDocuments({ partnerId: req.partner._id }),
  ]);

  sendSuccess(res, 200, 'Deposits', {
    rows,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});
