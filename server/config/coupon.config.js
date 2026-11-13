// Reference data for the coupon system (COUPON_IMPLEMENTATION_PROMPTS.md § Business rules).
//
// These are SEED values only: scripts/seedCouponData.js writes them once, and from then on the
// database is authoritative — the super admin edits plans (CouponPlan), categories
// (CouponCategory) and rules (CouponSettings versions). Nothing at runtime should read a price,
// count or rate from this file; read the model instead.
//
// Units: money in integer PAISE, percentages as plain percent numbers (18 = 18 %), distances in km.

// Coupon partner subscription plans. Prices are GST-EXCLUSIVE; GST is added on top
// (utils/couponPricing.js#planTotals). `complimentaryCount` coupons are created in addition to
// `couponAllocation` and reserved for Yulo team members — never shown to sellers or customers.
export const SEED_COUPON_PLANS = [
  { key: 'basic', name: 'Basic', basePricePaise: 500_000, gstPercent: 18, couponAllocation: 250, complimentaryCount: 5, sortOrder: 1 },
  { key: 'plus', name: 'Plus', basePricePaise: 1_500_000, gstPercent: 18, couponAllocation: 900, complimentaryCount: 5, sortOrder: 2 },
  { key: 'premium', name: 'Premium', basePricePaise: 5_000_000, gstPercent: 18, couponAllocation: 4_000, complimentaryCount: 5, sortOrder: 3 },
];

// Business categories a seller belongs to and a customer receives coupons from. All start
// DISABLED: customers get coupons only from categories a super admin has switched on.
export const SEED_COUPON_CATEGORIES = [
  { key: 'salon', name: 'Salon', sortOrder: 1 },
  { key: 'grocery', name: 'Grocery Store', sortOrder: 2 },
  { key: 'spa', name: 'Spa', sortOrder: 3 },
  { key: 'clothing', name: 'Clothing Store', sortOrder: 4 },
  { key: 'other', name: 'Other', sortOrder: 5 },
];

// CouponSettings version 1. Every value marked (assumption) in § Business rules lives here so
// a client answer is a settings change, not a code change.
// Every coupon is valid for exactly this many days from when it is issued — fixed by the business
// (Nov 2026): sellers can't set their own validity and Coupon Settings can't change it.
export const COUPON_VALIDITY_DAYS = 30;

// A plan bought ONLINE (Razorpay) adds a payment handling fee of this percent of the plan price,
// and GST is then charged on price + fee. Offline payments recorded by Yulo ("Amount Received")
// pay the plan price + GST only. Basic online: ₹5,000 + ₹175 + 18 % of ₹5,175 = ₹6,106.50.
export const PLAN_ONLINE_HANDLING_FEE_PERCENT = 3.5;

export const SEED_COUPON_SETTINGS = {
  perOrderCap: 3, // most coupons one paid food order can issue (one per enabled category)
  minOrderValuePaise: 0, // orders below this issue nothing
  defaultValidityDays: COUPON_VALIDITY_DAYS, // fixed — see COUPON_VALIDITY_DAYS
  radiusKm: 10, // sellers further than this from the ordering restaurant are not picked
  reminderLeadDays: 3, // reminder SMS this many days before expiry
  smsPricePaise: 300, // ₹3.00 per SMS, GST-exclusive
  smsGstPercent: 18, // → ₹3.54 per SMS
  smsCreditPackSizes: [100, 500, 1000], // credits per purchasable pack; price = size × SMS price + GST
  agreementVersion: 0, // 0 = no partner agreement published yet
  agreementText: '',
  // Redemption: require the last 4 digits of the customer's phone before a seller can redeem
  // (§ Business rules — Redemption, optional check). Off by default; when off, a seller may still
  // send the digits and they are checked.
  phoneCheckRequired: false,
};

export const SELLER_STATUSES = ['pending', 'active', 'suspended', 'rejected'];
export const SELLER_ROLES = ['owner', 'manager', 'employee'];
export const GENDERS = ['male', 'female', 'other'];
export const SUBSCRIPTION_STATUSES = ['pending_payment', 'active', 'exhausted', 'cancelled'];
export const MANUAL_PAYMENT_MODES = ['neft', 'upi', 'cash', 'cheque', 'other'];
export const OFFER_STATUSES = ['draft', 'pending_review', 'approved', 'rejected', 'paused'];
export const COUPON_KINDS = ['customer', 'complimentary'];
export const COUPON_STATUSES = ['issued', 'redeemed', 'expired', 'void'];
export const COUPON_SOURCE_TYPES = ['order', 'bill', 'manual', 'plan'];
export const SELLER_DOCUMENT_TYPES = ['gst_certificate', 'pan_card', 'aadhaar_card', 'shop_photo', 'business_registration', 'other'];
export const SMS_CAMPAIGN_STATUSES = ['draft', 'queued', 'sending', 'done', 'failed'];
export const SMS_LOG_STATUSES = ['queued', 'sent', 'failed'];

// What each seller role may do. The SERVER enforces these per route
// (middleware/authorizeSellerRole.js); this list is also served by GET /api/seller/auth/me so the
// portal can hide what a user can't use — which is cosmetic only.
export const SELLER_PERMISSIONS = Object.freeze({
  owner: Object.freeze([
    'dashboard.view',
    'reports.view',
    'plans.view',
    'plans.buy',
    'offers.manage',
    'reminders.view',
    'reminders.buy',
    'agreement.view',
    'agreement.accept',
    'profile.view',
    'profile.edit',
    'team.manage_all',
    'onboarding.edit',
    'redeem',
  ]),
  manager: Object.freeze([
    'dashboard.view',
    'reports.view',
    'plans.view',
    'offers.manage',
    'reminders.view',
    'reminders.buy',
    'agreement.view',
    'profile.view',
    'team.manage_employees',
    'redeem',
  ]),
  employee: Object.freeze(['redeem']),
});
