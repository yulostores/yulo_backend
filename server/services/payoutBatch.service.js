import crypto from 'node:crypto';
import mongoose from 'mongoose';
import PayoutBatch from '../models/PayoutBatch.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import Restaurant from '../models/Restaurant.js';
import { ApiError } from '../utils/ApiError.js';
import { decryptField } from '../utils/fieldEncryption.js';
import { toRupees } from '../utils/money.js';
import logger from '../utils/logger.js';
import { getBankFileFormat, buildBankFile, parseBankResponse } from '../config/bankFileFormats.js';
import { localDay } from '../config/settlementExport.config.js';
import { getActiveSettings } from './financeSettings.service.js';
import { logActivity } from './activityLog.service.js';
import { getPayoutProvider } from './payoutProviders/index.js';

// Paying restaurants by bank bulk upload, end to end (B9):
//
//   1. createBatch   approved settlements → one batch; each claimed approved → processing
//                    atomically (a settlement can never be on two batches) and given a payment
//                    reference unique to this attempt
//   2. buildFile     the bank's bulk-payment file for the batch (account numbers decrypted
//                    server-side; every download audit-logged) — the admin uploads it to net
//                    banking
//   3. reconcile     the bank's results back in: paid (with UTR) → settlement paid; failed, or
//                    returned after being paid → settlement failed, flagged loudly. This is the
//                    admin recording the bank's result (B12: nothing turns paid on its own) —
//                    `preview: true` shows what a response file would change without writing.
//   4. a failed settlement stays eligible in its own statement (B12): the admin reschedules it
//      (settlement.service.js rescheduleSettlement). The older retry / carry-forward actions
//      below are kept for payouts failed before B12 — never both, so nothing is paid twice.
//
// B12 made this path OPTIONAL: the main flow releases each restaurant's payout by hand
// (settlement.service.js releaseSettlement). A batch is "release these scheduled payouts as one
// bank file".
//
// cancelBatch withdraws a batch that was NOT uploaded: its settlements go back to approved.

const assertId = (id, what = 'id') => {
  if (!mongoose.isValidObjectId(id)) throw new ApiError(400, 'VALIDATION_ERROR', `Invalid ${what}`);
};

// The whole settlement id: unique by construction (a slice of it — the ObjectId's counter bytes
// — can repeat across processes and weeks, and the bank's results are matched on it).
const referenceFor = (settlement, attempt) => `YULO-${String(settlement._id).toUpperCase()}-${attempt}`;

export const ACCOUNT_PATHS =
  'name email phone payoutAccount.accountHolderName payoutAccount.ifsc payoutAccount.status payoutAccount.verifiedAt payoutAccount.accountNumberLast4 +payoutAccount.accountNumberEncrypted';

// Identifies one saved version of a bank account without holding the number: the ciphertext is
// re-made (fresh IV) on every save, so any change by the owner gives a different fingerprint.
export const accountFingerprint = (pa) =>
  pa?.accountNumberEncrypted
    ? crypto.createHash('sha256').update(`${pa.accountNumberEncrypted}|${pa.ifsc}|${pa.accountHolderName}`).digest('hex')
    : null;

// Why this payment's line must not go in the file: the restaurant's account isn't the verified
// one it was batched for any more. Null when it still is.
export const beneficiaryProblem = (settlement, restaurant) => {
  const pa = restaurant?.payoutAccount;
  const snap = settlement.payout?.beneficiary;
  if (!snap?.fingerprint) return 'No verified bank account was recorded when this payment was batched';
  if (pa?.status !== 'verified') return 'The bank account was changed and is not verified';
  if (accountFingerprint(pa) !== snap.fingerprint) return 'The bank account changed after the batch was created';
  return null;
};

/** The verified account a payment is for, as stored on the settlement (never the number). */
export const beneficiarySnapshot = (pa) => ({
  fingerprint: accountFingerprint(pa),
  accountNumberLast4: pa?.accountNumberLast4 ?? null,
  ifsc: pa?.ifsc ?? null,
  verifiedAt: pa?.verifiedAt ?? null,
});

// A mobile number as banks' upload templates want it: digits only, with a leading + kept.
// Restaurant.phone is free text ("+91-98765 43210", "(080) 1234").
const bankPhone = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/[^0-9]/g, '');
  if (!digits) return null;
  return String(phone).trim().startsWith('+') ? `+${digits}` : digits;
};

