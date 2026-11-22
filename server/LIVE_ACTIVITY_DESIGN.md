# Live Customer Activity & Personalized Offers — Design

Oct 27, 2026 · Amir S

> Local copy of the design doc https://claude.ai/artifact/8suNQ97EnVx5KrJ6qARcse (exported
> 2026-10-27). The build steps live in `yulo_backend/LIVE_ACTIVITY_IMPLEMENTATION_PROMPTS.md`;
> where that file is more specific than this one, the prompts file wins.

## Summary and decisions

Restaurant owners will see what customers do in their store as it happens, and can send one customer a personal discount that the server validates and redeems exactly once. Activity is recorded by the backend inside existing endpoints, not reported by the app; offers reuse the existing `Discount` model and checkout pricing.

**Goals**

- Stream each customer's activity in a restaurant (views, cart changes, checkout, abandonment, order) to that restaurant's owner dashboard in under 2 seconds.
- Let the owner send a targeted offer to one eligible customer session, delivered to that customer's app in real time.
- Apply the offer at checkout with server-side pricing, redeem it at most once, and link the order back to it.
- Report offer outcomes per restaurant: sent, viewed, applied, redeemed, expired, conversion rate and revenue.

**Non-goals for v1**

- Push notifications to customers (no customer push exists yet; offers arrive over the socket and on app open).
- Multi-instance socket fan-out (the server runs as one instance; a Redis adapter is a later step).
- Automated or AI-generated offers; the owner decides every offer.
- Dine-in table QR sessions (the yulo_menu guest flow) and the admin portal.

**Decisions already made**

| Topic | Decision |
| --- | --- |
| Consent | Tracking on by default, a one-time in-app notice, and a Settings toggle to opt out. Opted-out customers never appear on any dashboard. |
| Identity shown to owners | First name plus a returning badge (e.g. "Aarav · 3 past orders here"). No phone or email. Guests show as "Guest". |
| Offer guardrails | At most 1 active offer per customer per restaurant; at most 3 offers per customer per restaurant per day; percentage capped at 50% and every offer capped at ₹500 off; guests are shown but cannot receive offers until they sign in. |
| Who funds the discount | The restaurant, as with existing discounts: settlement already takes the discount off the restaurant's food base. |
| Pricing authority | The backend computes every total and validates every offer; the client only displays. |

## Current state

Most building blocks exist, but the existing Live Monitor never receives data and its offer endpoint has a security hole. The design reuses what works and fixes those two parts.

| Area | Today | Gap this design closes |
| --- | --- | --- |
| Live Monitor backend (`services/liveMonitor.service.js`, `routes/owner/liveMonitor.routes.js`) | Stats, visitor list from Redis keys `live:visitor:*`, repeat visitors, "targeted offer" | `trackVisitor()` is never called, so the visitor list is always empty. `getActiveVisitors` uses `redis.keys()` (blocking scan) and returns name, email and phone. |
| Targeted offer endpoint (`POST /api/owner/:rid/live-monitor/offer`) | `Discount.create({ restaurantId, ...req.body })` | The body spreads after `restaurantId`, so an owner can set another restaurant's id. It emits `targeted_offer` to the owner's own room, never to a customer. |
| Discounts (`models/Discount.js`, `services/discount.service.js`) | Percentage / flat / free item, minimum order, date window, `applicableTo` | No target customer, no redemption limit or count, no lifecycle; codes are usable by anyone; status never auto-expires. |
| Cart and checkout (`services/cart.service.js`, `services/order.service.js`) | `cart.appliedDiscountId` is re-validated on every cart read and again at order creation; totals computed in paise by `charges.service.js` | Reused as-is. Needs per-customer checks and an atomic redemption claim. |
| Public offer surfaces (`search.service.js` hasOffers filter, `home.service.js` featured banner) | Query active discounts by restaurant | Must exclude targeted offers. |
| Socket.IO (`socket.js`) | Authorized rooms: `restaurant:<id>` (owner sockets **and** waiter sockets), `owner:<id>` (owners only), `order:<id>`, kitchen, waiter, partner | No per-customer room. |
| Restaurant portal (`yulo_restaurant`) | `LiveMonitor.jsx` polls every 30 to 60 s; no socket client in the portal | Needs a socket client for live updates. |
| Customer app (`yulostores_customer_app`) | Socket only on the order-tracking screen (`src/lib/socket.ts`); no customer push | Needs an app-wide socket while foregrounded and an offers list fetched on open. |
| Settlement | Discount comes off the restaurant's food base (`settlementMath.service.js`) | None: restaurant-funded offers already settle correctly. |

