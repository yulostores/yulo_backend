import crypto from 'crypto';
import WebhookEvent from '../models/WebhookEvent.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import * as paymentService from '../services/payment.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import logger from '../utils/logger.js';

// Claims an event for processing. Returns the WebhookEvent row, or null when that event has
// already been processed (or ignored/failed for good), or is being processed right now — a
// redelivery to acknowledge and skip.
//
// Atomic: the upsert matches only a row that is NOT finished, so a finished row makes the
// upsert try to insert a second row with the same id, which the unique index rejects (11000).
// That is exactly the "already done" signal, without a read-then-write race between two
// deliveries of the same event arriving together. The body hash is unique too, so the same
// signed body under a different event-id header is the same event (11000 as well).
const claimEvent = async (eventId, eventType, bodyHash) => {
  try {
    return await WebhookEvent.findOneAndUpdate(
      { provider: 'razorpay', eventId, status: 'processing' },
      {
        $setOnInsert: { provider: 'razorpay', eventId, bodyHash, event: eventType, receivedAt: new Date() },
        $inc: { attempts: 1 },
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    if (err?.code === 11000) return null;
    throw err;
  }
};

// req.body is a raw Buffer here, not a parsed object — this route is mounted with
// express.raw() ahead of the global express.json() (see app.js) specifically so the
// signature check below sees the exact bytes Razorpay signed, not a re-serialized copy.
export const handleRazorpayWebhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.body;

  if (!Buffer.isBuffer(rawBody) || !paymentService.verifyWebhookSignature(rawBody.toString('utf8'), signature)) {
    logger.warn('Razorpay webhook signature verification failed');
    throw new ApiError(400, 'INVALID_SIGNATURE', 'Invalid webhook signature');
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Webhook body is not valid JSON');
  }

  // Razorpay repeats x-razorpay-event-id on every retry of the same event. A body hash is
  // the fallback for a delivery without it — identical bytes are the same event — and is also
  // claimed alongside the header, which the signature doesn't cover.
  const bodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  const eventId = req.headers['x-razorpay-event-id'] || `sha256:${bodyHash}`;

  const record = await claimEvent(eventId, event?.event ?? 'unknown', bodyHash);
  if (!record) {
    return sendSuccess(res, 200, 'Already processed', null);
  }

  try {
    const outcome = await paymentService.handleWebhookEvent(event);
    record.status = outcome === 'ignored' ? 'ignored' : 'processed';
    record.processedAt = new Date();
    record.error = null;
    await record.save();
  } catch (err) {
    if (err?.transient || !(err instanceof ApiError)) {
      // Gateway unreachable, database hiccup… — leave the row 'processing' and answer
      // non-2xx so Razorpay redelivers; the next attempt re-claims the same row.
      logger.error({ err, eventId, event: event?.event }, 'Razorpay webhook processing failed — will be retried');
      record.error = err?.message ?? String(err);
      await record.save().catch(() => {});
      throw err;
    }
    // A permanent failure: retrying would fail the same way, and an endless retry loop helps
    // nobody. Recorded with the reason and acknowledged.
    logger.error({ err, eventId, event: event?.event }, 'Razorpay webhook failed permanently');
    record.status = 'failed';
    record.processedAt = new Date();
    record.error = err.message;
    await record.save();
  }

  // Razorpay requires a 2xx to consider this delivered — anything else triggers
  // automatic retries, including for event types handleWebhookEvent silently ignores.
  sendSuccess(res, 200, 'ok', null);
});
