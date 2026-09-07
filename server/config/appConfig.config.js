// The customer app's Settings screen, in one place.
//
// Everything the app's Settings screens render — the languages it can be switched to, the
// payment methods the platform accepts, the "About Yulo Stores" block, and the full text
// of the legal documents — is data here and nowhere else. One consumer reads it:
//
//   * GET /api/app/config serves the whole thing (minus the legal section bodies) to the
//     customer app, which renders every Settings row from it. GET /api/app/legal/:docId
//     serves one legal document with its sections.
//
// It is declarative data rather than a model + collection for the same reason
// config/storeSettings.config.js is: none of it is derived from anything the platform
// stores (unlike cuisines, which are aggregated from real restaurants — see
// controllers/cuisine.controller.js). A supported-language list, the legal copy and the
// company's own contact details have no collection to grow from; they are edited here and
// shipped. Keeping them here also means the app never hard-codes a word of it, so the
// wording the customer sees and the wording on file can't drift apart.

// ─── Languages ───────────────────────────────────────────────────────────────
//
// India's most-spoken languages. `available` is the honest bit: it is true only for a
// language the app actually has strings for. The rest are shown in the picker (so the
// customer can see they're planned) but disabled — the same way Zomato/Swiggy list a
// language before its translation ships. `preferences.preferredLanguage` is only ever
// allowed to hold an `available` code — see isSupportedLanguage below, which
// routes/user.routes.js enforces on write.

export const DEFAULT_LANGUAGE = 'en';

export const SUPPORTED_LANGUAGES = [
  { code: 'en', label: 'English', endonym: 'English', available: true },
  { code: 'hi', label: 'Hindi', endonym: 'हिन्दी', available: false },
  { code: 'bn', label: 'Bengali', endonym: 'বাংলা', available: false },
  { code: 'te', label: 'Telugu', endonym: 'తెలుగు', available: false },
  { code: 'mr', label: 'Marathi', endonym: 'मराठी', available: false },
  { code: 'ta', label: 'Tamil', endonym: 'தமிழ்', available: false },
  { code: 'gu', label: 'Gujarati', endonym: 'ગુજરાતી', available: false },
  { code: 'kn', label: 'Kannada', endonym: 'ಕನ್ನಡ', available: false },
  { code: 'ml', label: 'Malayalam', endonym: 'മലയാളം', available: false },
  { code: 'pa', label: 'Punjabi', endonym: 'ਪੰਜਾਬੀ', available: false },
  { code: 'or', label: 'Odia', endonym: 'ଓଡ଼ିଆ', available: false },
];

export const AVAILABLE_LANGUAGE_CODES = SUPPORTED_LANGUAGES.filter((l) => l.available).map(
  (l) => l.code
);

// True only for a language the app can actually be switched to. The write path for
// preferences.preferredLanguage calls this so a stored code can never get ahead of a
// shipped translation; the moment `available` flips to true above, that code starts
// passing here with no other change.
export const isSupportedLanguage = (code) => AVAILABLE_LANGUAGE_CODES.includes(code);

// ─── Payment methods ─────────────────────────────────────────────────────────
//
// The catalogue the customer app renders — on the Settings "Payment methods" screen
// (read-only: the method is chosen at checkout, not here) and, as a synchronous twin, on
// the checkout Payment screen itself (src/services/payments.ts in the app, which keeps a
// line-for-line copy so the picker can render without waiting on a fetch — the same
// arrangement as this config and the restaurant portal's src/lib/fieldRules.js). `wire`
// is the only thing the order API ever receives; `gatewayMethod` is the Razorpay method
// hint used once the real gateway is switched on.

export const PAYMENT_GROUPS = [
  { id: 'upi', title: 'UPI', subtitle: 'Pay by any UPI app', defaultOpen: true },
  { id: 'card', title: 'Cards', subtitle: 'Credit / Debit Card', defaultOpen: false },
  { id: 'netbanking', title: 'Net Banking', subtitle: 'All major banks', defaultOpen: false },
  { id: 'cod', title: 'Pay on Delivery', subtitle: 'Cash / UPI when it arrives', defaultOpen: false },
];