## Architecture overview

Activity flows to the owner; one offer flows back to one customer.

```
   CUSTOMER APP                  BACKEND (Express)                 OWNER PORTAL

 ┌──────────────────┐  REST   ┌──────────────────────┐  owner room  ┌──────────────────┐
 │ Browse and cart  │────────▶│ Existing endpoints   │─────────────▶│ Live sessions    │
 │ views, cart,     │         │ activity.record()    │  (owner:<id>)│ list, timeline,  │
 │ checkout         │         └──────────────────────┘              │ cart             │
 └──────────────────┘                                               └──────────────────┘

 ┌──────────────────┐  user   ┌──────────────────────┐    REST      ┌──────────────────┐
 │ Offer banner     │◀────────│ Offer service        │◀─────────────│ Send offer       │
 │ card + countdown │  room   │ validates, stores    │              │ guardrails +     │
 └──────────────────┘         └──────────────────────┘              │ confirm          │
                                                                    └──────────────────┘
 ┌──────────────────┐  REST   ┌──────────────────────┐  owner room  ┌──────────────────┐
 │ Apply and pay    │────────▶│ Checkout             │─────────────▶│ Conversion       │
 │ server-priced    │         │ claims the offer once│              │ redeemed, revenue│
 │ bill             │         └──────────┬───────────┘              └──────────────────┘
 └──────────────────┘                    │ reads and writes
                               ┌─────────▼────────────────────────┐
                               │ MongoDB + Redis                  │
                               │ sessions 90 d · events 30 d ·    │
                               │ offers; Redis: short-lived keys  │
                               └──────────────────────────────────┘
```

Read each row left to right or right to left: customer activity goes over REST to existing endpoints and out to the owner's room; the owner's offer goes through the offer service to that one customer's room; applying and paying goes through checkout, which claims the offer once and reports the conversion back to the owner. Every box reads and writes MongoDB; Redis holds only short-lived keys.

## Backend data model

Two new collections hold activity, and the existing `Discount` model gains targeting and redemption fields so checkout keeps one pricing path. All money is stored in rupees on `Discount` (as today) and computed in paise by `charges.service.js`.

**`CustomerSession`** (new, `models/CustomerSession.js`): one customer's visit to one restaurant.

| Field | Type | Notes |
| --- | --- | --- |
| `restaurantId` | ObjectId | Scopes every read; required |
| `userId` | ObjectId | Customer or guest user |
| `isGuest` | Boolean | Copied from the user's role at session start |
| `displayName` | String | First name only, "Customer" if the account has no name, or "Guest"; never phone or email |
| `pastOrderCount` | Number | Delivered orders at this restaurant, for the returning badge |
| `status` | enum | `active`, `idle`, `abandoned`, `converted`, `ended` |
| `startedAt`, `lastActivityAt` | Date | `lastActivityAt` drives timeouts |
| `lastEvent` | `{ type, label, at }` | Shown on the session row |
| `cart` | `{ items: [{ menuItemId, name, qty, unitPricePaise }], totalPaise, updatedAt }` | Snapshot from the server cart, never from the client |
| `cameFromSearch` | String or null | Search text, only if the customer then opened this restaurant |
| `eventCount` | Number | For the timeline header |
| `offerIds` | ObjectId[] | Offers sent in this session |
| `orderId` | ObjectId or null | Set on conversion |
| `expiresAt` | Date | TTL index, 90 days after `lastActivityAt` |

Indexes: `{ restaurantId: 1, status: 1, lastActivityAt: -1 }` for the dashboard list; partial unique `{ restaurantId: 1, userId: 1 }` where the session is open (`active` or `idle`), so a customer has at most one open session per restaurant; TTL on `expiresAt`.

**`ActivityEvent`** (new, `models/ActivityEvent.js`): one timeline entry.

| Field | Type | Notes |
| --- | --- | --- |
| `sessionId`, `restaurantId`, `userId` | ObjectId | `restaurantId` repeated for scoped queries |
| `type` | enum | See Activity capture |
| `data` | small object | `{ menuItemId, itemName, qty, deltaQty, totalPaise, query }` as relevant; at most 512 bytes |
| `at` | Date | Server time |
| `expiresAt` | Date | TTL index, 30 days |

Index: `{ sessionId: 1, at: 1 }` for the timeline; TTL on `expiresAt`.

**`Discount`** (existing) gains these fields; existing discounts keep `targetUserId: null` and behave exactly as today.

