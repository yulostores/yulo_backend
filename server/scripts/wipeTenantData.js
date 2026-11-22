// Wipes every restaurant, customer and seller — and everything they own — leaving a clean
// platform with only the super admin(s) and the platform-wide settings.
//
//   node scripts/wipeTenantData.js                                  # dry run: counts only
//   node scripts/wipeTenantData.js --apply --confirm <dbName>       # really delete
//   ... --apply --confirm <dbName> --delivery-partners              # also delete rider accounts
//   ... --apply --confirm <dbName> --reset-counters                 # also restart bill/ticket numbers
//   ... --apply --confirm <dbName> --coupon-categories              # also delete coupon categories
//
// DELETED
//   Restaurants:  restaurants, menu (categories, sub-categories, items, option groups), tables,
//                 table sessions, waiter requests, staff, discounts, loyalty programs/milestones
//   Orders/money: orders, bills, reviews, ledger entries, settlements, payout batches,
//                 stray payments, support tickets, rider payouts, rider cash deposits
//   Customers:    every User whose role is customer / guest / restaurant_owner, plus their carts,
//                 favorites, search history, sessions, activity events, devices
//   Sellers:      sellers, seller users, subscriptions, SMS credit purchases, SMS campaigns,
//                 SMS logs, coupon offers, issued coupons
//   Misc:         idempotency keys
//
// KEPT
//   Admin users (role 'admin') and their devices, admin audit log, coupon settings, coupon
//   categories (unless --coupon-categories), coupon plans, finance settings, quick filter chips, Razorpay webhook-event
//   dedupe rows (so an old webhook retry can't be processed twice), migrations_applied.
//   Delivery partner accounts are kept unless --delivery-partners is passed (their delivery
//   count and rating are reset to 0, since the orders and reviews behind them are gone).
//   Counters (bill / settlement / ticket serial numbers) keep counting up unless
//   --reset-counters is passed — keep them if any real invoice was ever issued from this DB.
//
// NOT TOUCHED (outside MongoDB): Cloudinary images/documents, Redis keys (OTP codes, rate
// limits, caches). Deleted users' refresh tokens stop working because their accounts are gone.
//
// Safety: a dry run writes nothing. --apply only runs when --confirm names the exact database
// it is connected to, so it can't be pointed at the wrong DB by accident.

import 'dotenv/config';
import mongoose from 'mongoose';

import ActivityEvent from '../models/ActivityEvent.js';
import Bill from '../models/Bill.js';
import Cart from '../models/Cart.js';
import CashDeposit from '../models/CashDeposit.js';
import Category from '../models/Category.js';
import Counter from '../models/Counter.js';
import Coupon from '../models/Coupon.js';
import CouponCategory from '../models/CouponCategory.js';
import CouponOffer from '../models/CouponOffer.js';
import CustomerSession from '../models/CustomerSession.js';
import DeliveryPartner from '../models/DeliveryPartner.js';
import Discount from '../models/Discount.js';
import Favorite from '../models/Favorite.js';
import FleetChangeRequest from '../models/FleetChangeRequest.js';
import IdempotencyKey from '../models/IdempotencyKey.js';
import LoyaltyMilestone from '../models/LoyaltyMilestone.js';
import LoyaltyProgram from '../models/LoyaltyProgram.js';
import MenuItem from '../models/MenuItem.js';
import OptionGroup from '../models/OptionGroup.js';
import Order from '../models/Order.js';
import Payout from '../models/Payout.js';
import PayoutBatch from '../models/PayoutBatch.js';
import Request from '../models/Request.js';
import Restaurant from '../models/Restaurant.js';
import RestaurantLedgerEntry from '../models/RestaurantLedgerEntry.js';
import RestaurantSettlement from '../models/RestaurantSettlement.js';
import Review from '../models/Review.js';
import SearchHistory from '../models/SearchHistory.js';
import Seller from '../models/Seller.js';
import SellerSubscription from '../models/SellerSubscription.js';
import SellerUser from '../models/SellerUser.js';
import SmsCampaign from '../models/SmsCampaign.js';
import SmsCreditPurchase from '../models/SmsCreditPurchase.js';
import SmsLog from '../models/SmsLog.js';
import StaffMember from '../models/StaffMember.js';
import StrayPayment from '../models/StrayPayment.js';
import SubCategory from '../models/SubCategory.js';
import SupportTicket from '../models/SupportTicket.js';
import Table from '../models/Table.js';
import TableSession from '../models/TableSession.js';
import User from '../models/User.js';
import UserDevice from '../models/UserDevice.js';
import { recordMigrationRun } from './_migrationLog.js';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const confirmIndex = args.indexOf('--confirm');
const confirmName = confirmIndex !== -1 ? args[confirmIndex + 1] : null;
const wipePartners = args.includes('--delivery-partners');
const resetCounters = args.includes('--reset-counters');
// Only sellers, offers and coupons point at a category, and those are wiped above anyway.
const wipeCouponCategories = args.includes('--coupon-categories');

