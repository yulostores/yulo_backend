import mongoose from 'mongoose';

const staffMemberSchema = new mongoose.Schema(
  {
    restaurantId: { type: mongoose.Schema.Types.ObjectId, ref: 'Restaurant', required: true },
    staffCode:    { type: String, required: true },
    name: { type: String, required: true, trim: true },
    role: { type: String, enum: ['waiter', 'chef'], required: true },
    // What staff sign in with: an OTP sent to this number (controllers/staff/auth.controller.js).
    // 10 digits, no country code — the same shape the customer and partner logins use. Null
    // only on members created before phone login existed; they cannot sign in until the owner
    // adds a number.
    phone: { type: String, default: null },
    // Bumped whenever this member's existing sessions must stop working — their phone changes
    // or they are deactivated. Every staff token carries the version it was issued at, and
    // middleware/authenticateStaff.js and socket.js refuse a token whose version is behind.
    sessionVersion: { type: Number, default: 0 },
    // Legacy: the PIN login this replaced. No longer read or written; kept on old documents
    // only so nothing has to be migrated.
    pinHash: { type: String, default: null, select: false },
    email: { type: String, default: null },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// staffCode unique per restaurant — still the member's short display id (W01, C02).
staffMemberSchema.index({ restaurantId: 1, staffCode: 1 }, { unique: true });
staffMemberSchema.index({ restaurantId: 1, role: 1 });
// One phone per restaurant among ACTIVE members — looked up on every OTP login. The same
// number may be staff at several restaurants (a chef working two branches); they pick the
// restaurant first. Deactivated members don't hold their number, so a departed employee's
// number can go to someone new (or the same person re-added). Partial also lets any number
// of legacy phone-less members coexist. Reactivating a member whose number has since been
// given to someone else is refused (409 PHONE_TAKEN, controllers/owner/staff.controller.js).
staffMemberSchema.index(
  { restaurantId: 1, phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string' }, isActive: true } }
);

export default mongoose.model('StaffMember', staffMemberSchema);
