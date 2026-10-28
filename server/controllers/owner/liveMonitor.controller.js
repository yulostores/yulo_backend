import * as liveMonitorService from '../../services/liveMonitor.service.js';
import { sendSuccess } from '../../utils/ApiResponse.js';
import { asyncHandler } from '../../utils/asyncHandler.js';

export const getStats = asyncHandler(async (req, res) => {
  const stats = await liveMonitorService.getStats(req.params.restaurantId);
  sendSuccess(res, 200, 'Live stats', stats);
});

export const getActiveVisitors = asyncHandler(async (req, res) => {
  const data = await liveMonitorService.getActiveVisitors(req.params.restaurantId);
  sendSuccess(res, 200, 'Active visitors', data);
});

export const getRepeatVisitors = asyncHandler(async (req, res) => {
  const visitors = await liveMonitorService.getRepeatVisitors(req.params.restaurantId);
  sendSuccess(res, 200, 'Repeat visitors', { visitors });
});
