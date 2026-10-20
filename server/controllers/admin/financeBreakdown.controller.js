import mongoose from 'mongoose';
import Order from '../../models/Order.js';
import Bill from '../../models/Bill.js';
import RestaurantLedgerEntry from '../../models/RestaurantLedgerEntry.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { getActiveSettings } from '../../services/financeSettings.service.js';
import { computeRestaurantSettlementLine } from '../../services/settlementMath.service.js';
import { toPaise } from '../../utils/money.js';

// The full money picture of one order or bill, for the super admin: what the customer was
// charged (`charges`), what it meant for settlement (`financials` — Razorpay's fee and Yulo's
// margin included), and the ledger rows it produced. `financials` is the frozen snapshot;
// `projected` is only offered while there is none yet (the order isn't delivered, the bill
// isn't paid) and is computed from today's settings — a preview, labelled as such.

const assertObjectId = (id) => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', 'Invalid id');
};

// GET /api/admin/finance/orders/:orderId/breakdown
export const orderBreakdown = asyncHandler(async (req, res) => {
  assertObjectId(req.params.orderId);
  const order = await Order.findById(req.params.orderId).select('+financials +razorpayFee +razorpayTax').lean();
  if (!order) throw new ApiError(404, 'NOT_FOUND', 'Order not found');

  const ledgerEntries = await RestaurantLedgerEntry.find({ orderId: order._id }).sort({ createdAt: 1 }).lean();

  let projected = null;
  if (!order.financials && order.charges && order.type !== 'dine_in') {
    const e = order.deliveryAssignment?.earningsBreakdown;
    projected = computeRestaurantSettlementLine({
      charges: order.charges,
      paymentChannel: 'online',
      razorpayFeePaise: order.razorpayFee ?? 0,
      razorpayTaxPaise: order.razorpayTax ?? 0,
      riderPayPaise: e ? toPaise((e.basePay ?? 0) + (e.distancePay ?? 0)) : 0,
      settings: await getActiveSettings(),
    });
  }

  sendSuccess(res, 200, 'Order financial breakdown', {
    order: {
      _id: order._id,
      restaurantId: order.restaurantId,
      type: order.type,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentChannel: order.paymentChannel ?? null,
      grandTotal: order.grandTotal,
      razorpayPaymentId: order.razorpayPaymentId ?? null,
      deliveredAt: order.deliveredAt ?? null,
    },
    charges: order.charges ?? null,
    financials: order.financials ?? null,
    projected,
    riderEarnings: order.deliveryAssignment?.earningsBreakdown ?? null,
    ledgerEntries,
  });
});

// GET /api/admin/finance/bills/:billId/breakdown
export const billBreakdown = asyncHandler(async (req, res) => {
  assertObjectId(req.params.billId);
  const bill = await Bill.findById(req.params.billId).select('+financials +razorpayFee +razorpayTax').lean();
  if (!bill) throw new ApiError(404, 'NOT_FOUND', 'Bill not found');

  const ledgerEntries = await RestaurantLedgerEntry.find({ billId: bill._id }).sort({ createdAt: 1 }).lean();

  let projected = null;
  if (!bill.financials && bill.charges && bill.type === 'dine_in') {
    projected = computeRestaurantSettlementLine({
      charges: bill.charges,
      paymentChannel: bill.paymentChannel === 'online' ? 'online' : 'counter',
      razorpayFeePaise: bill.razorpayFee ?? 0,
      razorpayTaxPaise: bill.razorpayTax ?? 0,
      settings: await getActiveSettings(),
    });
  }

  sendSuccess(res, 200, 'Bill financial breakdown', {
    bill: {
      _id: bill._id,
      restaurantId: bill.restaurantId,
      billNumber: bill.billNumber,
      type: bill.type,
      status: bill.status,
      paymentChannel: bill.paymentChannel ?? null,
      paidBy: bill.paidBy ?? null,
      grandTotal: bill.grandTotal,
      paidAt: bill.paidAt ?? null,
    },
    charges: bill.charges ?? null,
    financials: bill.financials ?? null,
    projected,
    ledgerEntries,
  });
});
