import mongoose from 'mongoose';
import { ApiError } from '../utils/ApiError.js';
import { now } from '../utils/clock.js';
import { logActivity } from './activityLog.service.js';

// The super admin's follow-up on careers-portal entries — job applications
// (services/jobApplication.service.js) and seller applications ("Choose your business",
// services/partnerApplication.service.js) work the same way:
//
//   called      the Call button marks the entry called (green) — a reminder, can be undone
//   interest    interested (blue) / not interested (red) / not set
//   delete      only an entry whose ₹100 fee is unpaid. Hidden, not erased (deletedAt): if the
//               applicant still pays from a tab left open, the payment lands on it and brings it
//               back as paid — the money is never orphaned.

export const INTERESTS = ['interested', 'not_interested'];

/** The fields both application models carry. */
export const followUpSchemaFields = {
  followUp: {
    calledAt: { type: Date, default: null },
    calledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    interest: { type: String, enum: [...INTERESTS, null], default: null },
    interestAt: { type: Date, default: null },
    interestBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  deletedAt: { type: Date, default: null },
  deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
};

export const followUpView = (a) => ({
  called: !!a.followUp?.calledAt,
  calledAt: a.followUp?.calledAt ?? null,
  interest: a.followUp?.interest ?? null,
});

/** Mongo conditions for the list filters: called 'yes' | 'no', interest 'interested' | 'not_interested' | 'none'. */
export const followUpFilter = ({ called, interest } = {}) => {
  const filter = { deletedAt: null };
  if (called === 'yes') filter['followUp.calledAt'] = { $ne: null };
  if (called === 'no') filter['followUp.calledAt'] = null;
  if (interest === 'none') filter['followUp.interest'] = null;
  else if (INTERESTS.includes(interest)) filter['followUp.interest'] = interest;
  return filter;
};

const load = async (Model, id) => {
  const doc = mongoose.isValidObjectId(id) ? await Model.findOne({ _id: id, deletedAt: null }).lean() : null;
  if (!doc) throw new ApiError(404, 'NOT_FOUND', 'Application not found');
  return doc;
};

/** Mark called (or undo). Returns the updated document. */
export const setCalled = async (Model, id, adminId, called) => {
  await load(Model, id);
  const set = called
    ? { 'followUp.calledAt': now(), 'followUp.calledBy': adminId }
    : { 'followUp.calledAt': null, 'followUp.calledBy': null };
  return Model.findByIdAndUpdate(id, { $set: set }, { new: true }).lean();
};

/** interested / not_interested / null (clear). Returns the updated document. */
export const setInterest = async (Model, id, adminId, interest) => {
  await load(Model, id);
  return Model.findByIdAndUpdate(
    id,
    { $set: { 'followUp.interest': interest, 'followUp.interestAt': interest ? now() : null, 'followUp.interestBy': interest ? adminId : null } },
    { new: true }
  ).lean();
};

/** Delete an unpaid entry (hidden — see the top of this file). */
export const deleteUnpaid = async (Model, id, adminId, targetType) => {
  await load(Model, id);
  const deleted = await Model.findOneAndUpdate(
    { _id: id, deletedAt: null, 'payment.status': { $ne: 'paid' } },
    { $set: { deletedAt: now(), deletedBy: adminId } },
    { new: true }
  ).lean();
  if (!deleted) throw new ApiError(409, 'ALREADY_PAID', 'This application has paid the form fee, so it cannot be deleted');
  await logActivity({ adminId, action: `${targetType}_deleted`, targetType, targetId: deleted._id, metadata: {} });
  return { deleted: true };
};