// The settlement week as the restaurant knows it — calendar dates in the settlement time zone
// (an IST Monday–Sunday week, not the UTC Sunday its start falls on).
const periodLabel = (s, timezone) => `${localDay(s.periodStart, timezone)} to ${localDay(s.periodEnd, timezone)}`;

// A reference printed by referenceFor: the settlement and the attempt it was for.
const parseReference = (reference) => {
  const m = /^YULO-([0-9A-F]{24})-(\d+)$/i.exec(String(reference ?? '').trim());
  return m ? { settlementId: m[1].toLowerCase(), attempt: Number(m[2]) } : null;
};

/**
 * Puts approved settlements (all of them, or the given ids) on a new batch. Settlements whose
 * restaurant's bank account is not verified any more are left out and reported.
 */
export const createBatch = async ({ settlementIds, adminId, note = '' }) => {
  const settings = await getActiveSettings();
  const provider = getPayoutProvider('bank_file');

  const filter = { status: 'approved' };
  if (settlementIds?.length) {
    settlementIds.forEach((id) => assertId(id, 'settlement id'));
    filter._id = { $in: settlementIds };
  }
  const candidates = await RestaurantSettlement.find(filter).lean();
  if (candidates.length === 0) throw new ApiError(409, 'NOTHING_TO_PAY', 'No approved settlements to pay');

  const batch = await PayoutBatch.create({
    format: settings.payoutBankFileFormat ?? 'generic_csv',
    createdBy: adminId,
    note,
  });

  const claimed = [];
  const skipped = [];
  for (const s of candidates) {
    const beneficiary = await provider.ensureBeneficiary({ _id: s.restaurantId });
    if (!beneficiary.ready) {
      skipped.push({ settlementId: s._id, reason: beneficiary.reason });
      continue;
    }
    // The verified account this payment is for — the file is only built while it is unchanged.
    const restaurant = await Restaurant.findById(s.restaurantId).select(ACCOUNT_PATHS).lean();
    const pa = restaurant?.payoutAccount;
    if (pa?.status !== 'verified' || !accountFingerprint(pa)) {
      skipped.push({ settlementId: s._id, reason: 'Bank account is not verified' });
      continue;
    }
    // Scheduled for one verified account (B12): never batched to another.
    const scheduledFor = s.payout?.beneficiary?.fingerprint;
    if (scheduledFor && scheduledFor !== accountFingerprint(pa)) {
      skipped.push({ settlementId: s._id, reason: 'The bank account changed after the payout was scheduled — schedule it again' });
      continue;
    }
    const attempt = (s.payout?.attempts ?? 0) + 1;
    const updated = await RestaurantSettlement.findOneAndUpdate(
      { _id: s._id, status: 'approved' },
      {
        $set: {
          status: 'processing',
          'payout.provider': 'bank_file',
          'payout.batchId': batch._id,
          'payout.reference': referenceFor(s, attempt),
          'payout.attemptRef': referenceFor(s, attempt),
          'payout.initiatedAt': new Date(),
          'payout.releasedAt': new Date(),
          'payout.releasedBy': adminId,
          'payout.failureReason': null,
          'payout.failedAt': null,
          'payout.beneficiary': {
            fingerprint: accountFingerprint(pa),
            accountNumberLast4: pa.accountNumberLast4 ?? null,
            ifsc: pa.ifsc,
            verifiedAt: pa.verifiedAt ?? null,
          },
        },
        $inc: { 'payout.attempts': 1 },
      },
      { new: true }
    );
    if (updated) claimed.push(updated);
    else skipped.push({ settlementId: s._id, reason: 'Changed while the batch was being created' });
  }

  if (claimed.length === 0) {
    await PayoutBatch.deleteOne({ _id: batch._id });
    throw new ApiError(409, 'NOTHING_TO_PAY', 'None of the selected settlements can be paid right now', { skipped });
  }

  batch.set({
    settlementIds: claimed.map((s) => s._id),
    count: claimed.length,
    totalPaise: claimed.reduce((n, s) => n + s.totals.netPayable, 0),
  });
  await batch.save();
  await logActivity({
    adminId,
    action: 'payout_batch.create',
    targetType: 'payout_batch',
    targetId: batch._id,
    metadata: { count: batch.count, totalPaise: batch.totalPaise, skipped },
  });
  return { batch: batch.toObject(), skipped };
};