export const PAYMENT_METHODS = [
  { id: 'phonepe', group: 'upi', label: 'PhonePe UPI', hint: 'UPI', icon: 'phone-portrait', tint: '#5F259F', wire: 'online', gatewayMethod: 'upi' },
  { id: 'gpay', group: 'upi', label: 'Google Pay UPI', hint: 'UPI', icon: 'logo-google', tint: '#1A73E8', wire: 'online', gatewayMethod: 'upi' },
  { id: 'paytm', group: 'upi', label: 'Paytm', hint: 'UPI', icon: 'wallet', tint: '#00BAF2', wire: 'online', gatewayMethod: 'upi' },
  { id: 'cred', group: 'upi', label: 'CRED', hint: 'UPI', icon: 'shield-checkmark', tint: '#1C1C1C', wire: 'online', gatewayMethod: 'upi' },
  { id: 'card', group: 'card', label: 'Credit / Debit Card', hint: 'Visa · Mastercard · RuPay', icon: 'card', tint: '#1C1C1C', wire: 'online', gatewayMethod: 'card' },
  { id: 'netbanking', group: 'netbanking', label: 'Net Banking', hint: 'All Indian banks', icon: 'business', tint: '#0D8A16', wire: 'online', gatewayMethod: 'netbanking' },
  { id: 'cod', group: 'cod', label: 'Pay on Delivery', hint: 'Cash / UPI on delivery', icon: 'cash', tint: '#0D8A16', wire: 'cod' },
];

// ─── About ───────────────────────────────────────────────────────────────────
//
// The company block behind the "About Yulo stores" screen. The app pairs `copyright`
// (stamped with the current year by buildAppConfig) with its own build version, which it
// reads from the native bundle — that part isn't ours to know here.

export const ABOUT = {
  appName: 'Yulo Stores',
  legalName: 'Yulo Stores Technologies Pvt. Ltd.',
  tagline: 'Stores and restaurants near you, delivered.',
  websiteUrl: 'https://yulostores.in',
  helpCentreUrl: 'https://yulostores.in/help',
  supportEmail: 'support@yulostores.in',
  // Dialable as-is once the app strips spaces; shown grouped.
  supportPhone: '+91 1800 200 1234',
  addressLines: [
    'Yulo Stores Technologies Pvt. Ltd.',
    '4th Floor, Prestige Sigma',
    'Vittal Mallya Road, Bengaluru 560001',
    'Karnataka, India',
  ],
  socialLinks: [
    { id: 'instagram', label: 'Instagram', url: 'https://instagram.com/yulostores' },
    { id: 'x', label: 'X (Twitter)', url: 'https://x.com/yulostores' },
    { id: 'linkedin', label: 'LinkedIn', url: 'https://linkedin.com/company/yulostores' },
    { id: 'facebook', label: 'Facebook', url: 'https://facebook.com/yulostores' },
  ],
  copyrightHolder: 'Yulo Stores Technologies Pvt. Ltd.',
};

// ─── Legal documents ─────────────────────────────────────────────────────────
//
// Rendered natively by the app as a list of {heading, body} sections — no markdown, no
// webview, readable offline once the screen has loaded once. `canonicalUrl` is null until
// a hosted copy exists; when it does, the app can link out to it as the authoritative
// version. `updatedAt` is a plain date the app shows as "Last updated …".

