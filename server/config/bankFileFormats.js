import { csvCell } from '../utils/csv.js';

// Bulk-payment file layouts for paying restaurants through the company's net banking
// (services/payoutProviders/bankFile.provider.js). Every Indian bank's corporate net banking
// accepts a bulk NEFT/IMPS upload, but each wants its own columns, order and file type — so
// each bank is one preset here, and switching bank is a Finance Settings change
// (payoutBankFileFormat), not a code change.
//
// Only 'generic_csv' exists today: Yulo's current account isn't open yet. When it is, download
// the bank's bulk-upload template (no real data), and add a preset that reproduces it exactly —
// usually just the columns array and the payment-mode/date formatting below.
//
// Each preset:
//   label             shown in the admin portal
//   extension/mime    the downloaded file's type
//   impsMaxRupees     payments up to this amount go IMPS (instant), above it NEFT
//   columns           the payment-file columns: { header, value(line) }, in order
//   response          how to read the bank's result file back (reconciliation): the header of
//                     the column holding our reference, the status, the UTR and the reason, plus
//                     which status values mean paid / failed / returned
//
// `line` is { reference, beneficiaryName, accountNumber, ifsc, amountRupees, mode, email,
//             phone, restaurantName, periodLabel, narration }.


export const BANK_FILE_FORMATS = {
  generic_csv: {
    label: 'Generic CSV (until the bank is chosen)',
    extension: 'csv',
    mime: 'text/csv; charset=utf-8',
    impsMaxRupees: 500000,
    columns: [
      { header: 'Payment Reference', value: (l) => l.reference },
      { header: 'Beneficiary Name', value: (l) => l.beneficiaryName },
      { header: 'Beneficiary Account Number', value: (l) => l.accountNumber },
      { header: 'IFSC', value: (l) => l.ifsc },
      { header: 'Amount', value: (l) => l.amountRupees.toFixed(2) },
      { header: 'Payment Mode', value: (l) => l.mode },
      { header: 'Beneficiary Email', value: (l) => l.email ?? '' },
      { header: 'Beneficiary Mobile', value: (l) => l.phone ?? '' },
      { header: 'Narration', value: (l) => l.narration },
    ],
    response: {
      referenceColumn: 'Payment Reference',
      statusColumn: 'Status',
      utrColumn: 'UTR',
      reasonColumn: 'Reason',
      paidValues: ['paid', 'success', 'successful', 'processed', 'completed'],
      failedValues: ['failed', 'rejected', 'failure'],
      returnedValues: ['returned', 'reversed', 'bounced'],
    },
  },
};

export const BANK_FILE_FORMAT_IDS = Object.keys(BANK_FILE_FORMATS);

export const getBankFileFormat = (id) => BANK_FILE_FORMATS[id] ?? BANK_FILE_FORMATS.generic_csv;

/** The payment file text for `lines` in `format`. */
export const buildBankFile = (format, lines) => {
  const rows = [format.columns.map((c) => csvCell(c.header)).join(',')];
  for (const line of lines) rows.push(format.columns.map((c) => csvCell(c.value(line))).join(','));
  return `${rows.join('\n')}\n`;
};

// Minimal CSV reader for the bank's response file (quoted cells, commas inside quotes).
const parseCsv = (text) => {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
};

/**
 * The bank's response file → [{ reference, status: 'paid'|'failed'|'returned'|'unknown', utr,
 * reason, raw }]. Columns are found by header name (case-insensitive), so the bank adding or
 * reordering columns doesn't break it.
 */
export const parseBankResponse = (format, text) => {
  const [header, ...body] = parseCsv(String(text ?? ''));
  if (!header) return [];
  const r = format.response;
  const idx = (name) => header.findIndex((h) => h.trim().toLowerCase() === name.toLowerCase());
  const at = { reference: idx(r.referenceColumn), status: idx(r.statusColumn), utr: idx(r.utrColumn), reason: idx(r.reasonColumn) };
  if (at.reference < 0 || at.status < 0) {
    throw new Error(`Response file must have "${r.referenceColumn}" and "${r.statusColumn}" columns`);
  }
  return body.map((cells) => {
    const raw = (cells[at.status] ?? '').trim().toLowerCase();
    let status = 'unknown';
    if (r.paidValues.includes(raw)) status = 'paid';
    else if (r.failedValues.includes(raw)) status = 'failed';
    else if (r.returnedValues.includes(raw)) status = 'returned';
    return {
      reference: (cells[at.reference] ?? '').trim(),
      status,
      utr: at.utr >= 0 ? (cells[at.utr] ?? '').trim() || null : null,
      reason: at.reason >= 0 ? (cells[at.reason] ?? '').trim() || null : null,
      raw,
    };
  });
};
