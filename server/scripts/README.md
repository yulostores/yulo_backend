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
`MONGODB_URI`. They load `server/.env` via `dotenv/config` — and **every other
variable in it too** (`COD_ENABLED`, `CART_*`, `DELIVERY_PARTNER_*`…, which
`seedFinanceSettings.js` freezes into Finance Settings version 1). So against
production, run them with the **production environment**: from the App Platform
component console (the env is already there), or locally with
`DOTENV_CONFIG_PATH` pointing at a production env file — never with a dev
checkout's `.env` and only `MONGODB_URI` swapped:

```bash
cd server
DOTENV_CONFIG_PATH=/secure/path/prod.env node scripts/<name>.js [flags]
```

Scripts that need Finance Settings (`backfillLedger.js`, `migratePayoutPeriods.js
--apply`) refuse to run until `seedFinanceSettings.js --apply` has been run — they
never seed it themselves.

## Run tracking — `migrations_applied`

There is no migration framework here. Instead, each migration script writes one
row to the **`migrations_applied`** collection after a run that actually changed
data (a dry run writes nothing — that includes Finance Settings), via [`_migrationLog.js`](./_migrationLog.js):

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
| `backfillPaymentChannel.js` | `Order.paymentChannel` / `Bill.paymentChannel` (`online` · `cod` · `counter`) for documents written before the field existed — read by settlement | dry run | *(dry unless `--apply`)* | yes — only touches docs with no channel | once per env with legacy orders/bills |
| `backfillGstRegistered.js` | Decides `Restaurant.gstRegistered` where nobody has: missing, or `false` with no `gstRegisteredSource` (an old default written back by a save). `true` only for a **valid** GSTIN on file; a malformed number is reported by name and left `false` | dry run | *(dry unless `--apply`)* | yes — never touches a value set by the owner, an admin, on creation or by an earlier run | every env with legacy restaurants — **before the payment release goes live, and again right after** |
| `backfillLedger.js` | Ledger credits with no row yet, in `--since … [--until …]`: delivery/takeaway orders paid online and delivered; orders cancelled by the customer after preparation started; with `--include-bills`, dine-in bills paid online. Real payments only (`pay_…` — simulated ones are skipped). Priced with the settings in force when each order was placed; legacy delivery fees per `--legacy-delivery`. **`--since` = the go-live cut-off** — every row lands in the next payout | dry run | *(dry unless `--apply`)* | yes — anything already credited is skipped | once after the payment release, and to recover a logged ledger-write failure |
| `migrateLegacyRefunds.js` | Orders/bills flagged `refundStatus: 'pending'` by the old code with no `refund` record → `refund { status: 'pending', amountPaise, feeBorneBy: 'platform' }`, so they appear in the admin refunds screen and can be sent. Simulated payments are reported and left alone | dry run | *(dry unless `--apply`)* | yes — migrated docs are no longer untracked | once per env with refunds owed from before the payment release |
| `backfillClearsAt.js` | Ledger rows from before B12 get `clearsAt`: an **unsettled** online earning (order / dine-in bill) moves its `eligibleAt` to the later of its event and Razorpay's T+2 working-day clearance; rows already in a statement, and every non-online row, keep their date (`clearsAt = eligibleAt`) | dry run | *(dry unless `--apply`)* | yes — only rows with no `clearsAt` | once per env with ledger rows from before B12 — after `backfillLedger.js` |
| `backfillPartnerDeliveries.js` | Riders' `totalDeliveries` (never incremented before this release): counts every delivered order with a rider and no `deliveryAssignment.countedAt`, marks it counted, adds it to the rider's total. From this release each delivery is counted live, once | dry run | *(dry unless `--apply`)* | yes — only uncounted delivered orders | once per env with deliveries from before this release |
| `migrateTicketStatuses.js` | Support tickets on the pre-B12 statuses: `in_progress` → `in_review`, `closed` → `resolved` (keeps `resolvedAt`, else `updatedAt`). The app already writes and reads the new values; this aligns stored data | dry run | *(dry unless `--apply`)* | yes — finds nothing once no old value is left | once per env after the payment-issues release |
| `backfillRestaurantApprovalStatus.js` | Adds `approvalStatus` (+ `reviewedAt`) to restaurants created before that field existed | **writes on run** | none | yes — only touches docs missing `approvalStatus` | once per env with legacy restaurants |
| `migratePayoutPeriods.js` | Rider payout rows keyed on the old (UTC) period start: deletes pending ones (moving admin incentives/deductions onto the current IST-keyed row), keeps paid ones as history and reports them. The app already refuses to pay old-format rows. Dry run is read-only; `--apply` needs Finance Settings seeded | dry run | *(dry unless `--apply`)* | yes — finds nothing once the old pending rows are gone | once per env with rider payouts from before B10 |
| `fixStringifiedRestaurantFields.js` | Restaurants whose `address` / `settings` / `cuisineTypes` were saved as JSON *strings* by the old multipart path; re-geocodes the fixed address | dry run | *(dry unless `--apply`)* | yes — clean docs skipped | once per env if the stringified-multipart bug was hit |
| `migrateRestaurantDocumentAssets.js` | Moves compliance PDFs stored under Cloudinary `image` → `raw`; backfills `publicId` / `resourceType` / `mimeType`. Needs Cloudinary creds + network | **writes on run** | `--dry-run` | yes — migrated docs skipped; old asset deleted only after new URL is saved | once per env with legacy documents |
| `fixUserEmailIndex.js` | Drops a stale non-sparse `email_1` index on `users` and recreates it `unique + sparse` | **writes on run** | none | yes — self-checks; no-ops if already sparse | once per env whose DB predates `User.email` becoming sparse |
| `fixDeliveryPartnerEmailIndex.js` | Same as above for `deliverypartners` | **writes on run** | none | yes — self-checks; no-ops if already sparse | once per env whose DB predates `DeliveryPartner.email` becoming sparse |
| `fixPayoutPeriodIndex.js` | Rider payouts: replaces the unique index `{partnerId, periodStart}` with `{partnerId, periodType, periodStart}` so a weekly and a monthly payout starting the same day stop colliding (B10). Uses `syncIndexes`, so it also drops any index on `payouts` the model doesn't declare | **writes on run** | none | yes — drops the old index only if present | **required** once per env with existing payouts, as part of the payment release |
| `checkIndexes.js` | Read-only check that every index the models declare exists. Exits 1 if a **unique** index is missing (they keep ledger/settlement/webhook writes idempotent, and Mongoose's background build fails silently on duplicate data) | read-only | — | yes | after every deploy that changes a model |
| `fixRestaurantActive.js` | **Blunt recovery tool** — force-sets `isActive: true` on *every* restaurant where it isn't. Also prints the full active/inactive list | **writes on run** | none | yes, but it overrides deliberate deactivations — use only for local/dev recovery, never routinely on prod | ad-hoc |

### Suggested order when upgrading an existing database

Most scripts are independent; the payment-release ones are not — follow the
step-by-step runbook in `../DEPLOYMENT.md` → *Releasing the payment & settlement
update* for those (GST backfill before go-live, Finance Settings before the
ledger backfill, the ledger backfill after in-flight orders finish). For the rest:

1. `fixStringifiedRestaurantFields.js` — corrupt restaurant docs block later saves
2. `backfillRestaurantApprovalStatus.js`
3. `migrateRestaurantDocumentAssets.js`
4. `backfillOrderCustomer.js`, `backfillOrderTableInfo.js`, `backfillBillDetails.js` — order history / receipts
5. `fixUserEmailIndex.js`, `fixDeliveryPartnerEmailIndex.js` — after pulling the schema change that made those fields sparse
6. The payment release: `backfillGstRegistered.js`, `fixPayoutPeriodIndex.js`, `seedFinanceSettings.js`,
   `backfillPaymentChannel.js`, `migratePayoutPeriods.js`, `migrateLegacyRefunds.js`, `backfillLedger.js`, `backfillClearsAt.js`,
   `migrateTicketStatuses.js`, `backfillPartnerDeliveries.js`, `checkIndexes.js` — in the order DEPLOYMENT.md gives

Always do a dry run first where the script supports one, and check
`migrations_applied` afterwards.

## Maintenance

Ongoing jobs — meant to run on a recurring schedule (a cron job / platform scheduled
job), not once.

| Script | Does | Default action | Preview flag | Schedule |
| --- | --- | --- | --- | --- |
| `cleanupStaleGuests.js` | Deletes guest accounts (`role: 'guest'`, from `POST /api/auth/customer/guest`) older than `--days` (default 7) that were never upgraded to a real customer, plus their cart/favorites/search history | dry run | *(dry unless `--apply`)* | e.g. daily |

## Seeds

| Script | Purpose | Invocation | Re-runnable |
| --- | --- | --- | --- |
| `seedSuperAdmin.js` | Create or promote a super-admin user | `node scripts/seedSuperAdmin.js <email> <password>` | yes — promotes the user if they already exist |
| `seedFinanceSettings.js` | Create Finance Settings version 1 (fees, rates, COD switch). Dry run prints the values it would seed and which come from env vars in the environment it runs in; `--apply` seeds and prints it. Version 1 can never be edited — run it once, deliberately, with the production environment, before traffic (the server would otherwise seed itself from whatever env it boots with) | `node scripts/seedFinanceSettings.js [--apply]` | yes — with any version present it only prints the active one |
| `seedSettlementDemo.js` | **Local/staging only** (refuses `NODE_ENV=production`). A demo restaurant (login `demo-owner@yulo.local` / `DemoOwner@123`) with last week's ledger holding every Payment Flow case + a refund + a cancel-after-preparation; `--generate` also generates that week's settlement | `node scripts/seedSettlementDemo.js [--generate]` | yes — deletes its own previous demo data first |
| `seedQuickFilterChips.js` | Populate the customer Home "What's on your mind?" quick-filter chips; uploads icons from `assets/seed/quick-filter-chips/` to Cloudinary | `node scripts/seedQuickFilterChips.js` | yes — upserts keyed on `label`, stable Cloudinary `public_id` |

### Fresh environment bring-up

A brand-new database needs only the seeds:

1. `seedSuperAdmin.js <email> <password>`
2. `seedQuickFilterChips.js`
3. `seedFinanceSettings.js` then `seedFinanceSettings.js --apply` — check the printed values first

The migrations have nothing to act on until the database has historical data, and
the index fixes no-op because Mongoose builds those indexes sparse from the start
on a fresh DB.
