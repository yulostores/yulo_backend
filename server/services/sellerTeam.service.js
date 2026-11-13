import mongoose from 'mongoose';
import { z } from 'zod';
import SellerUser from '../models/SellerUser.js';
import { GENDERS, SELLER_ROLES } from '../config/coupon.config.js';
import { phoneField, toTeamMemberView } from './sellerOnboarding.service.js';
import { ageOn } from '../utils/couponCode.js';
import { ApiError } from '../utils/ApiError.js';

// Team management for an approved seller — /api/seller/users (§ CB8). Before approval the team is
// edited as part of onboarding (services/sellerOnboarding.service.js#saveEmployees).
//
//   owner    adds, edits (incl. role) and removes anyone but themselves
//   manager  adds, edits and removes employees only — and can't make anyone a manager or owner
//
// Removing someone deactivates their login for good (removedAt) and bumps sessionVersion, which
// ends every session they hold at once; so does a role change. The business can never be left
// without an active owner.

const MIN_AGE = 14;

const dateOfBirth = z.coerce
  .date({ error: 'Date of birth must be a date' })
  .refine((d) => d.getTime() <= Date.now(), 'Date of birth cannot be in the future')
  .refine((d) => (ageOn(d) ?? -1) >= MIN_AGE, `Must be at least ${MIN_AGE}`)
  .refine((d) => (ageOn(d) ?? 0) <= 110, 'Check the date of birth');

const memberFields = {
  name: z.string().trim().min(2, 'Enter the name').max(100),
  dateOfBirth: dateOfBirth.nullish(),
  gender: z.enum(GENDERS).nullish(),
  experienceYears: z.number().min(0).max(80).nullish(),
  role: z.enum(SELLER_ROLES, { error: 'Role must be owner, manager or employee' }),
};

export const addMemberSchema = z.object({ ...memberFields, phone: phoneField }).strict();
// The phone is the person's login; changing it is removing them and adding the new number.
export const editMemberSchema = z
  .object(memberFields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');

const parseOr400 = (schema, body) => {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const flat = parsed.error.flatten();
    throw new ApiError(400, 'VALIDATION_ERROR', Object.values(flat.fieldErrors).flat()[0] ?? flat.formErrors[0] ?? 'Invalid input', flat);
  }
  return parsed.data;
};

// Which roles an actor may hand out or act on.
const MANAGEABLE = { owner: ['owner', 'manager', 'employee'], manager: ['employee'], employee: [] };
const canManage = (actorRole, targetRole) => MANAGEABLE[actorRole]?.includes(targetRole) ?? false;

const forbidden = (message) => new ApiError(403, 'FORBIDDEN', message);
const notFound = () => new ApiError(404, 'NOT_FOUND', 'Team member not found');

const memberView = (u, actor) => ({
  ...toTeamMemberView(u),
  lastLoginAt: u.lastLoginAt ?? null,
  isYou: String(u._id) === String(actor.userId),
  canManage: String(u._id) !== String(actor.userId) && canManage(actor.role, u.role),
});

/** The member, scoped to the actor's business — another business's id is simply not found. */
const loadMember = async (actor, memberId) => {
  if (!mongoose.isValidObjectId(memberId)) throw notFound();
  const member = await SellerUser.findOne({ _id: memberId, sellerId: actor.sellerId, removedAt: null });
  if (!member) throw notFound();
  return member;
};

const assertCanTouch = (actor, member) => {
  if (String(member._id) === String(actor.userId)) {
    throw forbidden('You cannot change or remove your own login here');
  }
  if (!canManage(actor.role, member.role)) {
    throw forbidden(actor.role === 'manager' ? 'Managers can manage employees only' : 'You cannot manage this team member');
  }
};

const otherActiveOwners = (sellerId, exceptId) =>
  SellerUser.countDocuments({ sellerId, role: 'owner', isActive: true, removedAt: null, _id: { $ne: exceptId } });

// ── Reads ─────────────────────────────────────────────────────────────────────

