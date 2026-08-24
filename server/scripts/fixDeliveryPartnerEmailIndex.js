// One-off fix for a stale index left over from server/models/DeliveryPartner.js's `email` field
// being changed from `{ required: true, unique: true }` to `{ unique: true, sparse: true }` (to
// support OTP self-registration, which creates a partner with no email at all). Mongoose's
// automatic index sync does not alter an existing index's options if one with the same key
// already exists — it only creates indexes that are missing — so any database created before
// that schema change keeps the old non-sparse unique index, which then rejects a second partner
// document with no email at all (sparse indexes only skip documents missing the field entirely;
// a non-sparse unique index treats every missing value as an indexed `null`, colliding on the
// second one). Run this once per environment after pulling that change.
import 'dotenv/config';
import mongoose from 'mongoose';
import DeliveryPartner from '../models/DeliveryPartner.js';

await mongoose.connect(process.env.MONGODB_URI);
console.log('✓ Connected');

const indexes = await DeliveryPartner.collection.getIndexes({ full: true });
const emailIndex = indexes.find((i) => i.name === 'email_1');

if (!emailIndex) {
  console.log('No email_1 index found — nothing to do (a fresh DB will create it sparse already).');
} else if (emailIndex.sparse) {
  console.log('email_1 index is already sparse — nothing to do.');
} else {
  await DeliveryPartner.collection.dropIndex('email_1');
  await DeliveryPartner.collection.createIndex({ email: 1 }, { unique: true, sparse: true });
  console.log('✓ Dropped the non-sparse email_1 index and recreated it as unique + sparse.');
}

await mongoose.disconnect();
