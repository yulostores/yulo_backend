# `server/scripts/` — one-off data scripts

These are hand-run Node scripts, not part of the app runtime. They fall into two
groups:

- **Migrations** — one-time data repairs / backfills for a database that predates
  some schema or write-path change. A genuinely fresh database needs none of
  them; an existing one needs a given script only if it carries data from before
  the change that script repairs.
- **Seeds** — populate reference data. Safe to re-run; needed on every
  environment that wants the data.

Run everything from the `server/` directory with the target database in
`MONGODB_URI` (they load `../.env` via `dotenv/config`):

```bash
cd server
MONGODB_URI="mongodb+srv://…" node scripts/<name>.js [flags]
```

## Run tracking — `migrations_applied`

There is no migration framework here. Instead, each migration script writes one
row to the **`migrations_applied`** collection after a run that actually changed
data (a dry run writes nothing), via [`_migrationLog.js`](./_migrationLog.js):

```js
{ name, appliedAt, host, db, nodeEnv, /* …per-script counts */ }
```

It is **advisory** — nothing reads it to gate a run, and every script below is
safe to re-run regardless. It exists so you can answer "has this been applied on
prod?" from the database:

```js
// mongosh, against the target DB
db.migrations_applied.find().sort({ appliedAt: -1 })
db.migrations_applied.find({ name: "backfillOrderCustomer" })
```

Scripts that no-op (nothing to change) do **not** write a row — absence means
either "never run" or "run but had nothing to do". The index-fix scripts print
which case it was.

When you add or next touch a script here, wire in `recordMigrationRun('<name>',
{ …counts })` at its success point.

## Migrations

| Script | Repairs | Default action | Preview flag | Re-runnable | Scope |
| --- | --- | --- | --- | --- | --- |
| `backfillBillDetails.js` | Missing receipt fields on `Bill` (billNumber, table, snapshot, discountTotal, …) raised before `billing.service` wrote them | dry run | *(runs dry unless `--apply`)* | yes — writes only missing fields; advances bill-number counters past what it allocates | once per env with legacy bills |
| `backfillOrderCustomer.js` | `Order.customerName` / `customerPhone` snapshots for orders placed before `order.service` set them | dry run | *(dry unless `--apply`)* | yes — skips orders already snapshotted | once per env with legacy orders |
| `backfillOrderTableInfo.js` | `Order.tableId` / `tableNumber` / `placedBy` / `statusHistory` for dine-in orders placed before `order.service` set them | dry run | *(dry unless `--apply`)* | yes — each field written only while missing | once per env with legacy dine-in orders |
| `backfillRestaurantApprovalStatus.js` | Adds `approvalStatus` (+ `reviewedAt`) to restaurants created before that field existed | **writes on run** | none | yes — only touches docs missing `approvalStatus` | once per env with legacy restaurants |
| `fixStringifiedRestaurantFields.js` | Restaurants whose `address` / `settings` / `cuisineTypes` were saved as JSON *strings* by the old multipart path; re-geocodes the fixed address | dry run | *(dry unless `--apply`)* | yes — clean docs skipped | once per env if the stringified-multipart bug was hit |
| `migrateRestaurantDocumentAssets.js` | Moves compliance PDFs stored under Cloudinary `image` → `raw`; backfills `publicId` / `resourceType` / `mimeType`. Needs Cloudinary creds + network | **writes on run** | `--dry-run` | yes — migrated docs skipped; old asset deleted only after new URL is saved | once per env with legacy documents |
| `fixUserEmailIndex.js` | Drops a stale non-sparse `email_1` index on `users` and recreates it `unique + sparse` | **writes on run** | none | yes — self-checks; no-ops if already sparse | once per env whose DB predates `User.email` becoming sparse |
| `fixDeliveryPartnerEmailIndex.js` | Same as above for `deliverypartners` | **writes on run** | none | yes — self-checks; no-ops if already sparse | once per env whose DB predates `DeliveryPartner.email` becoming sparse |
| `fixRestaurantActive.js` | **Blunt recovery tool** — force-sets `isActive: true` on *every* restaurant where it isn't. Also prints the full active/inactive list | **writes on run** | none | yes, but it overrides deliberate deactivations — use only for local/dev recovery, never routinely on prod | ad-hoc |

### Suggested order when upgrading an existing database

The scripts are independent (no script depends on another having run), so order
is only about doing related repairs together:

1. `fixStringifiedRestaurantFields.js` — corrupt restaurant docs block later saves
2. `backfillRestaurantApprovalStatus.js`
3. `migrateRestaurantDocumentAssets.js`
4. `backfillOrderCustomer.js`, `backfillOrderTableInfo.js`, `backfillBillDetails.js` — order history / receipts
5. `fixUserEmailIndex.js`, `fixDeliveryPartnerEmailIndex.js` — after pulling the schema change that made those fields sparse

Always do a dry run first where the script supports one, and check
`migrations_applied` afterwards.

## Seeds

| Script | Purpose | Invocation | Re-runnable |
| --- | --- | --- | --- |
| `seedSuperAdmin.js` | Create or promote a super-admin user | `node scripts/seedSuperAdmin.js <email> <password>` | yes — promotes the user if they already exist |
| `seedQuickFilterChips.js` | Populate the customer Home "What's on your mind?" quick-filter chips; uploads icons from `assets/seed/quick-filter-chips/` to Cloudinary | `node scripts/seedQuickFilterChips.js` | yes — upserts keyed on `label`, stable Cloudinary `public_id` |

### Fresh environment bring-up

A brand-new database needs only the seeds:

1. `seedSuperAdmin.js <email> <password>`
2. `seedQuickFilterChips.js`

The migrations have nothing to act on until the database has historical data, and
the index fixes no-op because Mongoose builds those indexes sparse from the start
on a fresh DB.