| Field | Type | Notes |
| --- | --- | --- |
| `kind` | enum | `public` (default) or `personal` |
| `targetUserId` | ObjectId or null | Required when `kind` is `personal` |
| `sessionId` | ObjectId or null | The session it was sent from |
| `maxDiscountAmount` | Number or null | Rupee cap; required for personal offers, at most 500 |
| `maxRedemptions` | Number | Default 1 for personal offers |
| `redemptionCount` | Number | Incremented atomically at order placement |
| `offerStatus` | enum | `sent`, `delivered`, `viewed`, `applied`, `redeemed`, `expired`, `revoked` |
| `deliveredAt`, `viewedAt`, `appliedAt`, `redeemedAt` | Date | Funnel timestamps |
| `orderId` | ObjectId or null | The order that redeemed it |
| `createdBy` | ObjectId | The owner who sent it |

New indexes: `{ targetUserId: 1, restaurantId: 1, offerStatus: 1, endDate: 1 }` for "my offers"; a boolean `isOpen` with a unique partial index on `{ restaurantId: 1, targetUserId: 1 }` (where `isOpen` is true) for the 1-active-offer rule; `{ restaurantId: 1, kind: 1, createdAt: -1 }` for offer metrics. Personal offers get no `code`, so they can never be applied through the code-based promo path.

**`Order`** (existing) already stores `appliedDiscountId`; no schema change. A new `User.preferences.shareActivity` Boolean (default `true`) records the opt-out.

## Backend activity capture

Events are recorded by the server inside endpoints the app already calls, so a modified or old app cannot fake, skip or inflate them. A new `services/activity.service.js` exposes one function, `record(req, restaurantId, type, data)`, called after the endpoint's own work succeeds. It never throws into the request: a failure is logged and the customer's request is unaffected.

**Who is tracked.** Only requests with a customer or guest token (`optionalAuthenticate` already sets `req.user`). Anonymous requests, owners, staff and riders are skipped, as are customers with `preferences.shareActivity` set to `false`.

**Events and where they come from**

| Event | Endpoint (existing) | Restaurant it belongs to | Data kept |
| --- | --- | --- | --- |
| `restaurant_viewed` | `GET /api/restaurants/:id`, `GET /api/restaurants/:id/menu` | `:id` | `cameFromSearch` if set |
| `menu_searched` | `GET /api/restaurants/:id/menu/search` | `:id` | query text (max 60 characters) |
| `item_viewed` | `GET /api/items/:id` | the item's `restaurantId` | `menuItemId`, `itemName` |
| `cart_item_added` | `POST /api/cart/items` | the cart's restaurant | item, qty, cart total |
| `cart_qty_changed` | `PATCH /api/cart/items/:lineItemId` | the cart's restaurant | item, old and new qty, cart total |
| `cart_item_removed` | `DELETE /api/cart/items/:lineItemId` | the cart's restaurant | item, cart total |
| `cart_cleared` | `DELETE /api/cart` | the cart's restaurant (read before clearing) | none |
| `checkout_started` | `GET /api/checkout/summary` | the cart's restaurant | cart total |
| `offer_viewed`, `offer_applied` | new offer endpoints (see API reference) | the offer's restaurant | `offerId` |
| `order_placed` | `POST /api/orders/checkout` after the order is created | the order's restaurant | `orderId`, total, `offerId` if redeemed |
| `went_idle`, `cart_abandoned`, `checkout_left` | session sweeper (below) | the session's restaurant | cart total |

**Search attribution.** The global restaurant search (`GET /api/search`) is not restaurant-scoped, so it never creates an event on its own. It stores `{ query, restaurantIds[] }` in Redis under `liveact:search:<userId>` (the `liveact:` prefix keeps clear of the existing `live:` keys used for rider presence) for 10 minutes. When that customer then opens a restaurant that was in those results, the session records `cameFromSearch`. A restaurant never sees searches that did not lead to it.

**Cart snapshot.** Cart events copy the server cart (items, quantities, unit prices, total in paise from `buildCartResponse`) onto the session. The dashboard never trusts a client-sent cart.

**Write and traffic limits**

- `restaurant_viewed` and `item_viewed` for the same session and item are coalesced to one per 60 seconds (Redis `SET NX EX 60` key per session + type + item).
- A session's `lastActivityAt` is updated with each kept event; repeat views inside the window only refresh it at most once per 30 seconds.
- Each event is one insert plus one session update; at the expected scale (tens of concurrent customers per restaurant) that is well under 50 writes per second.
- Socket emits go only to that restaurant's owner-only room (`owner:<id>`), and only for kept events.

**Session lifecycle**