/** GET /api/seller/users — everyone currently on the team, owners first. */
export const listTeam = async (actor) => {
  const rows = await SellerUser.find({ sellerId: actor.sellerId, removedAt: null }).sort({ createdAt: 1 }).lean();
  const order = { owner: 0, manager: 1, employee: 2 };
  rows.sort((a, b) => order[a.role] - order[b.role]);
  return { members: rows.map((u) => memberView(u, actor)), manageableRoles: MANAGEABLE[actor.role] ?? [] };
};

// ── Writes ────────────────────────────────────────────────────────────────────

/** POST /api/seller/users — active at once; they sign in with an OTP to their phone. */
export const addMember = async (actor, body) => {
  const data = parseOr400(addMemberSchema, body);
  if (!canManage(actor.role, data.role)) {
    throw forbidden(actor.role === 'manager' ? 'Managers can add employees only' : 'You cannot add this role');
  }
  if (await SellerUser.exists({ sellerId: actor.sellerId, phone: data.phone, isActive: true, removedAt: null })) {
    throw new ApiError(409, 'DUPLICATE_PHONE', 'Someone on your team already uses this mobile number');
  }
  try {
    const user = await SellerUser.create({
      sellerId: actor.sellerId,
      name: data.name,
      phone: data.phone,
      role: data.role,
      dateOfBirth: data.dateOfBirth ?? null,
      gender: data.gender ?? null,
      experienceYears: data.experienceYears ?? null,
      isActive: true,
    });
    return memberView(user.toObject(), actor);
  } catch (err) {
    // Two adds of the same number at once: the unique (sellerId, phone, active) index decides.
    if (err?.code === 11000) throw new ApiError(409, 'DUPLICATE_PHONE', 'Someone on your team already uses this mobile number');
    throw err;
  }
};

/** PATCH /api/seller/users/:id — a role change signs them out everywhere. */
export const editMember = async (actor, memberId, body) => {
  const data = parseOr400(editMemberSchema, body);
  const member = await loadMember(actor, memberId);
  assertCanTouch(actor, member);
  if (data.role && !canManage(actor.role, data.role)) {
    throw forbidden(actor.role === 'manager' ? 'Managers cannot make anyone a manager or owner' : 'You cannot give this role');
  }
  const demotesOwner = member.role === 'owner' && data.role && data.role !== 'owner';
  if (demotesOwner && (await otherActiveOwners(actor.sellerId, member._id)) === 0) {
    throw new ApiError(409, 'LAST_OWNER', 'The business must keep at least one active owner');
  }

  const roleChanged = data.role !== undefined && data.role !== member.role;
  const before = member.role;
  for (const key of ['name', 'dateOfBirth', 'gender', 'experienceYears', 'role']) {
    if (data[key] !== undefined) member[key] = data[key];
  }
  if (roleChanged) member.sessionVersion = (member.sessionVersion ?? 0) + 1;

  // Conditional on the role we checked, so a parallel change can't slip a manager's edit onto
  // someone who was promoted a moment ago.
  const saved = await SellerUser.findOneAndUpdate(
    { _id: member._id, sellerId: actor.sellerId, role: before, removedAt: null },
    {
      $set: {
        name: member.name,
        dateOfBirth: member.dateOfBirth ?? null,
        gender: member.gender ?? null,
        experienceYears: member.experienceYears ?? null,
        role: member.role,
        sessionVersion: member.sessionVersion ?? 0,
      },
    },
    { new: true }
  ).lean();
  if (!saved) throw new ApiError(409, 'MEMBER_CHANGED', 'This team member was changed by someone else — reload and try again');
  return memberView(saved, actor);
};

/** DELETE /api/seller/users/:id — deactivated for good and signed out. */
export const removeMember = async (actor, memberId) => {
  const member = await loadMember(actor, memberId);
  assertCanTouch(actor, member);
  if (member.role === 'owner' && member.isActive && (await otherActiveOwners(actor.sellerId, member._id)) === 0) {
    throw new ApiError(409, 'LAST_OWNER', 'The business must keep at least one active owner');
  }
  const removed = await SellerUser.findOneAndUpdate(
    { _id: member._id, sellerId: actor.sellerId, removedAt: null },
    { $set: { isActive: false, removedAt: new Date() }, $inc: { sessionVersion: 1 } },
    { new: true }
  ).lean();
  if (!removed) throw notFound();
  return memberView(removed, actor);
};
