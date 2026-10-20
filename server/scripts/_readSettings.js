// Read-only access to Finance Settings for scripts in this directory.
//
// services/financeSettings.service.js's getActiveSettings() SEEDS version 1 from the running
// process's environment when no version exists yet — right for the app, wrong for a script:
// a dry run would write to the database, and a script run from a laptop would freeze that
// laptop's env (COD, platform fee, rider pay…) into production's version 1 for good. Scripts
// read through here instead and refuse to make changes until scripts/seedFinanceSettings.js
// has been run deliberately.

import FinanceSettings from '../models/FinanceSettings.js';

// What version 1 seeds settlementCycle to (financeSettings.service.js) — used only to describe
// a dry run on a database that has no settings yet.
export const DEFAULT_SETTLEMENT_CYCLE = Object.freeze({ weekStartsOn: 'monday', timezone: 'Asia/Kolkata' });

/** The version in force at `at`, or null when none exists. Never writes. */
export const readSettingsReadOnly = (at = new Date()) =>
  FinanceSettings.findOne({ effectiveFrom: { $lte: at } }).sort({ effectiveFrom: -1, version: -1 }).lean();

export const NO_SETTINGS_MESSAGE =
  'No Finance Settings exist yet — run scripts/seedFinanceSettings.js (with the production environment) first';
