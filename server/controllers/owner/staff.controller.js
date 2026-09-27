import { z } from 'zod';
import StaffMember from '../../models/StaffMember.js';
import { ApiError } from '../../utils/ApiError.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { normalizeIndianPhone } from '../../utils/phone.js';
import { disconnectStaffSockets } from '../../socket.js';

// Staff sign in with an OTP sent to the phone registered here (controllers/staff/
// auth.controller.js) — so the phone IS the credential, and it is required. There is no PIN.

// Accepts "+91 98765 43210" etc. and stores the bare 10 digits the login looks up.
const phoneField = z.preprocess(
  (v) => normalizeIndianPhone(v) ?? v,
  z.string().regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit mobile number')
);
const emailField = z.union([z.string().trim().email('Enter a valid email'), z.literal(''), z.null()]);

const createSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(60),
  role: z.enum(['waiter', 'chef'], { message: 'role must be "waiter" or "chef"' }),
  phone: phoneField,
  email: emailField.optional(),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(60).optional(),
  phone: phoneField.optional(),
  email: emailField.optional(),
  isActive: z.boolean().optional(),
});

const parse = (schema, body) => {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const first = result.error.issues[0];
    throw new ApiError(400, 'VALIDATION_ERROR', first?.message ?? 'Invalid staff details', result.error.flatten());
  }
  return result.data;
};

const PHONE_TAKEN = () =>
  new ApiError(409, 'PHONE_TAKEN', 'Another staff member at this restaurant already uses this phone number');

const isDuplicate = (err, field) => err?.code === 11000 && Object.keys(err.keyPattern ?? {}).includes(field);

// The next staffCode for this restaurant: W01, W02… / C01, C02… Compared numerically —
// sorting the strings put "W100" before "W99" and handed out W100 twice.
async function nextStaffCode(restaurantId, role) {
  const prefix = role === 'chef' ? 'C' : 'W';
  const rows = await StaffMember.find({ restaurantId, staffCode: new RegExp(`^${prefix}\\d+$`) })
    .select('staffCode')
    .lean();
  const highest = rows.reduce((max, r) => Math.max(max, parseInt(r.staffCode.slice(1), 10) || 0), 0);
  return `${prefix}${String(highest + 1).padStart(2, '0')}`;
}

export const listStaff = asyncHandler(async (req, res) => {
  const staff = await StaffMember.find({ restaurantId: req.restaurant._id }).lean();
  // Members created before phone login have no `phone` field at all (lean() skips schema
  // defaults) — report it as null, the documented "can't sign in yet" value.
  sendSuccess(res, 200, 'Staff members', {
    staff: staff.map((m) => ({ ...m, phone: m.phone ?? null })),
  });
});

export const createStaff = asyncHandler(async (req, res) => {
  const { name, role, phone, email } = parse(createSchema, req.body);

  // Two owners' tabs adding staff at once can pick the same next code; the unique index
  // rejects the second, which then simply takes the next one.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const staffCode = await nextStaffCode(req.restaurant._id, role);
    try {
      const member = await StaffMember.create({
        restaurantId: req.restaurant._id,
        staffCode,
        name,
        role,
        phone,
        email: email || null,
      });
      // toObject() ignores the schema's select:false, so drop the legacy field by hand.
      const { pinHash: _legacy, ...staff } = member.toObject();
      return sendSuccess(res, 201, 'Staff member created', { staff });
    } catch (err) {
      if (isDuplicate(err, 'phone')) throw PHONE_TAKEN();
      if (!isDuplicate(err, 'staffCode')) throw err;
    }
  }
  throw new ApiError(409, 'CONFLICT', 'Could not assign a staff code — please try again');
});

export const updateStaff = asyncHandler(async (req, res) => {
  const { name, phone, email, isActive } = parse(updateSchema, req.body);

  const current = await StaffMember.findOne({ _id: req.params.staffId, restaurantId: req.restaurant._id })
    .select('phone isActive')
    .lean();
  if (!current) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found');

  const updates = {};
  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email || null;
  if (phone !== undefined) updates.phone = phone;
  if (isActive !== undefined) updates.isActive = isActive;

  // A new number is a new credential: whoever is signed in on the old one is signed out.
  // Deactivating ends sessions too (authenticateStaff also refuses inactive members, but a
  // bumped version keeps a reactivated member's old tokens from coming back to life).
  const endsSessions =
    (phone !== undefined && phone !== current.phone) || (isActive === false && current.isActive);

  let member;
  try {
    member = await StaffMember.findOneAndUpdate(
      { _id: req.params.staffId, restaurantId: req.restaurant._id },
      { $set: updates, ...(endsSessions ? { $inc: { sessionVersion: 1 } } : {}) },
      { new: true }
    ).lean();
  } catch (err) {
    if (isDuplicate(err, 'phone')) throw PHONE_TAKEN();
    throw err;
  }

  if (!member) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found');
  // Their open kitchen/floor screens stop receiving orders now, not at their next request.
  if (endsSessions) disconnectStaffSockets(member._id);
  sendSuccess(res, 200, 'Staff member updated', { staff: member });
});

export const removeStaff = asyncHandler(async (req, res) => {
  const member = await StaffMember.findOneAndUpdate(
    { _id: req.params.staffId, restaurantId: req.restaurant._id },
    // Deactivated, and signed out everywhere at once.
    { $set: { isActive: false }, $inc: { sessionVersion: 1 } },
    { new: true }
  );
  if (!member) throw new ApiError(404, 'NOT_FOUND', 'Staff member not found');
  disconnectStaffSockets(member._id);
  sendSuccess(res, 200, 'Staff member deactivated', null);
});