const loadBatch = async (id) => {
  assertId(id, 'batch id');
  const batch = await PayoutBatch.findById(id);
  if (!batch) throw new ApiError(404, 'NOT_FOUND', 'Payout batch not found');
  return batch;
};

/**
 * The bulk-payment file for a batch: one line per settlement still awaiting payment in it.
 * Contains full account numbers — every download is audit-logged and the caller must send it
 * with Cache-Control: no-store.
 *
 * Refused (409 BENEFICIARY_CHANGED, listing them) if any restaurant's bank account is no longer
 * the verified one its payment was batched for — cancel the batch and create a new one (the
 * changed account is left out until it is verified again).
 */
export const buildBatchFile = async (batchId, adminId) => {
  const batch = await loadBatch(batchId);
  if (!['created', 'downloaded', 'partially_reconciled'].includes(batch.status)) {
    throw new ApiError(409, 'BATCH_CLOSED', `This batch is ${batch.status} — nothing left to pay in it`);
  }
  const format = getBankFileFormat(batch.format);
  const { timezone } = (await getActiveSettings()).settlementCycle;

  const settlements = await RestaurantSettlement.find({ 'payout.batchId': batch._id, status: 'processing' })
    // Sub-paths, not the whole payoutAccount: selecting a parent and a +select:false child of it
    // together is a projection collision.
    .populate({ path: 'restaurantId', select: ACCOUNT_PATHS })
    .lean();
  if (settlements.length === 0) throw new ApiError(409, 'BATCH_CLOSED', 'Every payment in this batch is already settled');

  const changed = settlements
    .map((s) => ({ s, reason: beneficiaryProblem(s, s.restaurantId) }))
    .filter((x) => x.reason)
    .map(({ s, reason }) => ({ settlementId: s._id, restaurantName: s.restaurantId?.name ?? null, reason }));
  if (changed.length) {
    logger.warn({ batchId: batch._id, changed }, 'Payout file refused: a beneficiary bank account changed after batching');
    throw new ApiError(
      409,
      'BENEFICIARY_CHANGED',
      'A restaurant changed its bank account after this batch was created — cancel the batch and create a new one',
      { changed }
    );
  }

  const lines = settlements.map((s) => {
    const r = s.restaurantId;
    const pa = r.payoutAccount;
    const amountRupees = toRupees(s.totals.netPayable);
    return {
      reference: s.payout.reference,
      beneficiaryName: pa.accountHolderName,
      accountNumber: decryptField(pa.accountNumberEncrypted),
      ifsc: pa.ifsc,
      amountRupees,
      mode: amountRupees <= format.impsMaxRupees ? 'IMPS' : 'NEFT',
      email: r.email ?? null,
      phone: bankPhone(r.phone),
      restaurantName: r.name,
      periodLabel: periodLabel(s, timezone),
      narration: `Yulo settlement ${periodLabel(s, timezone)}`,
    };
  });

  batch.downloads.push({ at: new Date(), by: adminId });
  if (batch.status === 'created') batch.status = 'downloaded';
  await batch.save();
  await logActivity({
    adminId,
    action: 'payout_batch.download',
    targetType: 'payout_batch',
    targetId: batch._id,
    metadata: { lines: lines.length, format: batch.format },
  });

  return {
    fileName: `yulo-payouts-${new Date().toISOString().slice(0, 10)}-${String(batch._id).slice(-6)}.${format.extension}`,
    mime: format.mime,
    content: buildBankFile(format, lines),
  };
};

/**
 * The bank's results for a batch. `rows` = [{ reference, status: 'paid'|'failed'|'returned',
 * utr?, reason? }], or `csv` = the bank's response file text (read with the batch's format).
 * Replaying the same results changes nothing. Returns a per-row summary.
 */
