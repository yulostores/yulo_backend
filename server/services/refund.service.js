import Order from '../models/Order.js';

// An order that ends up both cancelled AND paid owes the customer their money back. There
// are two ways to get there, and they can race each other:
//
//   the order is cancelled (restaurant rejects it, the approval timeout, the kitchen...)
//     after the customer has paid                          -> kitchen.service.js
//   a payment is captured (verify / webhook) after the order
//     was already cancelled                                 -> payment.service.js
//
// Both paths call this AFTER their own write. The condition is evaluated atomically by
// Mongo against the current document, so whichever write lands second always sees both
// halves and sets the flag — no ordering of the two can leave a paid, cancelled order
// unflagged. No refund integration exists yet; 'pending' is what finance works from.
export const flagRefundIfOwed = async (orderId) => {
  const res = await Order.updateOne(
    { _id: orderId, status: 'cancelled', paymentStatus: 'paid', refundStatus: 'none' },
    { $set: { refundStatus: 'pending' } }
  );
  return res.modifiedCount > 0;
};
