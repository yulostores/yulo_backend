// The Yulo careers portal (yulo_careers): who can apply for what, and what applying costs.
//
// The catalogue is served to both the application form and the super admin portal
// (GET /api/careers/positions), so a department or role added here shows up in both without
// a frontend release. Keys are stored on each application; labels are only for display, so a
// label can be reworded later without touching saved applications. Never remove or rename a
// key that applications already use — retire it with `open: false` instead, which hides it
// from the form while old applications keep their label.

// Nov 2026 list (client's form spec). Roles retired then keep `open: false`, so applications
// that already use them still show their label; they are no longer offered on the form.
export const JOB_DEPARTMENTS = [
  {
    key: 'marketing',
    label: 'Marketing',
    roles: [
      { key: 'digital_marketing_expert', label: 'Digital Marketing Expert' },
      { key: 'direct_marketing_executive', label: 'Direct Marketing Executive' },
      { key: 'performance_marketer', label: 'Performance Marketer' },
      { key: 'ads_specialist_meta', label: 'Ads Specialist - Meta' },
      // Moved to Sales.
      { key: 'relationship_manager', label: 'Relationship Manager', open: false },
    ],
  },
  {
    key: 'social_media',
    label: 'Social Media',
    roles: [
      { key: 'social_media_manager', label: 'Social Media Manager' },
      { key: 'content_creator', label: 'Content Creator' },
      { key: 'social_media_strategist', label: 'Social Media Strategist' },
      { key: 'influencer', label: 'Influencer' },
      { key: 'small_reel_creator', label: 'Small Reel Creator' },
    ],
  },
  {
    key: 'designing',
    label: 'Designing & Creating',
    roles: [
      { key: 'canva_designer', label: 'Canva Designer' },
      { key: 'video_creator', label: 'Video Creator' },
      { key: 'video_editor', label: 'Video Editor' },
      { key: 'content_writer', label: 'Content Writer' },
      { key: 'graphic_designer', label: 'Graphic Designer', open: false },
      { key: 'editor', label: 'Editor', open: false },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    roles: [
      { key: 'sales_executive', label: 'Sales Executive' },
      { key: 'in_store_sales', label: 'In Store Sales' },
      { key: 'field_sales', label: 'Field Sales Executive' },
      { key: 'sales_manager', label: 'Sales Manager' },
      { key: 'area_sales_manager', label: 'Area Sales Manager' },
      { key: 'relationship_manager', label: 'Relationship Manager' },
      { key: 'merchant_onboarding_executive', label: 'Merchant Onboarding Executive' },
      { key: 'business_development_executive', label: 'Business Development Executive' },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    roles: [
      { key: 'calling', label: 'Telecalling Executive' },
      { key: 'customer_support_executive', label: 'Customer Support Executive' },
      { key: 'merchant_support_executive', label: 'Merchant Support Executive' },
      { key: 'operations_manager', label: 'Operations Manager' },
    ],
  },
  {
    // Folded into Sales (Business Development Executive); kept for older applications.
    key: 'business_development',
    label: 'Business Development',
    open: false,
    roles: [{ key: 'business_development_executive', label: 'Business Development Executive' }],
  },
  {
    key: 'developer',
    label: 'Developer',
    roles: [
      { key: 'frontend', label: 'Frontend' },
      { key: 'backend', label: 'Backend' },
      { key: 'full_stack', label: 'Full-Stack' },
      { key: 'ui_ux', label: 'UI UX' },
      { key: 'testing_debugging', label: 'Testing & Debugging' },
    ],
  },
  {
    key: 'delivery',
    label: 'Delivery',
    roles: [
      { key: 'delivery_partner_part_time', label: 'Delivery Partner Part-time' },
      { key: 'delivery_partner_full_time', label: 'Delivery Partner Full-time' },
      { key: 'delivery_head', label: 'Delivery Head' },
      { key: 'delivery_partner', label: 'Delivery Partner', open: false },
    ],
  },
  {
    key: 'restaurant',
    label: 'Restaurant',
    roles: [
      { key: 'chef', label: 'Chef, Cook, Chinese Chef, Halwai' },
      { key: 'waiter', label: 'Waiter' },
      { key: 'helper', label: 'Kitchen Helper' },
      { key: 'cleaner_helper', label: 'Cleaner & Helper' },
      { key: 'restaurant_manager', label: 'Restaurant, Cafe Manager' },
      { key: 'counter_billing_executive', label: 'Counter Billing Executive' },
    ],
  },
  {
    key: 'salon',
    label: 'Salon',
    roles: [
      { key: 'barber', label: 'Barber - Unisex' },
      { key: 'hair_stylist', label: 'Hair Stylist, Hair Dresser' },
      { key: 'makeup_artist', label: 'Makeup Artist' },
      { key: 'nail_artist', label: 'Nail Artist' },
      { key: 'mehendi_artist', label: 'Mehendi Artist' },
      { key: 'spa_massage_therapist', label: 'Spa & Massage Therapist' },
      { key: 'salon_receptionist', label: 'Salon Receptionist' },
      { key: 'salon_manager', label: 'Salon Manager' },
      { key: 'salon_helper', label: 'Salon Helper' },
    ],
  },
  {
    key: 'other',
    label: 'Other',
    roles: [
      { key: 'fresher', label: 'Fresher' },
      { key: 'student', label: 'Student' },
    ],
  },
];

// One application may name up to this many roles, all in the same position.
export const MAX_ROLES_PER_APPLICATION = 3;

export const EDUCATION_LEVELS = [
  { key: 'below_10th', label: 'Below 10th' },
  { key: '10th', label: '10th pass' },
  { key: '12th', label: '12th pass' },
  { key: 'diploma', label: 'Diploma / ITI' },
  { key: 'graduate', label: 'Graduate' },
  { key: 'post_graduate', label: 'Post Graduate' },
  { key: 'other', label: 'Other' },
];

export const GENDERS = ['male', 'female', 'other'];

// What the hiring team moves an application through. `pending_payment` is before the form fee
// is paid — those are not applications yet and stay out of the admin list by default.
export const APPLICATION_STATUSES = ['pending_payment', 'new', 'shortlisted', 'interview', 'hired', 'rejected'];
export const REVIEW_STATUSES = APPLICATION_STATUSES.filter((s) => s !== 'pending_payment');

// The form fee, in paise, everything included (no GST or handling fee is added on top).
export const APPLICATION_FEE_PAISE = 100 * 100;

// Applicant age bounds, in whole years on the day they apply.
export const MIN_AGE = 16;
export const MAX_AGE = 70;

// Monthly salary, rupees.
export const MAX_SALARY_RUPEES = 10_00_000;

export const RESUME_MAX_MB = 5;

const departmentByKey = new Map(JOB_DEPARTMENTS.map((d) => [d.key, d]));

export const findDepartment = (key) => departmentByKey.get(key) ?? null;
export const findRole = (departmentKey, roleKey) =>
  findDepartment(departmentKey)?.roles.find((r) => r.key === roleKey) ?? null;
export const educationLabel = (key) => EDUCATION_LEVELS.find((e) => e.key === key)?.label ?? key ?? null;