1. The first tracked event for a customer at a restaurant opens a session (`active`). A new event after 30 minutes of silence opens a new one.
2. No event for 5 minutes: `idle`. Any event returns it to `active`.
3. 30 minutes after the last activity, with items in the cart: `abandoned` (emits `cart_abandoned`). 30 minutes after the last activity, with an empty cart: `ended`.
4. `checkout_started` with no `order_placed` within 10 minutes: emits `checkout_left`, status unchanged.
5. `order_placed`: `converted`; the session closes and links `orderId`.

The sweeper runs every 60 seconds in the existing `socket.js` interval block (alongside the rider sweeps), updating only sessions whose `lastActivityAt` crossed a threshold, using the dashboard index.

## Real-time delivery

The existing Socket.IO server carries both directions: activity to the restaurant's owner-only room, offers to a new per-customer room. Sockets are a fast path only. Every screen also loads its state over REST on open and on reconnect, so a missed message never loses data.

**Rooms and who may join**

| Room | Join event | Authorization | Receives |
| --- | --- | --- | --- |
| `owner:<id>` (existing, owner-only; never `restaurant:<id>`, which waiter sockets also join) | `join_restaurant { token, restaurantId }` | Access token verified; user is the restaurant's owner (existing check). There is no separate manager account; the portal's manager screens use the owner's login. | `activity_event`, `session_updated`, `offer_updated` |
| `user:<id>` (new) | `join_user { token }` | Access token verified; role `customer` (guests are refused); room id taken from the token, never from the payload | `offer_received`, `offer_updated` |

The customer room uses the verified token's `userId`, so a client cannot subscribe to someone else's offers. Joins acknowledge `{ ok: true }` or `{ ok: false, code }`, like the rider app's `join_partner`, so clients can retry with a fresh token.

**Server-to-client events**

| Event | Room | Payload |
| --- | --- | --- |
| `activity_event` | owner | `{ sessionId, type, label, at, data }` |
| `session_updated` | owner | the session row as the list shows it: `{ sessionId, displayName, isGuest, pastOrderCount, status, lastEvent, cart: { itemCount, totalPaise }, lastActivityAt, offerEligible }` |
| `offer_updated` | owner and user | `{ offerId, offerStatus, at, orderId? }` |
| `offer_received` | user | `{ offerId, restaurantId, restaurantName, title, type, percentage?, flatAmount?, maxDiscountAmount, minimumOrderValue, endDate }` |

Payloads never include phone, email, address or payment details.

**Reconnection and freshness**

- Clients rejoin on every `connect` with a token refreshed if it is close to expiry, as the rider app already does.
- On (re)join the portal refetches the session list and the customer app refetches its offers, so the UI is correct even if events were missed while disconnected.
- Socket auth uses the same short-lived access tokens; a server-side `disconnect` after a refused join triggers the client's own backoff retry.
- Customer delivery receipt: the app emits `offer_ack { offerId }` when it shows an offer; the server sets `deliveredAt` (and the owner sees "delivered"). The REST "my offers" fetch also counts as delivery.

**Scaling note.** Rooms live in one process today. Running more than one API instance will need the Socket.IO Redis adapter; the design keeps all emits behind one helper (`emitToRestaurant` — owner room only — and `emitToUser`) so that change touches one file.

## Offer lifecycle and redemption

An offer is checked when it is created, every time the cart is priced, and once more inside an atomic claim at order placement, so it is applied at most `maxRedemptions` times (1 for personal offers) even under concurrent checkouts.

**Lifecycle**

- `sent`: created by the owner; emitted to the customer's room.
- `delivered`: the app acknowledged it or fetched it.
- `viewed`: the customer opened the offer card.
- `applied`: attached to the customer's cart (`cart.appliedDiscountId`).
- `redeemed`: an order claimed it; `orderId` and `redeemedAt` set. Terminal.
- `expired`: `endDate` passed without redemption (set by the sweeper; also enforced on every check). Terminal.
- `revoked`: the owner withdrew it before redemption. Terminal.

An applied offer can be removed from the cart and goes back to `viewed`. If a redeemed order is cancelled before the restaurant accepts it, the claim is released (`redemptionCount` decremented) and the offer returns to `viewed` (not `applied`: the order already emptied the cart) while `endDate` is still in the future, otherwise `expired`.

**Creation checks** (`POST /api/owner/:restaurantId/live/offers`)

