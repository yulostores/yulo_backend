// Checks that every index the models declare actually exists in the database.
//
//   node scripts/checkIndexes.js
//
// Read-only. Exits 1 when a UNIQUE index is missing — those are what make money writes
// idempotent (one ledger row per order/bill, one settlement per restaurant-week, one webhook
// event processed once, one Finance Settings version per number…) and Mongoose builds them in
// the background at boot, logging nothing if the build fails (duplicate data, a race on an
// empty database). Missing non-unique indexes are reported but only slow queries down.
// Indexes that exist but no model declares are listed for information; nothing is dropped.
//
// Run it after every deploy that changes a model (DEPLOYMENT.md). To fix a missing unique
// index: find and resolve the duplicates the build tripped on, then restart the app (or run
// the model's syncIndexes from a script) and check again.

import 'dotenv/config';
import { readdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import mongoose from 'mongoose';

const MODELS_DIR = fileURLToPath(new URL('../models/', import.meta.url));

/** Imports every model file so mongoose.models holds them all. */
export const loadAllModels = async () => {
  for (const file of await readdir(MODELS_DIR)) {
    if (file.endsWith('.js')) await import(pathToFileURL(`${MODELS_DIR}${file}`).href);
  }
  return Object.values(mongoose.models);
};

const keyOf = (fields) => JSON.stringify(fields);

/**
 * Compares each model's declared indexes with the collection's. Exported for tests.
 * Returns { ok, missingUnique: [{ model, keys }], missing: [{ model, keys }], extra: [{ model, name }] }.
 */
export const checkIndexes = async ({ models, log = console.log } = {}) => {
  const all = models ?? (await loadAllModels());
  const result = { ok: true, missingUnique: [], missing: [], extra: [] };

  for (const Model of all) {
    let existing = [];
    try {
      existing = await Model.collection.indexes();
    } catch (err) {
      if (err?.codeName !== 'NamespaceNotFound') throw err; // no collection yet → nothing exists
    }
    const existingKeys = new Set(existing.map((ix) => keyOf(ix.key)));
    const declared = Model.schema.indexes(); // [[fields, options], …], field-level indexes included

    for (const [fields, options = {}] of declared) {
      if (existingKeys.has(keyOf(fields))) continue;
      const entry = { model: Model.modelName, keys: fields, unique: Boolean(options.unique) };
      if (entry.unique) result.missingUnique.push(entry);
      else result.missing.push(entry);
    }
    const declaredKeys = new Set(declared.map(([fields]) => keyOf(fields)));
    for (const ix of existing) {
      if (ix.name === '_id_' || declaredKeys.has(keyOf(ix.key))) continue;
      result.extra.push({ model: Model.modelName, name: ix.name });
    }
  }

  for (const m of result.missingUnique) log(`MISSING UNIQUE  ${m.model}  ${keyOf(m.keys)}`);
  for (const m of result.missing) log(`missing         ${m.model}  ${keyOf(m.keys)}`);
  for (const e of result.extra) log(`not declared    ${e.model}  ${e.name}`);
  result.ok = result.missingUnique.length === 0;
  log(
    result.ok
      ? `OK — every unique index is in place (${result.missing.length} non-unique missing, ${result.extra.length} undeclared)`
      : `FAIL — ${result.missingUnique.length} unique index(es) missing`
  );
  return result;
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  // autoIndex off: this script reports what the APP built, it must not build anything itself.
  mongoose.set('autoIndex', false);
  mongoose
    .connect(process.env.MONGODB_URI)
    .then(async () => {
      const { ok } = await checkIndexes();
      if (!ok) process.exitCode = 1;
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => mongoose.disconnect());
}
