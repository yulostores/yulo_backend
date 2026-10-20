// The payout status model both portals show (Figma flow map "Eligibility and transfer are
// separate"), derived from a RestaurantSettlement's stored status — one state machine, two axes:
//
//   eligibility      pending (still clearing) · eligible · on_hold
//   bank transfer    not_scheduled · scheduled (+ date) · processing · paid · failed
//                    (+ carried_forward for the pre-B12 "failed → carried forward" path)
//
// A settlement only ever holds cleared rows, so a settlement itself is never 'pending' — that
// value exists for a single order still clearing (orderPaymentStatusOf).
//
// Pure functions, no database: the admin payout views (services/payoutView.service.js) and the
// owner payment endpoints share this one copy map, so "What the owner sees" on the admin screen is
// exactly the sentence the restaurant portal shows.

export const HOLD_REASONS = {
  dispute_review: 'Dispute review',
  bank_details_review: 'Bank details review',
  compliance_review: 'Compliance review',
  other: 'Other',
};

export const FAILURE_REASONS = {
  bank_rejected_credit: 'Bank rejected the credit',
  account_closed_or_frozen: 'Account closed or frozen',
  name_mismatch: 'Account holder name mismatch',
  invalid_ifsc: 'Invalid IFSC',
  other: 'Other',
};

// Holds the data decides (settlement.service.js decideStatus) — owner-safe labels.
export const AUTO_HOLD_LABELS = {
  PAYOUT_ACCOUNT_NOT_VERIFIED: 'Bank account not verified',
  NEGATIVE_BALANCE_CARRIED_FORWARD: 'Carried forward to next week',
  NEGATIVE_BALANCE: 'Negative balance',
};

const TRANSFER_BY_STATUS = {
  draft: 'not_scheduled',
  approved: 'scheduled',
  processing: 'processing',
  paid: 'paid',
  failed: 'failed',
  on_hold: 'not_scheduled',
  carried_forward: 'carried_forward',
};

export const TRANSFER_LABELS = {
  not_scheduled: 'Not scheduled',
  scheduled: 'Scheduled',
  processing: 'Processing',
  paid: 'Paid',
  failed: 'Failed',
  carried_forward: 'Carried forward',
};

export const ELIGIBILITY_LABELS = { pending: 'Pending', eligible: 'Eligible', on_hold: 'On hold' };

export const ORDER_STATUS_LABELS = {
  pending: 'Pending',
  eligible: 'Eligible',
  on_hold: 'On hold',
  settled: 'Settled',
  refunded: 'Refunded',
};

// Settlement-store status for each transfer status (filters on history screens).
export const STATUSES_FOR_TRANSFER = {
  not_scheduled: ['draft', 'on_hold'],
  scheduled: ['approved'],
  processing: ['processing'],
  paid: ['paid'],
  failed: ['failed'],
  carried_forward: ['carried_forward'],
};

const dateFormatters = new Map();
/** "Mon 12 Oct 2026" in the settlement time zone. */
export const payoutDate = (d, timeZone = 'Asia/Kolkata') => {
  if (!d) return null;
  let f = dateFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
    dateFormatters.set(timeZone, f);
  }
  return f.format(new Date(d)).replace(/,/g, '');
};