1. Caller is the restaurant's owner (existing `authorizeRestaurant`); `restaurantId` comes from the URL only. The body is parsed with an explicit zod schema, never spread into the model.
2. The session belongs to that restaurant, is not `ended` or `converted`, and its customer is not a guest and has not opted out.
3. Guardrails: no other offer from this restaurant to this customer in `sent`, `delivered`, `viewed` or `applied`; fewer than 3 offers to this customer from this restaurant since 00:00 IST; `percentage` between 1 and 50; `flatAmount` and `maxDiscountAmount` at most 500; expiry between 10 minutes and 24 hours from now.
4. Optional `applicableItems` must all belong to the restaurant.
5. A boolean `isOpen` (true until redeemed, expired or revoked) carries a unique partial index on `{ restaurantId, targetUserId }` where `isOpen` is true, so two owners clicking at once cannot both create an active offer; the second gets `OFFER_ALREADY_ACTIVE`.

**Validation on every price** (extends `discount.service.js`)

`validateDiscountForOrder` gains a `userId` argument and rejects with a specific code when:

| Check | Error code |
| --- | --- |
| Personal offer and `targetUserId` is not the caller | `OFFER_NOT_FOUND` (404, never reveals it exists) |
| Offer's restaurant is not the cart's restaurant | `OFFER_NOT_APPLICABLE` |
| `endDate` passed, or `offerStatus` is `expired` or `revoked` | `OFFER_EXPIRED` |
| `redemptionCount >= maxRedemptions` | `OFFER_ALREADY_USED` |
| Food subtotal below `minimumOrderValue` | `DISCOUNT_MIN_VALUE` (existing) |
| `applicableItems` set and none in the cart | `OFFER_NOT_APPLICABLE` |

`computeDiscountAmount` applies the percentage to the eligible items' subtotal only (all items when `applicableItems` is empty) and then caps it at `maxDiscountAmount`. `charges.service.js` already caps the discount at the food subtotal.

**Exactly-once redemption** (inside `createOrderFromCart`, `services/order.service.js`)

1. Price the cart as today, including the offer; the client's `expectedTotalPaise` must still match, so the customer always pays what they saw.
2. Claim one use: `Discount.findOneAndUpdate({ _id, targetUserId: userId, isOpen: true, endDate: { $gt: now }, $expr: { $lt: ['$redemptionCount', '$maxRedemptions'] } }, { $inc: { redemptionCount: 1 } })`. Only one concurrent request can win the last use; the loser gets `OFFER_ALREADY_USED` and no order is created.
3. Create the order with `appliedDiscountId` and `discountAmount` (existing fields).
4. If order creation throws, release the claim (`$inc: -1`). Then set `offerStatus: 'redeemed'`, `orderId`, `redeemedAt`, emit `offer_updated` to both rooms, and mark the session `converted`.

The existing `Idempotency-Key` on `POST /api/orders/checkout` means a retried request returns the first order instead of claiming twice. Online-payment orders that are never paid are cancelled by the existing approval timeout, which releases the claim through the same cancellation hook.

## API reference

Eleven new endpoints, and existing endpoints gain activity recording and offer checks; every response uses the existing `{ status, message, data }` envelope and error codes from `ApiError`.

**Owner** (mounted under the existing `/api/owner/:restaurantId`, behind `authenticate`, `authorizeRole('restaurant_owner')`, `authorizeRestaurant`)

| Method and path | Purpose | Notes |
| --- | --- | --- |
| `GET /live/sessions?status=active,idle,abandoned&limit=50` | Session list for the dashboard | Newest activity first; only this restaurant's sessions |
| `GET /live/sessions/:sessionId` | Session detail: header, cart, offers sent | 404 if the session is another restaurant's |
| `GET /live/sessions/:sessionId/events?before=<iso>&limit=50` | Timeline, paged backwards | Same scoping |
| `POST /live/offers` | Create a personal offer for a session | Body: `{ sessionId, title, type: 'percentage' or 'flat_amount', percentage?, flatAmount?, maxDiscountAmount, minimumOrderValue?, expiresInMinutes, applicableItems?[] }` |
| `POST /live/offers/:offerId/revoke` | Withdraw an unredeemed offer | Emits `offer_updated` to both rooms |
| `GET /live/offers?from=&to=` | Offers sent, with status and linked order | Paged |
| `GET /live/metrics?range=today` or `7d` or `30d` | Funnel and conversion | `{ sent, delivered, viewed, applied, redeemed, expired, conversionRate, revenuePaise, discountPaise }` |

**Customer** (behind `authenticate`; guests may read offers but cannot apply them)