// Ordered as the Settings list shows them — the app renders `legal` in this order.
export const LEGAL_DOCUMENTS = [
  {
    id: 'privacy',
    title: 'Privacy & data',
    updatedAt: '2026-01-01',
    canonicalUrl: null,
    sections: [
      {
        heading: 'What we collect',
        body: 'Your phone number and, if you add them, your name, email and profile photo. Your saved addresses and the delivery location you pick. Your orders, ratings and support requests. Basic device and app-diagnostic information so we can keep the app working.',
      },
      {
        heading: 'How we use it',
        body: 'To place and deliver your orders, show you stores that deliver to you, process payments, provide support, and improve the app. Your delivery address and contact number are shared with the store and the assigned delivery partner only for the order they are fulfilling.',
      },
      {
        heading: 'Location',
        body: 'With your permission the app uses your device location to centre the map when you set a delivery point and to show nearby stores. You can revoke this in your device settings and enter an address manually instead.',
      },
      {
        heading: 'What we never do',
        body: 'We do not sell your personal data. We do not store your full card number or UPI PIN. We do not share your contact details with a store or partner beyond the order they are handling.',
      },
      {
        heading: 'Retention',
        body: 'Order and invoice records are kept as long as tax and accounting rules require. Other account data is kept while your account is active and for a short period afterwards, then deleted or anonymised.',
      },
      {
        heading: 'Your choices',
        body: 'You can view and edit your profile, addresses and preferences in the app at any time. To export or delete your account data, contact support@yulostores.in and we will act on the request within 30 days.',
      },
      {
        heading: 'Contact',
        body: 'For any privacy question or request, write to support@yulostores.in.',
      },
    ],
  },
  {
    id: 'terms',
    title: 'Terms of Service',
    updatedAt: '2026-01-01',
    canonicalUrl: null,
    sections: [
      {
        heading: 'Acceptance of these terms',
        body: 'By creating an account or placing an order on Yulo Stores you agree to these Terms of Service and to our Privacy & Data policy. If you do not agree, please do not use the app.',
      },
      {
        heading: 'Your account',
        body: 'You are responsible for the phone number and account you sign in with, and for keeping your device secure. Tell us promptly if you believe someone else has used your account. You must be able to form a binding contract to place an order.',
      },
      {
        heading: 'Orders and pricing',
        body: 'Yulo Stores is a marketplace: menus, item availability and prices are set by the stores and restaurants listed in the app. The price shown at checkout — including delivery fee, platform fee and taxes — is the amount you will be charged. An order may be declined or cancelled if an item is unavailable, the delivery address is outside a store’s range, or payment cannot be completed.',
      },
      {
        heading: 'Payments',
        body: 'Online payments are processed by our payment partner. For "Pay on Delivery" orders you agree to pay the delivery partner the full amount on hand-over. We do not store your full card or UPI credentials.',
      },
      {
        heading: 'Cancellations and refunds',
        body: 'You can cancel an order before the store accepts it at no charge. After that, a cancellation may be chargeable to cover food already prepared. Approved refunds are returned to your original payment method within 5–7 business days.',
      },
      {
        heading: 'Acceptable use',
        body: 'Do not misuse the app: no fraudulent orders, no abuse of delivery partners or store staff, no attempts to disrupt or reverse-engineer the service. We may suspend an account that does.',
      },
      {
        heading: 'Liability',
        body: 'The stores and restaurants are responsible for the food they prepare, including its quality and its declared contents. Yulo Stores is responsible for operating the app and the delivery service with reasonable care. To the extent the law allows, our liability for any order is limited to the value of that order.',
      },
      {
        heading: 'Changes and contact',
        body: 'We may update these terms; the "Last updated" date above changes when we do, and continued use after a change means you accept it. Questions go to support@yulostores.in.',
      },
    ],
  },
];

// ─── Assembled response ──────────────────────────────────────────────────────

// The GET /api/app/config payload. Built per request so `copyright` carries the current
// year without a constant that goes stale every January. Legal documents appear here as
// summaries only — the section bodies are served one document at a time by
// getLegalDocument, so the Settings list stays a small download.
export const buildAppConfig = () => ({
  languages: SUPPORTED_LANGUAGES,
  defaultLanguage: DEFAULT_LANGUAGE,
  payments: { groups: PAYMENT_GROUPS, methods: PAYMENT_METHODS },
  about: {
    ...ABOUT,
    copyright: `© ${new Date().getFullYear()} ${ABOUT.copyrightHolder}`,
  },
  legal: LEGAL_DOCUMENTS.map(({ sections, ...summary }) => summary),
});

// One legal document with its sections, or null for an unknown id.
export const getLegalDocument = (id) => LEGAL_DOCUMENTS.find((doc) => doc.id === id) ?? null;
