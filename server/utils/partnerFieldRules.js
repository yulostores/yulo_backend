// Formats for a delivery partner's identity and bank fields, checked where an admin creates or
// edits a partner (controllers/admin/deliveryPartner.controller.js). The bank details are where
// a rider's weekly pay is sent, and Aadhaar / PAN are their KYC — a mistyped value used to be
// saved as typed ("1234" as an Aadhaar number, "NOTIFSC" as an IFSC).
//
// Values are normalised first — spaces and dashes out, letters upper-cased where the format
// is upper-case — so "abcde 1234 f" or "1234 5678 9012" are accepted as what they mean.

import { ApiError } from './ApiError.js';

const compact = (v) => String(v).replace(/[\s-]/g, '');

const RULES = {
  phone: { normalise: compact, test: /^[6-9]\d{9}$/, message: 'Enter a valid 10-digit mobile number' },
  emergencyPhone: { normalise: compact, test: /^[6-9]\d{9}$/, message: 'Enter a valid 10-digit emergency number' },
  email: { normalise: (v) => String(v).trim().toLowerCase(), test: /^[^\s@]+@[^\s@]+\.[A-Za-z]{2,}$/, message: 'Enter a valid email address' },
  aadharNumber: { normalise: compact, test: /^\d{12}$/, message: 'Aadhaar number must be 12 digits' },
  panNumber: { normalise: (v) => compact(v).toUpperCase(), test: /^[A-Z]{5}\d{4}[A-Z]$/, message: 'Enter a valid PAN, e.g. ABCDE1234F' },
  'bankDetails.accountNumber': { normalise: compact, test: /^\d{9,18}$/, message: 'Account number must be 9 to 18 digits' },
  'bankDetails.ifscCode': { normalise: (v) => compact(v).toUpperCase(), test: /^[A-Z]{4}0[A-Z0-9]{6}$/, message: 'Enter a valid 11-character IFSC, e.g. HDFC0001234' },
};

/**
 * Normalises and checks the partner fields present in `data` (top-level keys and the
 * `bankDetails` sub-object), in place. With `current` (the partner as stored, on an edit),
 * values that didn't change are skipped. Blank values are left alone — every one of these is
 * optional somewhere. Throws 400 VALIDATION_ERROR with `fieldErrors` naming each bad field.
 */
export const checkPartnerFields = (data, current = null) => {
  const fieldErrors = {};
  for (const [path, rule] of Object.entries(RULES)) {
    const [head, tail] = path.split('.');
    const holder = tail ? data[head] : data;
    const key = tail ?? head;
    if (!holder || holder[key] === undefined || holder[key] === null || String(holder[key]).trim() === '') continue;
    // An edit sends every field back: a value saved before these checks, unchanged, is left as it is.
    const was = tail ? current?.[head]?.[tail] : current?.[head];
    if (current && holder[key] === was) continue;
    const value = rule.normalise(holder[key]);
    if (!rule.test.test(value)) fieldErrors[path] = rule.message;
    else holder[key] = value;
  }
  if (Object.keys(fieldErrors).length) {
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(fieldErrors)[0], { fieldErrors });
  }
  return data;
};