| Method and path | Purpose | Notes |
| --- | --- | --- |
| `GET /api/offers/mine` | Open offers for the caller, newest first | Marks returned `sent` offers as `delivered` |
| `POST /api/offers/:offerId/viewed` | Record that the card was opened | Idempotent |
| `POST /api/cart/apply-offer` | Body `{ offerId }`; attaches it to the cart and returns the repriced cart | `requireCustomerAccount`; runs the full validation; errors as listed in Offer lifecycle |
| `DELETE /api/cart/offer` | Remove the applied offer | Returns the repriced cart |
| `PATCH /api/users/me/preferences` (existing) | Accepts `shareActivity: boolean` | Turning it off ends the customer's open sessions |

**Changed endpoints**

| Endpoint | Change |
| --- | --- |
| `GET /api/restaurants/:id`, `/menu`, `/menu/search`, `GET /api/items/:id`, `GET /api/search` | Call `activity.record` after a successful response (no response change) |
| `POST`, `PATCH`, `DELETE` under `/api/cart` | Call `activity.record` with the new cart snapshot |
| `GET /api/checkout/summary` | Records `checkout_started`; its bill already reflects an applied offer |
| `POST /api/orders/checkout` | Atomic offer claim and release; records `order_placed` |
| `POST /api/cart/apply-promo` | Refuses personal offers (they have no code) |

The old `POST /api/owner/:rid/live-monitor/offer` is removed (it is replaced by `POST /live/offers`), and `GET /live-monitor/visitors` is rewired to read sessions instead of the unused Redis visitor keys.

## Frontend: owner dashboard (restaurant portal)

The existing "Live Monitoring → Visitors Analysis" page (`/live-monitor`, `src/screens/LiveMonitor.jsx`) becomes the live dashboard; the manager page (`/manager/live`, `ManagerLiveMonitoring.jsx`, which runs on the same owner login) reuses the same components. No new route or sidebar entry is needed.

**Layout**

- **Header strip:** live sessions now, carts in progress (count and total), abandoned in the last hour, and today's offer funnel (sent → redeemed, conversion %). A connection dot shows Live / Reconnecting.
- **Session list (left, 40%):** one row per session, newest activity first. Row: display name and returning badge, status chip (Active green, Idle grey, Abandoned amber, Converted blue), last event in words ("Added Paneer Tikka ×2"), cart items and total, and time since last activity (ticking). Filters: All, Active, Abandoned, With cart. Guests and opted-out customers never appear as offer-eligible.
- **Session detail (right, 60%):** header (name, badge, came-from-search text, session start), current cart table (item, qty, price, total), offers sent in this session with their status, and the timeline (newest first, "load earlier" pages backwards).
- **Send offer** button on the detail panel, enabled only when `offerEligible` is true; when disabled it says why ("Guest — not eligible", "Already has an active offer", "Daily limit reached").
- **Offers tab:** all offers with status, customer, discount, expiry, linked order and value; the same funnel for 7 and 30 days.

**Send-offer form** (a dialog)

| Field | Input | Rule shown inline |
| --- | --- | --- |
| Title | text, 40 characters | Shown to the customer |
| Type | Percentage or Flat amount | |
| Value | number | Percentage 1 to 50; flat 1 to 500 |
| Maximum discount | ₹, required | At most ₹500 |
| Minimum order | ₹, optional | Defaults to none |
| Valid for | 15 min, 30 min, 1 h, 3 h, 24 h | |
| Dishes | optional multi-select from the menu | Empty = whole order |

A live preview shows what the customer's current cart would save ("On their ₹640 cart: ₹96 off"), computed by the server through a dry-run flag on `POST /live/offers` (`{ preview: true }`). Sending goes through the shared `ConfirmDialog` ("Send 15% off to Aarav, valid 30 minutes?").

**Data flow and state**

- **REST:** TanStack Query hooks in `src/hooks/owner/useLiveSessions.js` (`useLiveSessions`, `useSessionDetail`, `useSessionEvents`, `useSendOffer`, `useRevokeOffer`, `useOfferMetrics`), replacing the 30 s polling in `useLiveMonitor.js` for this page.
- **Socket:** a new `src/lib/socket.js` (dependency `socket.io-client` 4.8, matching the server) connects to `VITE_SOCKET_URL` (already in `.env.example`, falls back to `VITE_API_BASE`) and emits `join_restaurant` with a fresh owner token on every connect. A `useLiveSocket(restaurantId)` hook patches the query cache: `session_updated` upserts the row, `activity_event` prepends to the open session's timeline, `offer_updated` updates the offer chip and metrics.
- **Reconnect:** on `connect` the hook invalidates the session list and the open session, so anything missed while offline is refetched. While disconnected the page falls back to 30 s polling.
- **Ticking times:** one 15 s interval re-renders "2 min ago" labels; no per-row timers.

