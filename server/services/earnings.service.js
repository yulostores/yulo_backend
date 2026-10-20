import mongoose from 'mongoose';
import Order from '../models/Order.js';
import Restaurant from '../models/Restaurant.js';
import { getPeriod } from './payout.service.js';

const PERIOD_LABELS = { today: 'today', weekly: 'this week', monthly: 'this month' };
const LINES_LIMIT = 100;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A rider's earnings for today / this week / this month, from the SAME frozen per-order
// earningsBreakdown (Order.deliveryAssignment.earningsBreakdown — base pay, distance pay and the
// customer's tip, fixed when they accepted the order) that their weekly payout is summed from
// (services/payout.service.js). So the total here and the payout for the same week agree, tips
// included — tips used to be shown as a placeholder 0 and never paid.
//
// `deliveries` lists each delivery's own lines, newest first (up to LINES_LIMIT), so the app can
// show how every rupee was earned. Periods are in the settlement time zone (IST).
export const getEarningsForPeriod = async (partnerId, periodType = 'today') => {
  const { start, end } = await getPeriod(periodType);
  const match = {
    'deliveryAssignment.partnerId': new mongoose.Types.ObjectId(String(partnerId)),
    type: 'delivery',
    'deliveryAssignment.status': 'delivered',
    deliveredAt: { $gte: start, $lte: end },
  };

  const [[agg], orders] = await Promise.all([
    Order.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          orders: { $sum: 1 },
          basePay: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.basePay', 0] } },
          distancePay: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.distancePay', 0] } },
          peakSurge: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.surgePay', 0] } },
          tips: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.tip', 0] } },
          penalties: { $sum: { $ifNull: ['$deliveryAssignment.earningsBreakdown.penalty', 0] } },
        },
      },
    ]),
    Order.find(match)
      .sort({ deliveredAt: -1 })
      .limit(LINES_LIMIT)
      .select('restaurantId deliveredAt deliveryAssignment.earningsBreakdown')
      .lean(),
  ]);

  const restaurants = await Restaurant.find({ _id: { $in: [...new Set(orders.map((o) => String(o.restaurantId)))] } })
    .select('name')
    .lean();
  const nameById = new Map(restaurants.map((r) => [String(r._id), r.name]));

  const deliveries = orders.map((o) => {
    const e = o.deliveryAssignment?.earningsBreakdown ?? {};
    const basePay = round2(e.basePay);
    const distancePay = round2(e.distancePay);
    const tip = round2(e.tip);
    const surgePay = round2(e.surgePay);
    const penalty = round2(e.penalty);
    return {
      orderId: o._id,
      restaurantName: nameById.get(String(o.restaurantId)) ?? null,
      deliveredAt: o.deliveredAt,
      distanceKm: e.distanceKm ?? null,
      basePay,
      distancePay,
      surgePay,
      tip,
      penalty,
      total: round2(basePay + distancePay + surgePay + tip - penalty),
    };
  });

  const basePay = round2(agg?.basePay);
  const distancePay = round2(agg?.distancePay);
  const peakSurge = round2(agg?.peakSurge);
  const tips = round2(agg?.tips);
  const penalties = round2(agg?.penalties);

  // No incentive-target or idle-pay programme exists yet (the app's "3 more orders → ₹120 bonus"
  // and veg-fleet idle-pay rows are mock-ups) — 0, not fabricated.
  const incentiveBonus = 0;
  const idlePay = 0;

  return {
    label: PERIOD_LABELS[periodType] ?? periodType,
    period: { start, end },
    totalEarned: round2(basePay + distancePay + peakSurge + tips + incentiveBonus + idlePay - penalties),
    orders: agg?.orders ?? 0,
    incentiveBonus,
    idlePay,
    basePay,
    distancePay,
    peakSurge,
    tips,
    penalties,
    deliveries,
  };
};
