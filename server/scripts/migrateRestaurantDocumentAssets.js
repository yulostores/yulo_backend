// One-off repair for compliance documents uploaded before owner/document.controller.js
// started filing PDFs under Cloudinary's `raw` resource type.
//
// A PDF stored under `image` is governed by the account's "Allow delivery of PDF and ZIP
// files" switch, which is off. Its own delivery URL answers `401 deny or ACL failure`
// forever, so every preview of one has to detour through the signed download endpoint —
// part of the rate-limited Admin API, on a different host, and the round trip that was
// timing out and reaching the portal as a 504.
//
// This moves those assets onto `raw`, where plain CDN delivery serves them, and fills in
// the `publicId` / `resourceType` / `mimeType` fields that documents from before those
// columns existed are missing. After a clean run, serving any document is one ordinary
// CDN fetch with no fallback and no Admin API involvement.
//
// Safe to re-run: a document already in the new shape is skipped, and the old asset is
// only destroyed once the new URL is saved.
//
//   node scripts/migrateRestaurantDocumentAssets.js --dry-run
//   node scripts/migrateRestaurantDocumentAssets.js

import 'dotenv/config';
import mongoose from 'mongoose';
import Restaurant from '../models/Restaurant.js';
import * as uploadService from '../services/upload.service.js';
import { recordMigrationRun } from './_migrationLog.js';

const DRY_RUN = process.argv.includes('--dry-run');
const FETCH_TIMEOUT_MS = 30_000;

const formatOf = (url) => (url ?? '').split('?')[0].match(/\.([a-zA-Z0-9]+)$/)?.[1]?.toLowerCase();

const looksLikePdf = (doc) =>
  doc.mimeType === 'application/pdf' || formatOf(doc.url) === 'pdf';

// The asset shape that cannot be delivered: a PDF under the `image` resource type.
const needsReupload = (doc) => {
  const resourceType = doc.resourceType ?? uploadService.extractResourceType(doc.url);
  return resourceType === 'image' && looksLikePdf(doc);
};

// Split `yulostores/restaurants/<id>/documents/<name>` into the two halves `uploadBuffer`
// wants. Keeping the same name means the new raw asset sits beside the old image one —
// resource types are separate namespaces, so there is no collision — and the stored URL
// changes only in its `/image/` → `/raw/` segment.
const splitPublicId = (publicId) => {
  const cut = publicId.lastIndexOf('/');
  return cut === -1
    ? { folder: undefined, name: publicId }
    : { folder: publicId.slice(0, cut), name: publicId.slice(cut + 1) };
};

// The bytes, via the signed download endpoint — the only door that opens for these.
const downloadLegacyAsset = async (publicId, format) => {
  const url = uploadService.signedDownloadUrl({ publicId, format, resourceType: 'image' });
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`download endpoint answered ${res.status}`);
  }
  return Buffer.from(await res.arrayBuffer());
};

await mongoose.connect(process.env.MONGODB_URI);
console.log(`✓ Connected${DRY_RUN ? '  (dry run — nothing will be written)' : ''}`);

const restaurants = await Restaurant.find({ 'documents.0': { $exists: true } }).select(
  'name documents'
);
console.log(`\nScanning ${restaurants.length} restaurant(s) with documents\n`);

let moved = 0;
let backfilled = 0;
let skipped = 0;
let failed = 0;

for (const restaurant of restaurants) {
  let dirty = false;

  for (const doc of restaurant.documents) {
    const label = `${restaurant.name} · ${doc.type}`;
    const publicId = doc.publicId ?? uploadService.extractPublicId(doc.url);
    const resourceType = doc.resourceType ?? uploadService.extractResourceType(doc.url);

    if (!publicId) {
      console.warn(`  ! ${label}: no public id recoverable from ${doc.url} — left alone`);
      skipped += 1;
      continue;
    }

    if (needsReupload(doc)) {
      if (DRY_RUN) {
        console.log(`  → ${label}: would move image → raw  (${publicId})`);
        moved += 1;
        continue;
      }
      try {
        const bytes = await downloadLegacyAsset(publicId, formatOf(doc.url) ?? 'pdf');
        const { folder, name } = splitPublicId(publicId);
        // Deliberately extensionless, exactly as the controller uploads now: Cloudinary's
        // PDF block keys on the delivery URL's extension, so a raw asset ending `.pdf` is
        // refused just like an image one.
        const uploaded = await uploadService.uploadBuffer({
          buffer: bytes,
          folder,
          publicId: name,
          resourceType: 'raw',
        });

        doc.url = uploaded.secureUrl;
        doc.publicId = uploaded.publicId;
        doc.resourceType = 'raw';
        doc.mimeType = doc.mimeType ?? 'application/pdf';
        dirty = true;

        // Saved before the old asset is touched — a crash between the two leaves a
        // harmless duplicate, whereas the other order loses the file.
        await restaurant.save();
        dirty = false;
        await uploadService.deleteAsset(publicId, 'image').catch((err) => {
          console.warn(`    (old asset not reaped: ${err.message})`);
        });

        console.log(`  ✓ ${label}: moved to raw  (${bytes.length} bytes)`);
        moved += 1;
      } catch (err) {
        console.error(`  ✗ ${label}: ${err.message}`);
        failed += 1;
      }
      continue;
    }

    // Already deliverable — just make sure the record carries what the reader would
    // otherwise have to re-derive from the URL on every request.
    const missing =
      doc.publicId !== publicId || doc.resourceType !== resourceType || !doc.mimeType;
    if (missing) {
      doc.publicId = publicId;
      doc.resourceType = resourceType;
      if (!doc.mimeType && looksLikePdf(doc)) doc.mimeType = 'application/pdf';
      dirty = true;
      console.log(`  ${DRY_RUN ? '→' : '✓'} ${label}: ${DRY_RUN ? 'would backfill' : 'backfilled'} publicId/resourceType`);
      backfilled += 1;
    } else {
      skipped += 1;
    }
  }

  if (dirty && !DRY_RUN) await restaurant.save();
}

console.log(
  `\n${DRY_RUN ? 'Would move' : 'Moved'} ${moved} asset(s) to raw, ${DRY_RUN ? 'backfill' : 'backfilled'} ${backfilled} record(s), skipped ${skipped}, failed ${failed}`
);
if (failed) console.log('Re-run to retry the failures — this script is idempotent.');

if (!DRY_RUN && (moved > 0 || backfilled > 0)) {
  await recordMigrationRun('migrateRestaurantDocumentAssets', {
    assetsMovedToRaw: moved,
    recordsBackfilled: backfilled,
    failed,
  });
}

await mongoose.disconnect();