**Empty and error states:** no sessions ("No one is browsing right now"); sessions live in MongoDB, so the dashboard works without Redis; a send failure shows the server's error code mapped to plain words (e.g. `OFFER_ALREADY_ACTIVE` → "This customer already has an open offer from you").

## Frontend: customer app

The customer sees a one-time notice about activity sharing, a Settings toggle to turn it off, and personal offers in three places: an in-app banner when one arrives, the restaurant page, and cart and checkout where it is applied. Prices shown always come from the server.

**Transparency and control**

- **One-time notice** after the first sign-in (a bottom sheet): "Restaurants you visit can see what you browse and add to your cart in their store, with your first name only, to send you personal offers. You can turn this off in Settings." Buttons: "OK" and "Turn off". Stored per account via `PATCH /api/users/me/preferences`, with an AsyncStorage flag as an offline fallback so it isn't shown twice.
- **Settings → Privacy:** a "Share activity with restaurants" switch bound to `shareActivity`, with one line explaining what is shared and that turning it off also stops personal offers.
- Both are shown only when `GET /api/app/config` reports `liveActivity.enabled`.

**Receiving offers**

- `src/lib/socket.ts` already holds a shared socket. A new `useUserChannel()` hook in the root layout connects while the app is in the foreground and the customer is signed in (not a guest), emits `join_user` with the current token on every connect, and disconnects in the background to save battery.
- `src/services/offers.ts` (`getMyOffers`, `markOfferViewed`, `applyOffer`, `removeOffer`) and a small `OffersContext` hold the open offers. They are fetched on app open, on return to the foreground, on socket reconnect, and when `offer_received` or `offer_updated` arrives.
- **Arrival banner:** an in-app toast at the top, "Spice Garden sent you 15% off (up to ₹100) · ends in 29 min", tapping it opens the restaurant page with the offer card. The app emits `offer_ack` when it is shown.
- No system push in v1: an offer sent while the app is closed appears the next time it opens, if still valid.

**Where offers appear**

| Screen | What the customer sees |
| --- | --- |
| Restaurant page (`app/restaurant/[id].tsx`) | Offer card under the header: title, discount, cap, minimum order, dishes if limited, countdown; opening it calls `markOfferViewed` |
| Cart (`app/(tabs)/cart.tsx`) | "Offers for you" row with Apply / Remove; ineligible offers show why ("Add ₹120 more to use this") |
| Checkout (`app/checkout/index.tsx`) | Same row above the bill; the bill's Discount line comes from the server summary; Pay stays disabled while the bill reprices |
| Home (`app/(tabs)/index.tsx`) | A slim banner when any offer is open, linking to its restaurant |

**Applying and paying**

1. Apply calls `POST /api/cart/apply-offer`; the screen shows the server's repriced bill, never a client calculation.
2. Checkout's existing `expectedTotalPaise` and Pay confirmation ("Pay ₹544 online to Spice Garden?") cover the discounted total.
3. Errors map to plain words: `OFFER_EXPIRED` "This offer has ended", `OFFER_ALREADY_USED` "You've already used this offer", `DISCOUNT_MIN_VALUE` "Add ₹X more to use this offer", `OFFER_NOT_APPLICABLE` "This offer doesn't cover the dishes in your cart". The offer is removed from the cart and the bill refreshed.
4. After a successful order, the offer disappears from the list (status `redeemed`).

Guests never receive offers (the server refuses to create them), so no guest state is needed beyond the existing sign-in prompts.

## Privacy, retention, security and performance

Owners see only what happens in their own store, under a first name, for a limited time; every rule below is enforced on the server.

**Privacy**

- Minimum data: first name, a returning-order count, in-store events and the cart. Never phone, email, address, location, payment details or searches that did not lead to this restaurant.
- Opt-out is honoured at record time (no event is written) and at read time (sessions of opted-out customers are hidden). Turning sharing off ends that customer's open sessions immediately.
- Guests appear as "Guest" with no name.
- The one-time notice and Settings switch are the transparency controls; the privacy policy (`config/appConfig.config.js` legal documents) gets one paragraph describing activity sharing and offers.

**Retention**

| Data | Kept for | Mechanism |
| --- | --- | --- |
| `ActivityEvent` | 30 days | MongoDB TTL index on `expiresAt` |
| `CustomerSession` | 90 days after last activity | TTL index |
| Personal offers (`Discount`) | Kept, as they link to orders and settlement | Normal records |
| Redis keys (search attribution, coalescing; prefix `liveact:`) | 60 s to 10 min | `EX` on every key |