const rupees = (paise) =>
  `₹${((paise ?? 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const eligibilityOf = (s) => (s?.status === 'on_hold' ? 'on_hold' : 'eligible');

export const isManualHold = (s) => s?.status === 'on_hold' && s?.holdReason === 'MANUAL';

/** The label of why it is held — never the staff-only note. */
export const holdLabelOf = (s) => {
  if (s?.status !== 'on_hold') return null;
  if (s.holdReason === 'MANUAL') return HOLD_REASONS[s.holdCode] ?? HOLD_REASONS.other;
  return AUTO_HOLD_LABELS[s.holdReason] ?? 'On hold';
};

export const failureLabelOf = (failure) => (failure ? FAILURE_REASONS[failure.reason] ?? failure.reason ?? null : null);

/** The bank-transfer axis with what each state needs on screen. */
export const transferOf = (s) => {
  const status = TRANSFER_BY_STATUS[s?.status] ?? 'not_scheduled';
  const p = s?.payout ?? {};
  return {
    status,
    label: TRANSFER_LABELS[status],
    scheduledFor: status === 'scheduled' || status === 'processing' || status === 'paid' ? p.scheduledFor ?? null : null,
    releasedAt: p.releasedAt ?? p.initiatedAt ?? null,
    attemptRef: p.attemptRef ?? null,
    paidAt: status === 'paid' ? p.creditedAt ?? p.paidAt ?? null : null,
    bankReference: status === 'paid' ? p.utr ?? null : null,
    lastFailure: p.lastFailure?.at
      ? { reason: p.lastFailure.reason, label: failureLabelOf(p.lastFailure), at: p.lastFailure.at, attemptRef: p.lastFailure.attemptRef ?? null }
      : null,
  };
};

/**
 * The badge and the one sentence the restaurant sees for this payout — shown on the owner
 * screens, and quoted on the admin screen's "What the owner sees" card.
 */
export const ownerViewOf = (s, { timezone = 'Asia/Kolkata' } = {}) => {
  if (!s) return null;
  const t = transferOf(s);
  const p = s.payout ?? {};
  if (s.status === 'on_hold') {
    if (s.holdReason === 'PAYOUT_ACCOUNT_NOT_VERIFIED') {
      return { status: 'On hold', message: 'Your bank account is not verified yet. Add or confirm it to receive this payout.' };
    }
    if (s.holdReason === 'NEGATIVE_BALANCE_CARRIED_FORWARD') {
      return { status: 'Carried forward', message: "This week's balance is negative. It is carried forward to next week's statement." };
    }
    if (s.holdReason === 'NEGATIVE_BALANCE') {
      return { status: 'On hold', message: "This week's balance is negative. Yulo will settle it with you." };
    }
    return { status: 'On hold', message: 'Your payout is on hold while Yulo reviews it. No date is promised.' };
  }
  const failedBefore = t.lastFailure ? ` A previous attempt failed on ${payoutDate(t.lastFailure.at, timezone)}.` : '';
  switch (t.status) {
    case 'not_scheduled':
      return { status: 'Not scheduled', message: 'Eligible. Bank payout is not scheduled yet and the date is unknown.' + failedBefore };
    case 'scheduled':
      return { status: 'Scheduled', message: `Bank transfer: Scheduled · ${payoutDate(p.scheduledFor, timezone)}.${failedBefore}` };
    case 'processing':
      return {
        status: 'Processing',
        message: `Your payout of ${rupees(s.totals?.netPayable)} has been sent to the bank. It shows Paid once Yulo records the transfer.`,
      };
    case 'paid':
      return {
        status: 'Paid',
        message: `Paid on ${payoutDate(t.paidAt, timezone)}${t.bankReference ? ` · Reference ${t.bankReference}` : ''}.`,
      };
    case 'failed':
      return {
        status: 'Failed',
        message: `${failureLabelOf(p.lastFailure) ?? 'The bank rejected the credit'}. The amount remains unpaid and retained for payout. Retry timing is unknown.`,
      };
    case 'carried_forward':
      return { status: 'Carried forward', message: 'This payout failed and its amount was moved into a later statement.' };
    default:
      return { status: t.label, message: '' };
  }
};

/**
 * One order's (or bill's) payment status for the restaurant: `entry` is its ledger row (null
 * while the order isn't delivered / the bill isn't paid yet), `settlement` the statement that
 * row is in (null when unsettled).
 */
export const orderPaymentStatusOf = (entry, settlement, now = new Date()) => {
  if (!entry) return 'pending';
  if (entry.type === 'refund_gateway_fee') return 'refunded';
  if (settlement) {
    if (settlement.status === 'paid') return 'settled';
    if (settlement.status === 'on_hold') return 'on_hold';
    return 'eligible';
  }
  const clearsAt = entry.clearsAt ?? entry.eligibleAt;
  return clearsAt && new Date(clearsAt).getTime() > now.getTime() ? 'pending' : 'eligible';
};
