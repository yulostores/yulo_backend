// One-off fix for a stale index left over from server/models/User.js's `email` field being
// `{ unique: true, sparse: true }` in the schema while the live database still carries an older
// non-sparse `email_1` index. Mongoose's automatic index sync does not alter an existing index's
// options if one with the same key already exists — it only creates indexes that are missing —
// so any database created before `sparse` was added keeps the old non-sparse unique index, which
// then rejects a second phone-only customer signup with no email at all (a non-sparse unique
// index treats every missing value as an indexed `null`, colliding on the second one). Same root
// cause as docs/delivery-partner-email-index-bug.md, on User instead of DeliveryPartner. Run this
// once per environment after pulling this change.
import 'dotenv/config';
import mongoose from 'mongoose';
import User from '../models/User.js';

await mongoose.connect(process.env.MONGODB_URI);
console.log('✓ Connected');

const indexes = await User.collection.getIndexes({ full: true });
const emailIndex = indexes.find((i) => i.name === 'email_1');

if (!emailIndex) {
  console.log('No email_1 index found — nothing to do (a fresh DB will create it sparse already).');
} else if (emailIndex.sparse) {
  console.log('email_1 index is already sparse — nothing to do.');
} else {
  await User.collection.dropIndex('email_1');
  await User.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
  console.log('✓ Dropped the non-sparse email_1 index and recreated it as unique + sparse.');
}

await mongoose.disconnect();
