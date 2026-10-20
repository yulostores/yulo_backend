import IdempotencyKey from '../models/IdempotencyKey.js';
import { ApiError } from '../utils/ApiError.js';

// Runs `create` at most once per (scope, key). The first request with a key inserts a
// 'pending' claim and runs; a repeat — retried after a dropped response, or racing it — gets
// { duplicate: true, orderId } once the first finished, or 409 while it is still running.
// A failed `create` releases the claim, so the client's retry with the same key runs anew.
// No key → no protection, just `create()`.
//
// `scope` keeps keys from different restaurants/customers apart — a key only has to be
// unique per client, not globally.
export const runOnce = async ({ scope, key, create }) => {
  if (!key) return create();

  try {
    await IdempotencyKey.create({ scope, key: String(key) });
  } catch (err) {
    if (err?.code !== 11000) throw err;
    const existing = await IdempotencyKey.findOne({ scope, key: String(key) }).lean();
    if (existing?.status === 'done' && existing.resultId) {
      return { orderId: existing.resultId, duplicate: true };
    }
    throw new ApiError(409, 'IDEMPOTENCY_IN_PROGRESS', 'This request is already being processed — please wait');
  }

  try {
    const result = await create();
    await IdempotencyKey.updateOne({ scope, key: String(key) }, { $set: { status: 'done', resultId: result._id } });
    return result;
  } catch (err) {
    await IdempotencyKey.deleteOne({ scope, key: String(key), status: 'pending' }).catch(() => {});
    throw err;
  }
};