export const reconcileBatch = async (batchId, { rows, csv, preview = false }, adminId) => {
  const batch = await loadBatch(batchId);
  if (batch.status === 'cancelled') throw new ApiError(409, 'BATCH_CLOSED', 'This batch was cancelled');

  let results = rows;
  if (!results && csv) {
    try {
      results = parseBankResponse(getBankFileFormat(batch.format), csv);
    } catch (err) {
      throw new ApiError(400, 'VALIDATION_ERROR', err.message);
    }
  }
  if (!Array.isArray(results) || results.length === 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Provide the bank results as rows or as the response file (csv)');
  }

  if (preview) return { batch: batch.toObject(), summary: await previewReconcile(batch, results), preview: true };

  const summary = { paid: 0, failed: 0, returned: 0, unchanged: 0, conflicts: [], unmatched: [] };
  for (const row of results) {
    const s = await RestaurantSettlement.findOne({ 'payout.batchId': batch._id, 'payout.reference': row.reference });
    if (!s) {
      // A line of this batch whose settlement has since moved on (retried onto another batch,
      // carried forward, paid by hand): the bank now reporting it PAID means the restaurant may
      // have been paid twice — flagged, never applied.
      const ref = parseReference(row.reference);
      const earlier =
        ref && batch.settlementIds.some((id) => String(id) === ref.settlementId)
          ? await RestaurantSettlement.findById(ref.settlementId).lean()
          : null;
      if (!earlier) {
        summary.unmatched.push({ reference: row.reference, reason: 'Not a payment in this batch' });
      } else if (row.status === 'paid') {
        logger.error(
          { settlementId: earlier._id, reference: row.reference, utr: row.utr, currentStatus: earlier.status },
          'POSSIBLE DOUBLE PAYMENT — the bank paid an earlier attempt of a settlement that was since retried'
        );
        summary.conflicts.push({
          reference: row.reference,
          reason: `Possible double payment: the bank paid this earlier attempt (UTR ${row.utr ?? 'none'}) after the settlement was moved on — it is now ${earlier.status}${earlier.payout?.utr ? ` (UTR ${earlier.payout.utr})` : ''}. Check with the bank before paying again.`,
        });
      } else {
        summary.unchanged += 1;
      }
      continue;
    }

    if (row.status === 'paid') {
      if (!row.utr) {
        summary.conflicts.push({ reference: row.reference, reason: 'A paid row needs its UTR' });
      } else if (s.status === 'paid') {
        if (s.payout.utr === row.utr) summary.unchanged += 1;
        else summary.conflicts.push({ reference: row.reference, reason: `Already paid with UTR ${s.payout.utr}` });
      } else if (s.status === 'processing') {
        const res = await RestaurantSettlement.updateOne(
          { _id: s._id, status: 'processing' },
          {
            $set: {
              status: 'paid',
              'payout.utr': row.utr,
              'payout.paidAt': new Date(),
              'payout.creditedAt': new Date(),
              'payout.failureReason': null,
              'payout.markedPaidBy': adminId,
            },
          }
        );
        if (res.modifiedCount) summary.paid += 1;
        else summary.conflicts.push({ reference: row.reference, reason: 'Settlement changed while reconciling' });
      } else {
        summary.conflicts.push({ reference: row.reference, reason: `Settlement is ${s.status}` });
      }
    } else if (row.status === 'failed' || row.status === 'returned') {
      const reason = row.reason || (row.status === 'returned' ? 'Returned by the bank' : 'Failed at the bank');
      // A return only undoes the BANK's payment of this line: not one an admin since recorded as
      // paid by hand (replaying an old response file must never reopen it to be paid again), and
      // not one paid under a different UTR.
      const bankPaid =
        s.status === 'paid' &&
        s.payout?.provider === 'bank_file' &&
        (!row.utr || !s.payout?.utr || row.utr === s.payout.utr);
      if (s.status === 'failed') {
        summary.unchanged += 1;
      } else if (s.status === 'processing' || (row.status === 'returned' && bankPaid)) {
        // Money didn't reach the restaurant (or bounced back after the bank first said paid).
        logger.error(
          { settlementId: s._id, reference: row.reference, reason },
          'SETTLEMENT PAYOUT FAILED — retry or carry forward from the admin console'
        );
        const failedAt = new Date();
        const failureReason = `${row.status === 'returned' ? 'Returned' : 'Failed'}: ${reason}`;
        // A returned payment's UTR and paid date belong to the attempt that bounced, not to the
        // failed settlement — moved into the history, so nobody reads it as paid.
        const res = await RestaurantSettlement.updateOne(
          { _id: s._id, status: s.status, 'payout.provider': s.payout?.provider ?? null },
          {
            $set: {
              status: 'failed',
              'payout.failureReason': failureReason,
              'payout.failedAt': failedAt,
              'payout.lastFailure': { reason: 'bank_rejected_credit', note: reason, at: failedAt, attemptRef: s.payout?.reference ?? null },
              'payout.utr': null,
              'payout.paidAt': null,
              'payout.creditedAt': null,
            },
            $push: {
              'payout.history': {
                batchId: s.payout?.batchId ?? null,
                reference: s.payout?.reference ?? null,
                outcome: row.status === 'returned' ? 'returned' : 'failed',
                utr: s.payout?.utr ?? row.utr ?? null,
                paidAt: s.payout?.paidAt ?? null,
                failedAt,
                reason: failureReason,
              },
            },
          }
        );
        if (res.modifiedCount) summary[row.status === 'returned' ? 'returned' : 'failed'] += 1;
        else summary.conflicts.push({ reference: row.reference, reason: 'Settlement changed while reconciling' });
      } else if (s.status === 'paid' && s.payout?.provider === 'manual') {
        summary.conflicts.push({
          reference: row.reference,
          reason: `Marked paid by hand (UTR ${s.payout.utr}) — check with the bank before changing it`,
        });
      } else {
        summary.conflicts.push({ reference: row.reference, reason: `Settlement is ${s.status}` });
      }
    } else {
      summary.unmatched.push({ reference: row.reference, reason: `Unrecognised status "${row.raw ?? row.status}"` });
    }
  }

  const stillAwaiting = await RestaurantSettlement.countDocuments({ 'payout.batchId': batch._id, status: 'processing' });
  batch.status = stillAwaiting === 0 ? 'reconciled' : 'partially_reconciled';
  if (stillAwaiting === 0) batch.reconciledAt = new Date();
  await batch.save();

  await logActivity({ adminId, action: 'payout_batch.reconcile', targetType: 'payout_batch', targetId: batch._id, metadata: summary });
  return { batch: batch.toObject(), summary };
};