**Security**

- Every owner query is filtered by the URL's `restaurantId` after `authorizeRestaurant`; session and offer ids from another restaurant return 404, never 403.
- The offer body is parsed with an explicit zod schema; `restaurantId`, `targetUserId`, `redemptionCount`, `offerStatus` and `createdBy` are set by the server only. This also fixes the existing mass-assignment hole in the old offer endpoint.
- Socket rooms take identity from the verified token, never the payload. Activity goes only to the owner-only room, never to the shared restaurant room that waiter sockets join.
- Personal offers have no code and are never listed publicly, so they cannot be shared or guessed.
- Totals are always server-computed; the client's `expectedTotalPaise` only guards against paying a changed amount.
- Rate limits: offer creation 20 per minute per restaurant; the existing per-IP API limit covers customer endpoints.

**Performance**

- One insert plus one indexed update per kept event; view events coalesced to one per minute per session and item.
- The dashboard list is one indexed query (`restaurantId`, `status`, `lastActivityAt`), capped at 50 rows.
- The sweeper touches only sessions past a threshold, through the same index, once a minute.
- Socket messages are small (under 1 KB) and sent only to one owner room or one customer room.
- The old `redis.keys('live:visitor:*')` scan is removed.

## Testing, rollout and open questions

The work ships in steps, each with its own tests passing before the next starts; the backend lands first and is inert until the apps use it. The detailed prompts are in `yulo_backend/LIVE_ACTIVITY_IMPLEMENTATION_PROMPTS.md` (build backend → test backend → build frontend → test frontend → test together).

**Automated tests**

| Area | Where | Cases |
| --- | --- | --- |
| Activity attribution | backend `node:test` with the existing in-memory MongoDB harness | each endpoint writes the right event to the right restaurant; anonymous, owner and opted-out requests write nothing; view coalescing; search attribution only when the restaurant is opened |
| Session lifecycle | backend | active → idle → abandoned / ended timings; new session after 30 min; converted on order |
| Authorization | backend | owner A cannot list, read, or send offers to owner B's sessions (404); a waiter of A receives no activity or offer events; customer cannot join another user's room; socket join refused with a bad token |
| Offer creation | backend | every guardrail (1 active, 3 per day, 50%, ₹500, 10 min to 24 h, guest refused, opted-out refused); body cannot set `restaurantId` or counters |
| Pricing | backend | percentage on eligible items only, cap applied, minimum order, totals in paise match `charges.service.js`; personal offer refused by `apply-promo` and by any other user |
| Redemption | backend | 10 concurrent checkouts with one offer create exactly 1 discounted order; failed order creation releases the claim; cancellation before acceptance releases it; idempotent retry does not double-claim; expired offer refused |
| Real-time | backend with `socket.io-client` | `activity_event` reaches only the right restaurant's owner room, never waiter sockets; `offer_received` only the target customer |
| Owner dashboard | portal vitest | socket patches the list; send dialog validation and confirmation; error code messages |
| Customer app | app tests (`node:test` helpers) | offer state transitions; apply/remove flows map server errors correctly |
| Regression | existing suites | every pre-existing backend, portal and app test still passes |

**Rollout steps**

1. Backend models, `activity.service`, endpoint hooks and sweeper, behind an env flag `LIVE_ACTIVITY_ENABLED` (default off) and a pilot allow-list `LIVE_ACTIVITY_RESTAURANT_IDS`.
2. Offer fields, validation, apply/remove endpoints and atomic redemption; migrate nothing (new fields default to today's behaviour).
3. Socket rooms and emits.
4. Owner dashboard in the portal.
5. Customer app: notice, Settings switch, offers context, banners, apply flow (needs a store build only if a native module is added; none is planned).
6. Docs: `API.md`, `DEPLOYMENT.md` env flags, privacy policy paragraph. Turn the flag on for one restaurant, watch for a week, then all.

**Risks**

- A single API instance holds all socket rooms; scaling out needs the Redis adapter first.
- Owners may over-discount; the guardrails cap exposure at ₹500 per offer and 3 offers per customer per day.
- Offers sent while the customer's app is closed are only seen on next open (no customer push yet).

**Open questions**

- [x] Managers: answered by the code — there is no manager account; the portal's manager screens use the owner's login, so the owner sends offers.
- [ ] Should a cancelled order always return the offer, or only if the restaurant cancelled it?
- [ ] Is customer push (Expo/FCM) wanted soon, so offers reach a closed app?
- [ ] Should offers also be allowed for dine-in table sessions later?
