import Razorpay from 'razorpay';
import { env } from '../config/env.js';

// The ONLY place this codebase constructs a Razorpay client. Every payment, capture, refund
// and (later) payout call goes through getRazorpay(), so tests can swap in a fake with
// __setRazorpayForTests() and no test can ever reach the real gateway — the keys in a
// developer's .env are live ones.

let client = null;
let testOverride; // undefined = no override; null = "pretend no gateway is configured"

export const getRazorpay = () => {
  if (testOverride !== undefined) return testOverride;
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  if (!client) {
    client = new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
  }
  return client;
};

// Publishable key handed to clients alongside a Razorpay order. Safe to expose.
export const getRazorpayKeyId = () => (testOverride !== undefined ? 'rzp_test_fake' : env.RAZORPAY_KEY_ID);

// Test-only. Pass a fake exposing the subset of the SDK we use (orders.create,
// payments.fetch, payments.capture), `null` to simulate an unconfigured gateway, or
// `undefined` to restore the real behaviour.
export const __setRazorpayForTests = (fake) => {
  testOverride = fake;
};