// What reconcile would do with these rows, without writing anything.
const previewReconcile = async (batch, results) => {
  const preview = { paid: 0, failed: 0, returned: 0, unchanged: 0, conflicts: [], unmatched: [] };
  for (const row of results) {
    const s = await RestaurantSettlement.findOne({ 'payout.batchId': batch._id, 'payout.reference': row.reference }).lean();
    if (!s) preview.unmatched.push({ reference: row.reference, reason: 'Not a payment in this batch (or it moved on)' });
    else if (row.status === 'paid') {
      if (!row.utr) preview.conflicts.push({ reference: row.reference, reason: 'A paid row needs its UTR' });
      else if (s.status === 'processing') preview.paid += 1;
      else if (s.status === 'paid' && s.payout?.utr === row.utr) preview.unchanged += 1;
      else preview.conflicts.push({ reference: row.reference, reason: `Settlement is ${s.status}` });
    } else if (row.status === 'failed' || row.status === 'returned') {
      if (s.status === 'processing' || (row.status === 'returned' && s.status === 'paid' && s.payout?.provider === 'bank_file')) {
        preview[row.status === 'returned' ? 'returned' : 'failed'] += 1;
      } else if (s.status === 'failed') preview.unchanged += 1;
      else preview.conflicts.push({ reference: row.reference, reason: `Settlement is ${s.status}` });
    } else preview.unmatched.push({ reference: row.reference, reason: `Unrecognised status "${row.raw ?? row.status}"` });
  }
  return preview;
};

/**
 * Withdraws a batch that was NOT uploaded to the bank. The admin must confirm that — cancelling
 * a batch the bank is already paying would let the same settlements be paid again.
 */
export const cancelBatch = async (batchId, { confirmNotUploaded }, adminId) => {
  if (confirmNotUploaded !== true) {
    throw new ApiError(400, 'CONFIRMATION_REQUIRED', 'Confirm this batch file was NOT uploaded to the bank');
  }
  const batch = await loadBatch(batchId);
  if (!['created', 'downloaded'].includes(batch.status)) {
    throw new ApiError(409, 'NOT_CANCELLABLE', `A ${batch.status} batch can't be cancelled — reconcile it instead`);
  }
  const res = await RestaurantSettlement.updateMany(
    { 'payout.batchId': batch._id, status: 'processing' },
    {
      $set: {
        status: 'approved',
        'payout.batchId': null,
        'payout.reference': null,
        'payout.attemptRef': null,
        'payout.initiatedAt': null,
        'payout.releasedAt': null,
        'payout.releasedBy': null,
      },
    }
  );
  batch.set({ status: 'cancelled', cancelledAt: new Date() });
  await batch.save();
  await logActivity({ adminId, action: 'payout_batch.cancel', targetType: 'payout_batch', targetId: batch._id, metadata: { released: res.modifiedCount } });
  return batch.toObject();
};