const NON_ADMIN_ROLES = ['customer', 'guest', 'restaurant_owner'];

// Collections emptied completely, grouped only for the printed report.
const WIPE_ALL = {
  Restaurants: [Restaurant, Category, SubCategory, MenuItem, OptionGroup, Table, TableSession,
    Request, StaffMember, Discount, LoyaltyProgram, LoyaltyMilestone],
  'Orders & money': [Order, Bill, Review, RestaurantLedgerEntry, RestaurantSettlement, PayoutBatch,
    StrayPayment, SupportTicket, Payout, CashDeposit],
  'Customer activity': [Cart, Favorite, SearchHistory, CustomerSession, ActivityEvent],
  Sellers: [Seller, SellerUser, SellerSubscription, SmsCreditPurchase, SmsCampaign, SmsLog,
    CouponOffer, Coupon],
  Misc: [IdempotencyKey],
};
if (wipePartners) WIPE_ALL['Delivery partners'] = [DeliveryPartner, FleetChangeRequest];
if (resetCounters) WIPE_ALL.Misc.push(Counter);
if (wipeCouponCategories) WIPE_ALL.Sellers.push(CouponCategory);

const run = async () => {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set');
  await mongoose.connect(process.env.MONGODB_URI);
  const dbName = mongoose.connection.db.databaseName;
  console.log(`connected to "${dbName}" on ${mongoose.connection.host}`);

  if (apply && confirmName !== dbName) {
    console.error(`\nRefusing to delete: pass --confirm ${dbName} together with --apply.`);
    process.exitCode = 1;
    return;
  }
  console.log(apply ? 'APPLY mode — deleting\n' : 'dry run — nothing is deleted (pass --apply --confirm <dbName>)\n');

  const admins = await User.find({ role: 'admin' }).select('_id email').lean();
  const adminIds = admins.map((a) => a._id);
  console.log(`keeping ${admins.length} admin account(s): ${admins.map((a) => a.email).join(', ') || '(none!)'}`);
  if (admins.length === 0) console.warn('WARNING: no admin account exists — run seedSuperAdmin.js afterwards.');

  const stats = {};
  const step = async (label, model, filter = {}) => {
    const n = apply
      ? (await model.collection.deleteMany(filter)).deletedCount
      : await model.collection.countDocuments(filter);
    stats[label] = n;
    console.log(`  ${label.padEnd(34)} ${String(n).padStart(7)}`);
  };

  for (const [group, models] of Object.entries(WIPE_ALL)) {
    console.log(group);
    for (const model of models) await step(model.collection.collectionName, model);
  }

  console.log('Users');
  await step('users (customer/guest/owner)', User, { role: { $in: NON_ADMIN_ROLES } });
  await step('userdevices (non-admin)', UserDevice, { userId: { $nin: adminIds } });

  if (!wipePartners) {
    const partners = await DeliveryPartner.collection.countDocuments({});
    console.log(`Delivery partners: keeping ${partners} account(s)${apply ? ', delivery count & rating reset to 0' : ''}`);
    if (apply) await DeliveryPartner.collection.updateMany({}, { $set: { totalDeliveries: 0, rating: 0 } });
  }

  const total = Object.values(stats).reduce((a, b) => a + b, 0);
  console.log(`\n${apply ? 'deleted' : 'would delete'} ${total} document(s) in total`);

  if (apply) await recordMigrationRun('wipeTenantData', { wipePartners, resetCounters, wipeCouponCategories, total, ...stats });
};

run()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => mongoose.disconnect());
