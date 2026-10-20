import { maskPhone } from './maskPhone.js';

// What the public, QR-keyed table endpoints may say about people. Anyone holding a table's
// QR link can read its session and bill — including the next party at that table, or someone
// who photographed the code — so names are cut to an initial, phone numbers to their last four
// digits, and internal ids (accounts, staff) are dropped. The guest's own screens show none of
// these fields; the masked forms are only there so "Booked by A." still reads sensibly.

const maskName = (name) => {
  const first = String(name ?? '').trim().charAt(0);
  return first ? `${first.toUpperCase()}.` : null;
};
const maskMaybePhone = (phone) => (phone ? maskPhone(phone) : null);

const STAFF_HISTORY_KEYS = ['byStaffId', 'byStaffName'];

/** A TableSession (with populated orders) as the public session endpoint may return it. */
export const publicSessionView = (session) => {
  if (!session) return null;
  const { waiterId, guestName, guestPhone, orders = [], ...rest } = session;
  return {
    ...rest,
    guestName: maskName(guestName),
    guestPhone: maskMaybePhone(guestPhone),
    orders: orders.filter(Boolean).map((order) => {
      const { userId, staffId, customerName, customerPhone, deliveryAddress, statusHistory, ...safe } = order;
      return {
        ...safe,
        customerName: maskName(customerName),
        customerPhone: maskMaybePhone(customerPhone),
        statusHistory: (statusHistory ?? []).map((h) => {
          const entry = { ...h };
          for (const key of STAFF_HISTORY_KEYS) delete entry[key];
          return entry;
        }),
      };
    }),
  };
};

// The bill fields the public (QR-keyed) bill endpoints return — an allow-list, so a field added
// to the bill or its view later is private until someone decides otherwise. Everything a guest
// needs to read and pay the bill; nothing about staff, accounts, gateway internals or why an
// earlier payment failed.
const PUBLIC_BILL_KEYS = [
  '_id', 'billNumber', 'reference', 'type', 'status', 'tableNumber', 'sessionCode', 'guestCount',
  'restaurant', 'restaurantSnapshot', 'openedAt', 'closedAt', 'createdAt', 'updatedAt',
  'items', 'itemCount', 'orderCount', 'cancelledOrderCount', 'awaitingApprovalCount',
  'subtotal', 'gstPercent', 'gstAmount', 'serviceChargePercent', 'serviceChargeAmount',
  'deliveryFee', 'platformFee', 'tip', 'discountTotal', 'grandTotal',
  'charges', 'chargeBreakdown', 'paidAt', 'paidBy', 'paymentMethod', 'paymentChannel',
];

const BATCH_KEYS = [
  'batchNumber', 'round', 'orderId', 'orderCode', 'items', 'itemCount', 'batchTotal', 'placedAt', 'status', 'placedBy',
];

const pick = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, obj[k]]));

/** A billView.service.js bill payload as the public bill endpoints may return it. */
export const publicBillView = (view) => {
  if (!view) return null;
  const out = pick(view, PUBLIC_BILL_KEYS);
  out.customer = view.customer
    ? { name: maskName(view.customer.name), phone: maskMaybePhone(view.customer.phone), type: view.customer.type }
    : null;
  out.session = view.session
    ? {
        status: view.session.status ?? null,
        openedAt: view.session.openedAt ?? null,
        closedAt: view.session.closedAt ?? null,
        guestCount: view.session.guestCount ?? null,
        guestName: maskName(view.session.guestName),
      }
    : null;
  out.table = view.table ? { identifier: view.table.identifier ?? null, capacity: view.table.capacity ?? null } : null;
  out.discountsApplied = (view.discountsApplied ?? []).map((d) => ({ code: d.code ?? null, description: d.description ?? null, amount: d.amount }));
  out.batches = (view.batches ?? []).map((batch) => pick(batch, BATCH_KEYS));
  out.payment = view.payment
    ? { status: view.payment.status, isPaid: view.payment.isPaid, method: view.payment.method ?? null, paidAt: view.payment.paidAt ?? null }
    : null;
  // The refund in the same plain-words form the customer app gets — never the internal record.
  const r = view.refund;
  out.refund = r && r.status && r.status !== 'none'
    ? { status: r.status, amountPaise: r.amountPaise ?? null, processedAt: r.processedAt ?? null }
    : null;
  return out;
};
