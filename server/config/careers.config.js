// The Yulo careers portal (yulo_careers): who can apply for what, and what applying costs.
//
// The catalogue is served to both the application form and the super admin portal
// (GET /api/careers/positions), so a department or role added here shows up in both without
// a frontend release. Keys are stored on each application; labels are only for display, so a
// label can be reworded later without touching saved applications. Never remove or rename a
// key that applications already use — retire it with `open: false` instead, which hides it
// from the form while old applications keep their label.

export const JOB_DEPARTMENTS = [
  {
    key: 'marketing',
    label: 'Marketing',
    roles: [
      { key: 'digital_marketing_expert', label: 'Digital Marketing Expert' },
      { key: 'relationship_manager', label: 'Relationship Manager' },
    ],
  },
  {
    key: 'social_media',
    label: 'Social Media',
    roles: [
      { key: 'social_media_manager', label: 'Social Media Manager' },
      { key: 'content_creator', label: 'Content Creator' },
      { key: 'influencer', label: 'Influencer' },
    ],
  },
  {
    key: 'designing',
    label: 'Designing',
    roles: [
      { key: 'graphic_designer', label: 'Graphic Designer' },
      { key: 'video_creator', label: 'Video Creator' },
      { key: 'editor', label: 'Editor' },
    ],
  },
  {
    key: 'sales',
    label: 'Sales',
    roles: [
      { key: 'sales_executive', label: 'Sales Executive' },
      { key: 'sales_manager', label: 'Sales Manager' },
      { key: 'field_sales', label: 'Field Sales' },
    ],
  },
  {
    key: 'operations',
    label: 'Operations',
    roles: [
      { key: 'calling', label: 'Calling' },
      { key: 'customer_support_executive', label: 'Customer Support Executive' },
    ],
  },
  {
    key: 'business_development',
    label: 'Business Development',
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
    roles: [{ key: 'delivery_partner', label: 'Delivery Partner' }],
  },
  {
    key: 'restaurant',
    label: 'Restaurant',
    roles: [
      { key: 'chef', label: 'Chef' },
      { key: 'waiter', label: 'Waiter' },
      { key: 'helper', label: 'Helper' },
    ],
  },
  {
    key: 'salon',
    label: 'Salon',
    roles: [
      { key: 'barber', label: 'Barber' },
      { key: 'makeup_artist', label: 'Makeup Artist' },
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
