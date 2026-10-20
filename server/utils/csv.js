// One CSV cell, safe to open in a spreadsheet.
//
// Quoted when it holds a comma, quote or line break. A cell that a spreadsheet would read as a
// formula (=, +, -, @, tab or CR first) is prefixed with ' — an account holder's name or a
// restaurant name like =HYPERLINK(…) must stay text when an admin opens the export in Excel.
// Plain numbers (−12.42, −1,234.50) and phone numbers (+91 98765 43210, +91-98765-43210,
// +1 (555) 010-0000) are left alone so they still read as numbers: digits and separators only —
// nothing a spreadsheet could run as a function.
const FORMULA_START = /^[=+\-@\t\r]/;
const NUMERIC = /^[+-]?\(?[0-9][0-9 .,()-]*$/;

export const csvCell = (v) => {
  let s = String(v ?? '');
  if (FORMULA_START.test(s) && !NUMERIC.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
