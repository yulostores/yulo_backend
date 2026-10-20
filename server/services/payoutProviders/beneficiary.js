import Restaurant from '../../models/Restaurant.js';

// Shared by every provider: money only ever goes to an admin-verified bank account.
export const verifiedBeneficiary = async (restaurantId) => {
  // Only what the decision needs — never the encrypted account number.
  const restaurant = await Restaurant.findById(restaurantId).select('name payoutAccount.status').lean();
  if (!restaurant) return { ready: false, reason: 'Restaurant not found' };
  if (restaurant.payoutAccount?.status !== 'verified') {
    return { ready: false, reason: 'Bank account is not verified' };
  }
  return { ready: true, restaurant };
};
