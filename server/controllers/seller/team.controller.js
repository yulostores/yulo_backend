import * as team from '../../services/sellerTeam.service.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

// Seller portal — team (services/sellerTeam.service.js). Owner manages anyone but themselves;
// a manager manages employees only. Approved sellers only (routes/seller/index.js).

const actor = (req) => ({ sellerId: req.seller.sellerId, userId: req.seller.userId, role: req.seller.role });

/** GET /api/seller/users */
export const list = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Team', await team.listTeam(actor(req)));
});

/** POST /api/seller/users { name, phone, role, dateOfBirth?, gender?, experienceYears? } */
export const add = asyncHandler(async (req, res) => {
  sendSuccess(res, 201, 'Team member added', { member: await team.addMember(actor(req), req.body) });
});

/** PATCH /api/seller/users/:id */
export const edit = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Team member updated', { member: await team.editMember(actor(req), req.params.id, req.body) });
});

/** DELETE /api/seller/users/:id */
export const remove = asyncHandler(async (req, res) => {
  sendSuccess(res, 200, 'Team member removed', { member: await team.removeMember(actor(req), req.params.id) });
});
