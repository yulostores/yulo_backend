// "Choose your business" on the careers portal (yulo_careers): a shop applying to become a Yulo
// coupon partner — the sellers whose coupons customers get after ordering food. A lead for the
// partnerships team, with a ₹100 form fee paid after submitting (same flow as job applications).
// Keys are stored on each application; labels can be reworded later.

export const PARTNER_CATEGORIES = [
  { key: 'salon', label: 'Salon' },
  { key: 'grocery', label: 'Grocery Store' },
  { key: 'clothing', label: 'Clothes Store' },
  // "Other" asks the applicant to type what kind of store it is (otherCategory).
  { key: 'other', label: 'Other' },
];

// pending_payment → (fee paid) new → contacted → onboarded | rejected
export const PARTNER_APPLICATION_STATUSES = ['pending_payment', 'new', 'contacted', 'onboarded', 'rejected'];
export const PARTNER_REVIEW_STATUSES = PARTNER_APPLICATION_STATUSES.filter((s) => s !== 'pending_payment');

// The form fee, in paise, everything included.
export const PARTNER_APPLICATION_FEE_PAISE = 100 * 100;

export const MAX_EMPLOYEES = 100_000;

export const partnerCategoryLabel = (key, other) =>
  key === 'other' && other ? `Other — ${other}` : PARTNER_CATEGORIES.find((c) => c.key === key)?.label ?? key ?? null;
