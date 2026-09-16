import * as searchService from '../services/search.service.js';
import { ApiError } from '../utils/ApiError.js';
import { sendSuccess } from '../utils/ApiResponse.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { VEG_BANNER_TEXT } from '../constants/vegBanner.constant.js';

export const getTypeahead = asyncHandler(async (req, res) => {
  const { q } = req.query;
  if (!q || !q.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'q is required');

  const results = await searchService.typeahead(q);
  sendSuccess(res, 200, 'Typeahead results', { results });
});

export const getPopular = asyncHandler(async (req, res) => {
  const vegOnly = req.query.vegOnly === 'true';
  const popular = await searchService.getPopularSearches(vegOnly);
  // Same confirmation strip text/condition as the home feed — the client renders
  // it above "Recent searches" whenever the caller asked for the veg-only grid.
  sendSuccess(res, 200, 'Popular searches', {
    popular,
    vegBannerText: vegOnly ? VEG_BANNER_TEXT : null,
  });
});

export const listRecent = asyncHandler(async (req, res) => {
  const recent = await searchService.listRecentSearches(req.user._id);
  sendSuccess(res, 200, 'Recent searches', { recent });
});

export const createRecent = asyncHandler(async (req, res) => {
  const { query } = req.body;
  if (!query || !query.trim()) throw new ApiError(400, 'VALIDATION_ERROR', 'query is required');

  await searchService.recordSearch(req.user._id, query);
  sendSuccess(res, 201, 'Search recorded', null);
});

export const removeRecent = asyncHandler(async (req, res) => {
  await searchService.removeRecentSearch(req.user._id, req.params.id);
  sendSuccess(res, 200, 'Recent search removed', null);
});
