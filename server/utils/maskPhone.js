// Phone numbers are personal data and OTP logging is one of the noisiest paths in
// the app — enough digits to correlate a support ticket with a log line, not enough
// to identify the customer from the log alone.
export const maskPhone = (phone) => {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 4) return '****';
  return `${'*'.repeat(digits.length - 4)}${digits.slice(-4)}`;
};