// ── A failed settlement: retry it, or carry it forward ───────────────────────

/** Back to approved, so it goes on the next batch with a fresh payment reference. */
export const retrySettlement = async (settlementId, adminId) => {
  assertId(settlementId, 'settlement id');
  const s = await RestaurantSettlement.findById(settlementId).lean();
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Settlement not found');
  if (s.status !== 'failed') throw new ApiError(409, 'NOT_RETRYABLE', `Only a failed payout can be retried (this one is ${s.status})`);
  const ready = await getPayoutProvider(s.payout?.provider === 'manual' ? 'manual' : 'bank_file').ensureBeneficiary({ _id: s.restaurantId });
  if (!ready.ready) throw new ApiError(409, 'PAYOUT_ACCOUNT_NOT_VERIFIED', ready.reason);

  // Pre-B12 endpoint: the same as rescheduling for the next payout day.
  const { defaultReleaseDay } = await import('./settlement.service.js');
  const updated = await RestaurantSettlement.findOneAndUpdate(
    { _id: settlementId, status: 'failed' },
    {
      $set: {
        status: 'approved',
        'payout.scheduledFor': await defaultReleaseDay(),
        'payout.scheduledAt': new Date(),
        'payout.scheduledBy': adminId,
        'payout.batchId': null,
        'payout.reference': null,
        'payout.attemptRef': null,
        'payout.releasedAt': null,
        'payout.utr': null,
        'payout.paidAt': null,
        'payout.creditedAt': null,
      },
    },
    { new: true }
  );
  if (!updated) throw new ApiError(409, 'CONCURRENT_UPDATE', 'The settlement changed — please refresh');
  await logActivity({ adminId, action: 'settlement.retry_payout', targetType: 'settlement', targetId: updated._id });
  return updated;
};

/**
 * Closes a failed settlement by moving its amount into the restaurant's next settlement: a
 * carry_forward credit, unsettled, eligible now — the next generated week picks it up. Used
 * when the bank details have to be fixed first (the next week's payout is then held until the
 * account is re-verified).
 */
export const carryForwardFailed = async (settlementId, adminId) => {
  assertId(settlementId, 'settlement id');
  const claimed = await RestaurantSettlement.findOneAndUpdate(
    { _id: settlementId, status: 'failed' },
    { $set: { status: 'carried_forward' } },
    { new: true }
  );
  if (!claimed) {
    const exists = await RestaurantSettlement.exists({ _id: settlementId });
    throw new ApiError(exists ? 409 : 404, exists ? 'NOT_CARRYABLE' : 'NOT_FOUND', exists ? 'Only a failed payout can be carried forward' : 'Settlement not found');
  }
  const { timezone } = (await getActiveSettings()).settlementCycle;
  const entry = await RestaurantLedgerEntry.create({
    restaurantId: claimed.restaurantId,
    type: 'carry_forward',
    direction: 'credit',
    amountPaise: claimed.totals.netPayable,
    breakdown: { role: 'failed_payout', fromSettlementId: claimed._id, reason: 'payout_failed' },
    eligibleAt: new Date(),
    clearsAt: new Date(),
    createdBy: adminId,
    note: `Unpaid settlement ${periodLabel(claimed, timezone)} carried forward (payout failed: ${claimed.payout?.failureReason ?? 'unknown'})`,
  });
  await logActivity({
    adminId,
    action: 'settlement.carry_forward_failed',
    targetType: 'settlement',
    targetId: claimed._id,
    metadata: { amountPaise: entry.amountPaise, entryId: entry._id },
  });
  return { settlement: claimed, entry };
};

export const listBatches = async ({ status, page = 1, limit = 20 }) => {
  const filter = status ? { status } : {};
  const [batches, total] = await Promise.all([
    PayoutBatch.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    PayoutBatch.countDocuments(filter),
  ]);
  return { batches, total, page, limit };
};

export const getBatchDetail = async (batchId) => {
  const batch = await loadBatch(batchId);
  // By the batch's own list, so a settlement later retried on another batch still shows here as
  // part of this run's history (with its current status).
  const settlements = await RestaurantSettlement.find({ _id: { $in: batch.settlementIds } })
    .populate('restaurantId', 'name payoutAccount.accountNumberLast4 payoutAccount.ifsc')
    .lean();
  return { batch: batch.toObject(), settlements };
};
