# YuloStores Backend — API Reference

Frontend integration guide for all REST endpoints and WebSocket events.

---

## Table of Contents

1. [Base URL & Transport](#base-url--transport)
2. [Authentication](#authentication)
3. [Response Envelope](#response-envelope)
4. [Error Codes](#error-codes)
5. [Rate Limiting](#rate-limiting)
6. [Public — Auth](#public--auth)
7. [Public — Restaurants](#public--restaurants)
8. [Public — Items](#public--items)
9. [Customer — Profile](#customer--profile)
10. [Customer — Favorites](#customer--favorites)
11. [Customer — Search](#customer--search)
12. [Customer — Home](#customer--home)
13. [Customer — Cart](#customer--cart)
14. [Customer — Checkout](#customer--checkout)
15. [Customer — Orders](#customer--orders)
16. [Customer — Order Tracking](#customer--order-tracking)
17. [Customer — Reviews](#customer--reviews)
18. [Customer — Support](#customer--support)
19. [Owner — Restaurant Management](#owner--restaurant-management)
20. [Owner — Staff Management](#owner--staff-management)
21. [Owner — Categories & Subcategories](#owner--categories--subcategories)
22. [Owner — Menu Items](#owner--menu-items)
23. [Owner — Tables & QR](#owner--tables--qr)
24. [Owner — Orders (view only)](#owner--orders-view-only)
25. [Owner — Bills](#owner--bills)
26. [Owner — Discounts](#owner--discounts)
27. [Owner — Loyalty Program](#owner--loyalty-program)
28. [Owner — Dashboard](#owner--dashboard)
29. [Owner — Live Monitor](#owner--live-monitor)
30. [Admin](#admin)
31. [Partner — Auth](#partner--auth)
32. [Partner — Onboarding](#partner--onboarding)
33. [Partner — Duty & Location](#partner--duty--location)
34. [Partner — Orders](#partner--orders)
35. [Partner — Earnings, Payouts & Deposits](#partner--earnings-payouts--deposits)
36. [Partner — Fleet Change Requests](#partner--fleet-change-requests)
37. [Partner — Training](#partner--training)
38. [Partner — Profile & Support](#partner--profile--support)
39. [Staff — Authentication](#staff--authentication)
40. [Waiter — Tables & Orders](#waiter--tables--orders)
41. [Kitchen — KDS](#kitchen--kds)
42. [Webhooks](#webhooks)
43. [WebSocket Events](#websocket-events)
44. [Common Patterns](#common-patterns)

---

## Base URL & Transport

```
http://localhost:3000/api          (development)
https://your-domain.com/api       (production)
```

All request and response bodies are `application/json` unless the endpoint accepts a file upload (`multipart/form-data`).

---

## Authentication

### Customer / Owner tokens

Obtained from `POST /api/auth/login`. Two tokens are issued:

| Token | Where sent | Lifetime |
|-------|-----------|---------|
| `accessToken` | `Authorization: Bearer <token>` header | 15 min |
| `refreshToken` | `Set-Cookie: refreshToken=...; HttpOnly; SameSite=Strict` | 7 days |

Include the access token on every protected request:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

### Staff token

Obtained from `POST /api/staff/auth/login`. Single long-lived token (8 hours):

```
Authorization: Bearer <staffToken>
```

### Partner token

Obtained from `POST /api/partner/auth/verify-otp` — see [Partner — Auth](#partner--auth).
Access + refresh pair, both signed with `JWT_PARTNER_SECRET` (a secret distinct from
customer/owner and staff tokens):

| Token | Where sent | Lifetime |
|-------|-----------|---------|
| `accessToken` | `Authorization: Bearer <token>` header | 15 min |
| `refreshToken` | JSON response body (no cookie — the mobile app has no cookie jar) | 30 days |

### Owner route scoping

Every owner endpoint is scoped to a restaurant they own:

```
/api/owner/:restaurantId/<resource>
```

`restaurantId` must belong to the authenticated owner, otherwise `403 FORBIDDEN`.

### Staff route scoping

Every staff endpoint is scoped to the restaurant they are assigned to:

```
/api/staff/:restaurantId/waiter/<resource>
/api/staff/:restaurantId/kitchen/<resource>
```

The `restaurantId` in the URL must match the staff member's assigned restaurant, otherwise `403 FORBIDDEN`.

---

## Response Envelope

**Success**

```json
{
  "status": "success",
  "message": "Human-readable description",
  "data": { ... }
}
```

`data` is `null` for delete/void operations.

**Error**

```json
{
  "status": "error",
  "code": "ERROR_CODE",
  "message": "Human-readable description",
  "details": { ... }
}
```

`details` is present only for `VALIDATION_ERROR` responses raised by the Zod request-body
validator (`middleware/validate.js`) and contains field-level messages. The same
`VALIDATION_ERROR` code can also be emitted directly from a raw Mongoose schema-validation
failure (`middleware/errorHandler.js`), and that path never sets `details`.

---

## Error Codes

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `VALIDATION_ERROR` | Request body failed schema validation — check `details` |
| 400 | `INVALID_TRANSITION` | Kitchen status change is not allowed from `currentStatus` to `newStatus` |
| 400 | `ORDER_ITEM_UNAVAILABLE` | One or more cart items are currently unavailable |
| 400 | `TABLE_SESSION_CLOSED` | Table session is no longer open |
| 400 | `QR_VOID` | QR code has been voided — rescan with the new QR |
| 400 | `DISCOUNT_EXPIRED` | Discount code date range has passed |
| 400 | `DISCOUNT_MIN_VALUE` | Order subtotal below discount minimum |
| 400 | `DISCOUNT_NOT_APPLICABLE` | Discount's `applicableTo` doesn't match this order type (e.g. a dine-in-only code applied to a delivery cart) |
| 401 | `UNAUTHORIZED` | No token provided |
| 401 | `INVALID_TOKEN` | Malformed or revoked token |
| 401 | `TOKEN_EXPIRED` | Access token has expired — call `/auth/refresh` |
| 401 | `INVALID_CREDENTIALS` | Wrong email/password or wrong PIN |
| 401 | `ACCOUNT_SUSPENDED` | The account tied to this phone/email/login has been deactivated |
| 400 | `OTP_EXPIRED` | OTP expired or never requested — request a new one |
| 400 | `INVALID_OTP` | Incorrect OTP code |
| 400 | `OTP_LOCKED` | Too many incorrect OTP attempts — request a new OTP |
| 403 | `FORBIDDEN` | Authenticated but not permitted for this action |
| 400 | `INVALID_STATE` | Admin store transition (or a veg-fleet keep-waiting/fallback call) not allowed from the resource's current state |
| 404 | `NOT_FOUND` | Resource does not exist |
| 409 | `CONCURRENT_UPDATE` | Kitchen order status changed between the server's own pre-write read and its write — simply retry the same request; the server re-reads the current status itself and does not use any client-supplied `currentStatus` |
| 409 | `DUPLICATE` | Unique constraint violated (e.g. duplicate discount code) |
| 409 | `DUPLICATE_KEY` | A unique field (`email`, `phone`, etc.) already exists — e.g. signing up with an email already in use |
| 409 | `CART_RESTAURANT_CONFLICT` | Cart already has items from a different restaurant — see `details.currentRestaurantName` |
| 409 | `CART_PRICE_CHANGED` | An item's price changed since it was added to the cart — see `details.items`; re-fetch the cart and retry checkout |
| 400 | `PAYMENT_VERIFICATION_FAILED` | Razorpay payment signature didn't match — `Order.paymentStatus` is set to `failed` |
| 400 | `INVALID_SIGNATURE` | Razorpay webhook signature didn't match `RAZORPAY_WEBHOOK_SECRET` — payload rejected, not processed |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 500 | `UPLOAD_FAILED` | Cloudinary upload failed |
| 403 | `NOT_VERIFIED` | Partner tried to go on duty before `verificationStatus: "approved"` |
| 409 | `PARTNER_BUSY` | Partner action blocked while on an active delivery |
| 403 | `NOT_YOUR_OFFER` / `NOT_YOUR_ORDER` | Partner tried to act on an order not offered/assigned to them |
| 409 | `OFFER_EXPIRED` | Delivery offer's acceptance window passed |
| 400 | `CHECKLIST_INCOMPLETE` | Veg-fleet partner didn't confirm the packaging checklist at pickup |
| 400 | `ALREADY_UNDER_REVIEW` / `ALREADY_APPROVED` / `REJECTED` / `INCOMPLETE_ONBOARDING` | Partner onboarding submission state errors |
| 409 | `ALREADY_PENDING` | Partner already has a pending fleet-change request |
| 403 | `NOT_APPROVED` | Partner training accessed before onboarding approval |
| 400 | `TRAINING_COMPLETE` / `INVALID_MODULE` / `MODULE_NOT_WATCHED` | Partner training progression errors |
| 400 | `INVALID_FILE_TYPE` | Uploaded file's MIME type isn't in the allowed list |

---

## Rate Limiting

| Scope | Limit |
|-------|-------|
| `POST /api/auth/signup`, `POST /api/auth/login`, `POST /api/auth/customer/otp/send`, `POST /api/auth/customer/otp/verify`, `POST /api/staff/auth/login`, `POST /api/partner/auth/request-otp`, `POST /api/partner/auth/verify-otp` | 10 requests / 1 min per IP (stacked on top of the row below) |
| All `/api/*` endpoints, including the ones above | 100 requests / 1 min per IP |

`POST /api/auth/refresh` and `POST /api/auth/logout` are only covered by the 100/min
limit — they do not go through the stricter 10/min limiter.

Exceeded limits return `429` with `Retry-After` header.

---

## Public — Auth

### Sign Up

```
POST /api/auth/signup
```

**No auth required.**

**Body**

```json
{
  "name": "Amir Suhail",
  "email": "amir@example.com",
  "password": "mypassword123",
  "role": "customer"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Min 2 chars |
| `email` | string | Yes | Valid email |
| `password` | string | Yes | Min 8 chars |
| `role` | `"customer"` \| `"restaurant_owner"` | No | Default: `"customer"` |

**Response `201`**

```json
{
  "status": "success",
  "message": "Account created",
  "data": {
    "user": {
      "_id": "664abc...",
      "name": "Amir Suhail",
      "email": "amir@example.com",
      "role": "customer"
    },
    "accessToken": "eyJ..."
  }
}
```

A `refreshToken` cookie is also set automatically. A duplicate `email` returns
`409 DUPLICATE_KEY`.

---

### Log In

```
POST /api/auth/login
```

**No auth required.**

**Body**

```json
{
  "email": "amir@example.com",
  "password": "mypassword123"
}
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "user": {
      "_id": "664abc...",
      "name": "Amir Suhail",
      "email": "amir@example.com",
      "role": "customer"
    },
    "accessToken": "eyJ..."
  }
}
```

A `refreshToken` HttpOnly cookie is set. Store `accessToken` in memory (not localStorage).

---

### Customer Login — Phone + OTP

Customers may also sign up/log in with a phone number instead of email+password. This is
a separate flow from `POST /api/auth/signup` / `POST /api/auth/login` (which remain the
only login method for `restaurant_owner` and `admin` roles) — it reuses the same
Redis-backed OTP mechanism the delivery-partner app uses (`POST
/api/partner/auth/request-otp`), including its dev-mode behavior: **no real SMS provider
is configured**, so outside of `NODE_ENV=production` the response echoes the code back as
`devOtp` instead of sending an SMS.

#### Send OTP

```
POST /api/auth/customer/otp/send
```

**No auth required.**

**Body**

```json
{ "phone": "9876543210" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | Exactly 10 digits, no country code |

**Response `200`**

```json
{
  "status": "success",
  "message": "OTP sent",
  "data": { "phone": "9876543210", "devOtp": "482913" }
}
```

`devOtp` is only present outside production. Rate-limited to 3 requests per 10 minutes
per phone number (`429 RATE_LIMITED` beyond that), on top of the standard `authLimiter`
(10 requests/minute per IP).

---

#### Verify OTP

```
POST /api/auth/customer/otp/verify
```

**No auth required.**

**Body**

```json
{ "phone": "9876543210", "code": "482913", "tosAccepted": true }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | Exactly 10 digits |
| `code` | string | Yes | The 6-digit OTP |
| `tosAccepted` | boolean | Yes | Must be `true` — records `tosAcceptedAt` on the user |

On first verification for a phone number, a new `customer` user is created automatically
(name/email are filled in later via `PATCH /api/users/me`). On subsequent verifications
for the same phone, the existing user logs in. `phoneVerifiedAt` is stamped on every
successful verify.

**Response `201`** (new user) or `200` (existing user)

```json
{
  "status": "success",
  "message": "Account created",
  "data": {
    "user": {
      "_id": "664abc...",
      "phone": "9876543210",
      "role": "customer",
      "phoneVerifiedAt": "2026-08-06T10:00:00.000Z",
      "tosAcceptedAt": "2026-08-06T10:00:00.000Z"
    },
    "accessToken": "eyJ...",
    "isNewUser": true
  }
}
```

A `refreshToken` cookie is also set, identical to `POST /api/auth/login`. If the phone
number is already attached to a non-`customer` account (`restaurant_owner`/`admin`),
this returns `403 FORBIDDEN` instead of logging in — phone+OTP can never be used to
authenticate as a higher-privileged role.

Errors reuse the same OTP error codes as the delivery-partner flow: `400 OTP_EXPIRED`,
`400 INVALID_OTP`, `400 OTP_LOCKED` (too many wrong attempts — request a new OTP). If the
phone belongs to an existing `customer` account that has been deactivated
(`isActive: false`), this returns `401 ACCOUNT_SUSPENDED` instead of logging in.

---

### Refresh Access Token

```
POST /api/auth/refresh
```

**No auth required.** Reads the `refreshToken` cookie automatically.

**Body** — none

**Response `200`**

```json
{
  "status": "success",
  "message": "Token refreshed",
  "data": {
    "accessToken": "eyJ..."
  }
}
```

Call this automatically in your axios/fetch interceptor when any request returns `401 TOKEN_EXPIRED`.

---

### Log Out

```
POST /api/auth/logout
```

**Auth: Bearer token (any authenticated `User` role — customer, restaurant_owner, or admin;
`authenticate` alone is applied, with no `authorizeRole` restriction)**

**Body** — none

**Response `200`**

```json
{
  "status": "success",
  "message": "Logged out",
  "data": null
}
```

The access token is blacklisted server-side and the refresh cookie is cleared.

---

## Public — Restaurants

### List Restaurants

```
GET /api/restaurants
```

**No auth required** — but if a valid `Authorization: Bearer <accessToken>` header is
present, for *any* authenticated role (`optionalAuthenticate` does not check `role`), each
restaurant gets an `isFavorited: boolean` field. It is omitted only when no token is sent,
or the token is missing/malformed/expired/revoked/for a deleted or deactivated user — i.e.
whenever the user can't be resolved at all, not based on role.

This is also the restaurant **search results** endpoint (screen 13) — passing `q`
switches it into search mode; omitting `q` is the plain geo-browse mode ("restaurants near
you").

**Query parameters**

| Param | Type | Example | Notes |
|-------|------|---------|-------|
| `q` | string | `"burger"` | Matches restaurant `name` **or** any `cuisineTypes` entry (case-insensitive substring). When present, `lat`/`lng` are not required and results aren't geo-sorted. |
| `lat` | number | `28.6139` | Required when `q` is omitted (geo-browse mode) |
| `lng` | number | `77.2090` | Required when `q` is omitted |
| `radius` | number | `5` | Kilometers, default 5 — only used in geo-browse mode |
| `minRating` | number | `4.0` | Only restaurants with `avgRating >=` this value |
| `hasOffers` | `"true"` | | Only restaurants with at least one currently-active (status `active` **and** within its date range right now) discount |
| `vegOnly` | `"true"` | | Only restaurants with `isPureVeg: true` — this is the explicit "Pure veg" filter chip, distinct from the ambient global veg-mode preference which filters/substitutes menu *content* rather than removing restaurants |
| `page` | number | `1` | Default 1 |

**Response `200`**

`message` is `"Nearby restaurants"` in geo-browse mode (no `q`, including cache hits) or
`"Search results"` when `q` is provided — the literal string `"Restaurants"` is never sent.

```json
{
  "status": "success",
  "message": "Nearby restaurants",
  "data": {
    "restaurants": [
      {
        "_id": "664abc...",
        "name": "Spice Garden",
        "description": "Authentic Indian cuisine",
        "cuisineTypes": ["Indian", "Mughlai"],
        "avgRating": 4.3,
        "totalRatings": 128,
        "isActive": true,
        "isPureVeg": false,
        "vegFleetAvailable": true,
        "badges": [],
        "startingPrice": 129,
        "address": {
          "street": "12 Main Road",
          "city": "Delhi",
          "state": "Delhi",
          "pincode": "110001"
        },
        "location": {
          "type": "Point",
          "coordinates": [77.209, 28.614]
        },
        "logo": "https://res.cloudinary.com/...",
        "isFavorited": false
      }
    ],
    "total": 42,
    "page": 1,
    "pages": 3
  }
}
```

`startingPrice` is the minimum `effectivePrice` across the restaurant's available menu
items (computed with one aggregation query for the whole page of results, not per
restaurant), in the same plain-rupee units as every other price field in this API
(`sellingPrice`, `discountedPrice`, `Order.subtotal`, etc.) — **not** minor/paise units.

> **Naming note:** Prompt 6's `OptionGroup`/`computeItemPrice` fields (`priceDeltaMinor`,
> `basePriceMinor`) were named as if this API used minor-unit currency, but nothing else
> in this codebase actually does — `MenuItem.sellingPrice`, `Order.subtotal`,
> `Bill.grandTotal`, `Discount.flatAmount` are all plain rupee numbers. `startingPrice`
> here intentionally follows the *actual* existing convention rather than perpetuating
> the mismatch. Worth reconciling `OptionGroup`'s field names to match at some point —
> flagging it here rather than silently renaming already-shipped fields.

`total`/`pages` are present whenever `q` is provided (search mode) and **omitted whenever
`q` is absent** (geo-browse mode, `lat`/`lng` required) — including if `minRating`/
`hasOffers`/`vegOnly` are also applied on top of a geo-browse. The cutoff is strictly
"does this query use `$near`", not "are any filters active": MongoDB only allows
`$geoWithin`/`$geoIntersects` inside the aggregation `$match` that computing a total
requires, never `$near`/`$nearSphere`, so an exact count isn't available for that query
shape without a second, differently-shaped query — not implemented here. Only the plain
geo-browse case (no `q`, no other filters either) is cached in Redis, for 60 seconds —
`isFavorited` is always computed per-request from the caller's own favorites and is never part of that
cached payload (neither is it part of the search/filtered-mode responses' cache, since
those aren't cached at all — only the plain geo-browse case is).

---

### Get Restaurant

```
GET /api/restaurants/:id
```

**No auth required** — same optional-auth `isFavorited` behavior as List Restaurants above.

**Response `200`**

`message` is `"Restaurant detail"`, not `"Restaurant"`. This returns the raw
`Restaurant.findOne(...).lean()` document with no field projection, so every real schema
field is present, not just the ones shown below (including onboarding/admin-internal
fields like `documents`, `adminNotes`, `rejectionReason`, `approvalStatus`, `plan`,
`settings.panNumber`/`gstNumber`). `cuisineType`, `priceRange`, `isOpen`, and the
`openingHours` object-of-weekday-strings shape shown in earlier revisions of this doc do
**not** exist on the model — the real fields are `cuisineTypes` (plural) and
`operatingHours` (an array, see below).

```json
{
  "status": "success",
  "message": "Restaurant detail",
  "data": {
    "restaurant": {
      "_id": "664abc...",
      "ownerId": "664owner...",
      "name": "Spice Garden",
      "description": "Authentic Indian cuisine",
      "category": "Indian",
      "cuisineTypes": ["Indian", "Mughlai"],
      "avgRating": 4.3,
      "totalRatings": 128,
      "isActive": true,
      "isVerified": true,
      "isPureVeg": false,
      "vegFleetAvailable": true,
      "badges": [],
      "approvalStatus": "active",
      "plan": "standard",
      "operatingHours": [
        { "day": "monday", "isOpen": true, "openTime": 900, "closeTime": 2200 },
        { "day": "tuesday", "isOpen": true, "openTime": 900, "closeTime": 2200 }
      ],
      "delivery": { "radiusKm": 5, "baseCharge": 0, "freeThreshold": 300, "estimatedMinutes": 35 },
      "address": { "street": "12 Main Road", "city": "Delhi", "state": "Delhi", "pincode": "110001" },
      "location": { "type": "Point", "coordinates": [77.209, 28.614] },
      "logo": "https://res.cloudinary.com/...",
      "coverImage": "https://...",
      "bannerImage": "https://...",
      "isFavorited": true
    }
  }
}
```

`operatingHours[].openTime`/`.closeTime` are `Number` in `HHMM` format (e.g. `900` =
9:00am, `2200` = 10:00pm) — matching the Owner section's Operating Hours endpoint — not
`"HH:MM"` strings. The schema itself only types these as plain `Number` with no format
enforcement, so this is a documented convention, not a server-side guarantee.

---

### Get Restaurant Menu

```
GET /api/restaurants/:id/menu
```

**No auth required** — same optional-auth behavior, but here `isFavorited` is threaded
into each **menu item** (favoriting is item-level here, not restaurant-level).

**Response `200`**

```json
{
  "status": "success",
  "message": "Menu",
  "data": {
    "menu": [
      {
        "_id": "664cat...",
        "name": "Starters",
        "subCategories": [
          {
            "_id": "664sub...",
            "name": "Soups",
            "items": [
              {
                "_id": "664item...",
                "name": "Tomato Soup",
                "description": "Fresh tomatoes blended smooth",
                "foodType": "veg",
                "sellingPrice": 150,
                "discountedPrice": 120,
                "effectivePrice": 120,
                "prepTime": 10,
                "ingredients": ["tomato", "cream", "herbs"],
                "badges": [],
                "vegVariantId": null,
                "optionGroups": [
                  {
                    "_id": "664og1...",
                    "title": "Choice of seasonal veg",
                    "type": "single_choice",
                    "required": true,
                    "sortOrder": 0,
                    "options": [
                      { "_id": "664opt1...", "name": "Bhindi Masala", "priceDeltaMinor": 0, "maxQty": 1, "isDefaultSelected": true },
                      { "_id": "664opt2...", "name": "Aloo Gobhi Adraki", "priceDeltaMinor": 0, "maxQty": 1, "isDefaultSelected": false }
                    ]
                  }
                ],
                "image": "https://...",
                "isAvailable": true,
                "isFavorited": false
              }
            ]
          }
        ],
        "items": []
      }
    ]
  }
}
```

Menu is served from a 5-minute Redis cache. `effectivePrice` = `discountedPrice` if set, else `sellingPrice`.
As with the list/detail endpoints above, `isFavorited` is computed per-request and never
part of the cached menu payload itself. `optionGroups` (see [Owner — Menu Items](#owner--menu-items)
for how they're managed) is `[]` for items with no customization.

---

### Search Restaurant Menu

```
GET /api/restaurants/:id/menu/search?q=
```

**No auth required** — same optional-auth `isFavorited` behavior. Powers the "search in
menu" bar (screen 15) — filters this one restaurant's items by name/description match.
Reads from the same 5-minute cached menu `GET /api/restaurants/:id/menu` uses, so this
doesn't hit MongoDB on every keystroke.

**Query parameters**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `q` | string | Yes | Case-insensitive substring match against item `name` or `description` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Menu search results",
  "data": {
    "items": [
      {
        "_id": "664item...",
        "name": "Tomato Soup",
        "description": "Fresh tomatoes blended smooth",
        "foodType": "veg",
        "sellingPrice": 150,
        "effectivePrice": 150,
        "isAvailable": true,
        "isFavorited": false
      }
    ]
  }
}
```

Returns a flat list (not grouped by category) — every matching item across the whole menu.

---

### Get Menu Categories

```
GET /api/restaurants/:id/menu/categories
```

**No auth required.** A lighter-weight version of the full menu payload, for the
category jump-sheet (screen 15) rather than the main menu page — built from the same
cached menu data as `GET /api/restaurants/:id/menu`, not a separate query.

**Response `200`**

```json
{
  "status": "success",
  "message": "Menu categories",
  "data": {
    "categories": [
      {
        "id": "664cat...",
        "name": "Main Course",
        "itemCount": 34,
        "subCategories": [
          { "id": "664sub1...", "name": "Royal Heritage Curries" },
          { "id": "664sub2...", "name": "Tandoori Delicacies" }
        ]
      }
    ]
  }
}
```

`itemCount` includes items nested under `subCategories` as well as items directly under
the category. It is **not** veg-mode-filtered — it always reflects the total item count
regardless of the caller's veg preference (the Figma export's own veg-mode variant of this
screen shows the same counts as the non-veg version, so this endpoint matches that rather
than introducing a filtered count the design doesn't call for).

---

### Get Restaurant Reviews

```
GET /api/restaurants/:id/reviews
```

**No auth required.**

**Query parameters**

| Param | Type | Default |
|-------|------|---------|
| `page` | number | 1 |

Page size is fixed at `20` (the controller's own `PAGE_SIZE` constant) — there is no
`limit` query parameter; passing one has no effect.

**Response `200`**

```json
{
  "status": "success",
  "message": "Reviews",
  "data": {
    "reviews": [
      {
        "_id": "664rev...",
        "userId": { "_id": "664u...", "name": "John", "profilePicture": null },
        "orderId": "664ord...",
        "rating": 5,
        "comment": "Excellent food and service!",
        "createdAt": "2026-06-17T10:30:00.000Z"
      }
    ],
    "total": 128,
    "page": 1
  }
}
```

No `pages` field is returned by this endpoint — compute `Math.ceil(total / 20)`
client-side if needed.

---

## Public — Items

### Get Item Detail

```
GET /api/items/:id
```

**No auth required** — same optional-auth `isFavorited` behavior as the restaurant
endpoints (present for any authenticated role that resolves; omitted only when no valid
token is presented). Used by the
item-detail/customization screen — this is the one place an item's full `optionGroups`
(with prices) is fetched standalone, rather than embedded in a whole restaurant's menu.

**Response `200`**

```json
{
  "status": "success",
  "message": "Item detail",
  "data": {
    "item": {
      "_id": "664item...",
      "restaurantId": "664abc...",
      "categoryId": "664cat...",
      "name": "Hyderabadi Biryani",
      "description": "Slow-cooked basmati rice with aromatic spices",
      "foodType": "non_veg",
      "sellingPrice": 201,
      "discountedPrice": null,
      "effectivePrice": 201,
      "badges": ["highly_reordered"],
      "vegVariantId": "664item_veg...",
      "isAvailable": true,
      "isFavorited": false,
      "optionGroups": [
        {
          "_id": "664og1...",
          "title": "Choice of seasonal veg",
          "type": "single_choice",
          "required": true,
          "options": [
            { "_id": "664opt1...", "name": "Bhindi Masala", "priceDeltaMinor": 0, "maxQty": 1, "isDefaultSelected": true },
            { "_id": "664opt2...", "name": "Aloo Gobhi Adraki", "priceDeltaMinor": 0, "maxQty": 1, "isDefaultSelected": false }
          ]
        },
        {
          "_id": "664og2...",
          "title": "Choice of rice",
          "type": "single_choice",
          "required": true,
          "options": [
            { "_id": "664opt3...", "name": "Steamed Basmati Rice", "priceDeltaMinor": 0, "maxQty": 1, "isDefaultSelected": true },
            { "_id": "664opt4...", "name": "Jeera Rice", "priceDeltaMinor": 20, "maxQty": 1, "isDefaultSelected": false }
          ]
        },
        {
          "_id": "664og3...",
          "title": "Add-ons",
          "type": "addons",
          "required": false,
          "minSelect": 0,
          "maxSelect": null,
          "options": [
            { "_id": "664opt5...", "name": "Extra butter dollop", "priceDeltaMinor": 30, "maxQty": 3, "isDefaultSelected": false }
          ]
        }
      ]
    }
  }
}
```

`404 NOT_FOUND` if the item doesn't exist or is currently unavailable. This endpoint is
**not** cached (unlike the restaurant menu) — it's a single-document lookup, not worth the
cache-invalidation complexity yet.

---

## Customer — Profile

All routes require `Authorization: Bearer <accessToken>`. There is no role restriction on
this router (`user.routes.js` only applies `authenticate`, not `authorizeRole`) — any
authenticated user, including `admin`, can call these routes.

### Get My Profile

```
GET /api/users/me
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Profile",
  "data": {
    "user": {
      "_id": "664u...",
      "name": "Amir Suhail",
      "email": "amir@example.com",
      "role": "customer",
      "phone": "+919876543210",
      "savedAddresses": [
        {
          "_id": "664addr...",
          "label": "home",
          "street": "45 Park Lane",
          "city": "Mumbai",
          "state": "Maharashtra",
          "pincode": "400001",
          "location": { "coordinates": [72.8777, 19.0760] },
          "isDefault": true
        }
      ],
      "createdAt": "2026-01-15T08:00:00.000Z"
    }
  }
}
```

`passwordHash` is never returned.

---

### Update Profile

```
PATCH /api/users/me
```

**Body** — send only fields to change

```json
{
  "name": "Amir S.",
  "phone": "+919876543210",
  "avatarUrl": "https://res.cloudinary.com/..."
}
```

`avatarUrl` is an alias for the `profilePicture` field returned on the user object —
there is no separate `avatarUrl` column; sending either name updates the same field.

**Response `200`**

```json
{
  "status": "success",
  "message": "Profile updated",
  "data": {
    "user": { ... }
  }
}
```

---

### Get Preferences

```
GET /api/users/me/preferences
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Preferences",
  "data": {
    "preferences": {
      "vegModeEnabled": false,
      "vegModeScope": "all_restaurants",
      "vegFleetPreferenceEnabled": false,
      "preferredLanguage": "en",
      "notifications": {
        "pushEnabled": false,
        "categories": [{ "key": "orders_and_purchases", "enabled": true }]
      }
    }
  }
}
```

`vegModeEnabled`/`vegModeScope` control app-wide menu filtering (Home, Search,
Restaurant, Item). `vegFleetPreferenceEnabled` is unrelated — it's just the default
pre-fill for the per-order "use a veg-only delivery fleet?" checkout toggle
(`Order.vegFleetOptIn`, added in a later step); it does not filter anything on its own.

---

### Update Preferences

```
PATCH /api/users/me/preferences
```

**Body** — send only fields to change; `notifications.categories` upserts by `key`
rather than replacing the whole list

```json
{
  "vegModeEnabled": true,
  "vegModeScope": "pure_veg_only"
}
```

```json
{
  "notifications": {
    "pushEnabled": true,
    "categories": [{ "key": "orders_and_purchases", "enabled": false }]
  }
}
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Preferences updated",
  "data": { "preferences": { ... } }
}
```

---

### Register Device (push token)

```
POST /api/users/me/devices
```

Stores a push-notification device token for later use. **No push notifications are
actually sent yet** — this endpoint only persists the token/platform pair.

**Body**

```json
{ "deviceToken": "fcm-or-apns-token", "platform": "android" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `deviceToken` | string | Yes | |
| `platform` | `"ios"` \| `"android"` \| `"web"` | Yes | |

Upserts by `deviceToken` — re-registering the same token (e.g. after a reinstall on a
different account) reassigns it to the calling user.

**Response `200`**

```json
{
  "status": "success",
  "message": "Device registered",
  "data": { "device": { "_id": "664dev...", "deviceToken": "...", "platform": "android" } }
}
```

---

### Remove Device

```
DELETE /api/users/me/devices/:deviceToken
```

**Response `200`** — `data: null`

---

### Add Saved Address

```
POST /api/users/me/addresses
```

**Body**

```json
{
  "label": "other",
  "customLabel": "Parents' Place",
  "street": "100 Business Park",
  "city": "Bangalore",
  "state": "Karnataka",
  "pincode": "560001",
  "location": { "coordinates": [77.5946, 12.9716] },
  "isDefault": false
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `label` | `"home"` \| `"work"` \| `"other"` | No | Default `"home"` |
| `customLabel` | string | Only if `label` is `"other"` | Ignored/cleared otherwise |
| `isDefault` | boolean | No | See note below |
| others | — | No | Same shape as before |

The **first address a customer saves is automatically made the default**, regardless of
`isDefault`. After that, setting `isDefault: true` on a new address unsets it on every
other saved address — at most one address is ever `isDefault: true`.

**Response `201`**

```json
{
  "status": "success",
  "message": "Address added",
  "data": {
    "savedAddresses": [
      {
        "_id": "664addr...",
        "label": "other",
        "customLabel": "Parents' Place",
        "street": "100 Business Park",
        "city": "Bangalore",
        "state": "Karnataka",
        "pincode": "560001",
        "location": { "coordinates": [77.5946, 12.9716] },
        "isDefault": true
      }
    ]
  }
}
```

---

### Update Saved Address

```
PATCH /api/users/me/addresses/:addrId
```

**Body** — send only fields to change; same field rules as create

```json
{ "street": "101 Business Park", "isDefault": true }
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Address updated",
  "data": { "savedAddresses": [ { ... } ] }
}
```

`404 NOT_FOUND` if `addrId` doesn't belong to the authenticated user.

---

### Set Default Address

```
PATCH /api/users/me/addresses/:addrId/default
```

**Body** — none

Marks this address as the default and unsets it on every other saved address.

**Response `200`**

```json
{
  "status": "success",
  "message": "Default address set",
  "data": { "savedAddresses": [ { ... } ] }
}
```

---

### Remove Saved Address

```
DELETE /api/users/me/addresses/:addrId
```

If the removed address was the default and other addresses remain, the first remaining
address is automatically promoted to default.

**Response `200`**

```json
{
  "status": "success",
  "message": "Address removed",
  "data": { "savedAddresses": [ { ... } ] }
}
```

---

## Customer — Favorites

All routes require `Authorization: Bearer <accessToken>`. There is no role restriction on
this router (favorites routes are defined in `user.routes.js` alongside profile routes,
which only applies `authenticate`, not `authorizeRole`) — any authenticated user can call
these routes. Restaurant favorites and menu-item favorites are separate resources —
favoriting a restaurant does not favorite its items and vice versa.

### List Favorite Restaurants

```
GET /api/users/me/favorites/restaurants
```

**Query parameters**

| Param | Type | Default |
|-------|------|---------|
| `page` | number | 1 |
| `limit` | number | 20 (max 50) |

**Response `200`**

```json
{
  "status": "success",
  "message": "Favorite restaurants",
  "data": {
    "restaurants": [
      { "_id": "664abc...", "name": "Spice Garden", "isFavorited": true, ... }
    ],
    "total": 3,
    "page": 1,
    "pages": 1
  }
}
```

Ordered most-recently-favorited first. Restaurants use the same object shape as `GET
/api/restaurants`.

---

### Favorite / Unfavorite a Restaurant

```
POST   /api/users/me/favorites/restaurants/:restaurantId
DELETE /api/users/me/favorites/restaurants/:restaurantId
```

**Body** — none for either. Both are idempotent: favoriting an already-favorited
restaurant, or unfavoriting one that isn't favorited, still returns `200`/`201` rather
than an error. `POST` returns `404 NOT_FOUND` if the restaurant doesn't exist.

**Response** — `data: null` for both.

---

### Favorite / Unfavorite a Menu Item

```
POST   /api/users/me/favorites/items/:menuItemId
DELETE /api/users/me/favorites/items/:menuItemId
```

Same semantics as the restaurant endpoints above (idempotent, `data: null`, `POST`
returns `404 NOT_FOUND` for an unknown item). There is no `GET
/api/users/me/favorites/items` list endpoint — favorited items surface via the
`isFavorited` field on `GET /api/restaurants/:id/menu` instead.

---

## Customer — Search

Base path: `/api/search`. Typeahead and popular searches are public (no personalization
in their response shape); recent searches require `Authorization: Bearer <accessToken>` —
any authenticated role can call them (no `authorizeRole` restriction exists in
`search.routes.js`), though the data returned is always scoped to the caller's own history.

### Typeahead

```
GET /api/search/typeahead?q=
```

**No auth required.** Merges two sources — restaurant name matches, and a **global**
dish-name match across every restaurant's menu (not scoped to one restaurant) — each
capped independently, then merged: restaurants first, then dishes.

**Query parameters**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `q` | string | Yes | Matched as a case-insensitive substring against restaurant names and menu item names |

**Response `200`**

```json
{
  "status": "success",
  "message": "Typeahead results",
  "data": {
    "results": [
      { "id": "664r1...", "name": "Green Leaf Kitchen", "type": "restaurant", "thumbnailUrl": "https://...", "foodType": null },
      { "id": "664i1...", "name": "Gosht Biryani", "type": "dish", "thumbnailUrl": "https://...", "foodType": "non_veg" },
      { "id": "664i2...", "name": "Ghee Laddu", "type": "dish", "thumbnailUrl": "https://...", "foodType": "veg" }
    ]
  }
}
```

`foodType` is `null` for `type: "restaurant"` rows. **Not veg-mode-filtered** — a
non-veg dish still appears with veg mode on; the client renders `foodType` as a veg/
non-veg indicator dot rather than hiding the row. This matches the Figma export's own
typeahead behavior (unlike Home/Search-results/Popular, which do filter or substitute
content when veg mode is on).

---

### Recent Searches

#### List

```
GET /api/search/recent
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Recent searches",
  "data": {
    "recent": [
      { "_id": "664sh1...", "query": "Biryani near me", "createdAt": "2026-06-17T10:00:00.000Z" }
    ]
  }
}
```

Most-recent first, capped at 20 per user.

#### Record

```
POST /api/search/recent
```

**Body**

```json
{ "query": "Paneer tikka" }
```

Call this when a search is **committed** (submitted), not on every keystroke. Re-recording
an identical query string moves it to the top rather than creating a duplicate entry;
writing beyond 20 entries silently drops the oldest.

**Response `201`** — `data: null`

#### Delete

```
DELETE /api/search/recent/:id
```

**Response `200`** — `data: null`. No error if `:id` doesn't exist or belongs to another
user's history (deletes 0 rows silently) — same idempotent-delete convention as favorites.

---

### Popular Searches

```
GET /api/search/popular?lat=&lng=&vegOnly=
```

**No auth required.** Returns the top 9 `SearchHistory.query` values by frequency across
**all** users in the last 7 days (one aggregate query — no separate trending-computation
job). `lat`/`lng` are accepted for future geo-scoping but not yet used to filter results.

If there's no search history at all in the last 7 days, falls back to a small hardcoded
seed list of 9 entries. This is an all-or-nothing fallback — if there's *some* history but
fewer than 9 distinct queries, the endpoint returns just those real rows; it never pads a
partial result set out with seed entries. **Only the fallback seed list differs by `vegOnly`** — real frequency-based
results are the same regardless of `vegOnly`, since there's no reliable way to classify an
arbitrary past free-text query (e.g. "biryani near me") as veg or non-veg without NLP this
codebase doesn't have.

**Response `200`**

```json
{
  "status": "success",
  "message": "Popular searches",
  "data": {
    "popular": [
      { "query": "Biryani" },
      { "query": "Paneer" },
      { "query": "North Indian" }
    ]
  }
}
```

---

## Customer — Home

### Get Home Feed

```
GET /api/home/feed?lat=&lng=&radius=&vegMode=&vegScope=
```

**No auth required** — but if a valid `Authorization: Bearer <accessToken>` header for a
logged-in customer is present, `isFavorited` is threaded into every restaurant and
recommended item, same as the restaurant/search endpoints. One aggregation call the
customer app makes on launch — built entirely from pieces that already exist elsewhere
(the same `$near` geo query `GET /api/restaurants` uses) plus a few new lightweight ones.

Only the **Food** vertical is returned — the Figma export's "Gifts & Toys"/"Bags" Home
tabs are explicitly out of scope (a materially larger, separate catalog project).

**Query parameters**

| Param | Type | Required | Notes |
|-------|------|----------|-------|
| `lat` | number | Yes | |
| `lng` | number | Yes | |
| `radius` | number | No | Kilometers, default 5 |
| `vegMode` | `"true"` | No | Global veg-mode preference — the client sends whatever it currently has (`User.preferences.vegModeEnabled`); this endpoint doesn't read stored preferences implicitly |
| `vegScope` | `"all_restaurants"` \| `"pure_veg_only"` | No | Default `"all_restaurants"`. Only matters when `vegMode=true` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Home feed",
  "data": {
    "nearbyRestaurants": [
      { "_id": "664r1...", "name": "The Heritage Grill", "avgRating": 4.5, "startingPrice": 129, "isPureVeg": false, "isFavorited": false, "...": "..." }
    ],
    "recommendedRestaurants": [
      { "_id": "664r2...", "name": "Spice Garden", "avgRating": 4.8, "startingPrice": 149, "isFavorited": true, "...": "..." }
    ],
    "recommendedItems": [
      { "_id": "664i1...", "name": "Chicken Biryani", "restaurantId": "664r2...", "foodType": "non_veg", "sellingPrice": 299, "effectivePrice": 299, "isFavorited": false }
    ],
    "quickFilterChips": [
      { "label": "Biryani", "iconUrl": null, "queryParam": "Biryani" },
      { "label": "Butter Chicken", "iconUrl": null, "queryParam": "Butter Chicken" }
    ],
    "banner": null,
    "vegBannerText": null
  }
}
```

**Field notes:**

- `nearbyRestaurants` — the same `$near` query and restaurant shape as `GET
  /api/restaurants` (including `startingPrice`), sorted by distance.
- `recommendedRestaurants` — **the exact same restaurants as `nearbyRestaurants`**, just
  re-sorted by `avgRating` descending instead of distance. Not a second query, and not a
  second set of restaurant objects — the same documents in a different array order.
- `recommendedItems` — a simple rule-based list (**not personalization/ML**): the
  top-rated-restaurant-first, then-most-recent available items from the same nearby
  restaurant set, capped at 10. This mirrors the same "don't fabricate a bigger feature
  than exists" precedent as `services/geo.service.js`'s haversine-only distance and
  `services/earnings.service.js`'s zeroed-out incentive fields.
- `quickFilterChips` — a small hardcoded config array (no CMS, owner/admin can't edit it
  yet — a candidate for a future admin-editable list).
- `banner` — `null` unless a restaurant among `nearbyRestaurants` has an active,
  currently-in-date-range Discount with `isFeatured: true` (see [Owner —
  Discounts](#owner--discounts)). Reuses the existing `Discount` model — no separate
  promo/banner model. "Platform-wide" in the sense of "not restricted to one restaurant's
  own menu view", not a literal restaurant-less global discount type — `Discount.restaurantId`
  stays required.
- `vegBannerText` — a static string (`null` when `vegMode` is false) purely so the client
  doesn't hardcode copy that might change later; not a CMS.

**How veg mode affects each field:**

| Field | `vegMode=false` | `vegMode=true`, `vegScope=all_restaurants` | `vegMode=true`, `vegScope=pure_veg_only` |
|---|---|---|---|
| `nearbyRestaurants` / `recommendedRestaurants` | Unfiltered | Unfiltered (any restaurant can appear) | Filtered to `isPureVeg: true` only |
| `recommendedItems` | Unfiltered | Non-veg items with a `vegVariantId` are swapped for their veg substitute; non-veg items with **no** substitute are dropped entirely | Same substitution logic, though restaurants are already all-veg by construction |

---

## Customer — Cart

Base path: `/api/cart`. All routes require `Authorization: Bearer <accessToken>` with
role `customer`. There is exactly **one active cart per customer** — every endpoint
operates on the caller's own cart implicitly (no cart id in any URL), and `GET /api/cart`
auto-creates an empty one on first access rather than 404ing.

A cart can only ever hold items from **one restaurant at a time**. Adding an item from a
different restaurant than what's already in the cart doesn't silently replace it —
`POST /api/cart/items` returns `409 CART_RESTAURANT_CONFLICT` instead, and the client
renders the "Discard cart from X?" dialog (screen 10) from that response.

> **Naming note:** field names below (`unitPrice`, `itemTotal`, `deliveryFee`, etc.) are
> plain rupee numbers, **not** minor/paise units — same convention as `MenuItem.sellingPrice`,
> `Order.subtotal`, and every other price in this API. See the naming note under
> [Public — Restaurants](#public--restaurants) for why `OptionGroup`'s `priceDeltaMinor`/
> `basePriceMinor` (Prompt 6) don't actually match this.

### Get Cart

```
GET /api/cart
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Cart",
  "data": {
    "cart": {
      "_id": "664cart...",
      "userId": "664u...",
      "restaurantId": "664r1...",
      "items": [
        {
          "_id": "664line1...",
          "menuItemId": "664item...",
          "name": "Hyderabadi Biryani",
          "unitPrice": 221,
          "qty": 2,
          "selectedOptions": [{ "optionId": "664opt4...", "qty": 1 }],
          "resolvedOptions": [
            { "optionId": "664opt4...", "qty": 1, "name": "Jeera Rice", "priceDelta": 20 }
          ]
        }
      ],
      "appliedDiscountId": null
    },
    "bill": {
      "itemTotal": 442,
      "deliveryFee": 35,
      "platformFee": 6,
      "tax": 22.1,
      "discountAmount": 0,
      "grandTotal": 505.1
    }
  }
}
```

`selectedOptions` is what's actually stored (`{ optionId, qty }` only); `resolvedOptions`
is computed fresh on every read (option name + price delta) purely for display — it's
never persisted. `unitPrice` is the **fully-customized per-serving price** (base price +
every selected option's delta × that option's own qty) snapshotted once at add-time —
it does not change if the restaurant later edits the item's price or option prices, same
as how `Order` line items are never retroactively repriced.

---

### Add Item

```
POST /api/cart/items
```

**Body**

```json
{
  "menuItemId": "664item...",
  "qty": 2,
  "selectedOptions": [{ "optionId": "664opt4...", "qty": 1 }]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `menuItemId` | string | Yes | |
| `qty` | number | No | Default 1 — how many servings of this exact configuration |
| `selectedOptions` | array | No | `[{ optionId, qty }]` — `qty` only meaningful for `addons`-type option groups |

Selections are validated server-side against the item's `OptionGroup`s using the same
`computeItemPrice` function checkout will later re-validate with — an invalid combination
(missing a required group, exceeding an add-on's `maxQty`, etc.) returns `400
VALIDATION_ERROR` with per-issue messages in `details.errors`, never a silently-wrong price.

Always adds a **new line**, even if an identical `menuItemId`+`selectedOptions`
combination is already in the cart — two separate `POST` calls produce two lines, not a
merged quantity. Use `PATCH /api/cart/items/:lineItemId` to change an existing line's quantity.

**Response `201`** — same shape as `GET /api/cart`.

**Response `409`** (restaurant conflict)

```json
{
  "status": "error",
  "code": "CART_RESTAURANT_CONFLICT",
  "message": "Your cart has items from another restaurant",
  "details": { "currentRestaurantName": "Jalaram Sweets" }
}
```

---

### Update Item Quantity

```
PATCH /api/cart/items/:lineItemId
```

**Body**

```json
{ "qty": 3 }
```

`qty: 0` removes the line (same effect as `DELETE`). Does **not** re-price the line —
`unitPrice` stays whatever was snapshotted when it was added.

**Response `200`** — same shape as `GET /api/cart`. `404 NOT_FOUND` if `lineItemId`
doesn't exist in the caller's cart.

---

### Remove Item

```
DELETE /api/cart/items/:lineItemId
```

**Response `200`** — same shape as `GET /api/cart`. If this was the last item, the cart's
`restaurantId` and `appliedDiscountId` are automatically cleared back to `null` — so the
next add from a different restaurant won't spuriously trigger `CART_RESTAURANT_CONFLICT`
against a cart that has nothing in it.

---

### Discard Cart

```
DELETE /api/cart
```

Explicit "Discard cart" action (screen 10) — clears `items`, `restaurantId`, and
`appliedDiscountId` in one call, regardless of what's currently in it.

**Response `200`** — same shape as `GET /api/cart` (an empty cart + all-zero bill).

---

### Apply Promo Code

```
POST /api/cart/apply-promo
```

**Body**

```json
{ "code": "YUMMY100" }
```

Looks up a `Discount` by `code` scoped to the cart's current restaurant, and validates it
with the same active/date-range/minimum-order/`applicableTo` checks the owner-side bill
discount flow uses (`orderType: "delivery"` — a dine-in-only or table-wise discount is
rejected with `400 DISCOUNT_NOT_APPLICABLE`). `400 VALIDATION_ERROR` if the cart is empty.

The applied discount is **re-validated on every subsequent `GET /api/cart`**, not just
at apply-time: if removing items drops the subtotal below `minimumOrderValue`, or the
discount expires, `bill.discountAmount` silently drops to `0` without erroring —
`appliedDiscountId` itself is left in place, so adding items back and clearing the
minimum-value issue makes it start applying again automatically, with no need to re-enter
the code.

**Response `200`** — same shape as `GET /api/cart`, with `bill.discountAmount` reflecting
the applied discount.

Errors: `404 NOT_FOUND` (no such code for this restaurant), `400 DISCOUNT_EXPIRED`, `400
DISCOUNT_MIN_VALUE`, `400 DISCOUNT_NOT_APPLICABLE`.

---

## Customer — Checkout

Base path: `/api/checkout`. Requires `Authorization: Bearer <accessToken>` with role
`customer`.

### Get Checkout Summary

```
GET /api/checkout/summary
```

Everything the checkout screen (screen 19/19v) needs in one call — the cart, its bill,
the default delivery address, an upsell list, and whether the veg-fleet toggle should
even be offered. A `cartId` query param is accepted for forward compatibility but
ignored — there is only ever one active cart per customer (Prompt 9), so this always
reads the caller's own.

**Response `200`**

```json
{
  "status": "success",
  "message": "Checkout summary",
  "data": {
    "address": {
      "_id": "664addr...",
      "label": "home",
      "street": "45 Park Lane",
      "city": "Mumbai",
      "isDefault": true
    },
    "cart": { "...": "same shape as GET /api/cart" },
    "bill": { "...": "same shape as GET /api/cart" },
    "upsellItems": [
      { "_id": "664up1...", "name": "Gulab Jamun", "sellingPrice": 80, "effectivePrice": 80, "badges": ["bestseller"] }
    ],
    "vegFleetEligible": true
  }
}
```

| Field | Notes |
|-------|-------|
| `address` | The customer's default (`isDefault: true`) saved address, or their first saved address if none is marked default, or `null` if they have none saved yet. To checkout with a *different* address, use the existing [Set Default Address](#customer--profile) endpoint first, then re-fetch this summary. |
| `upsellItems` | Up to 5 items from the cart's restaurant not already in the cart — bestseller-badged items first, then most recent. Rule-based, reusing the same cached menu data `GET /api/restaurants/:id/menu` uses; **not** a recommendation engine. Empty if the cart is empty. |
| `vegFleetEligible` | `true` only when **both** `User.preferences.vegModeEnabled` and the cart's restaurant's `vegFleetAvailable` are true. The client shows the veg-fleet checkout toggle (screen 19v) only when this is `true` — screen 19 (no toggle at all) is what renders when it's `false`. `false` (not an error) if the cart is empty. |

---

## Customer — Orders

Requires `Authorization: Bearer <accessToken>` with role `customer`.

### Create Delivery Order

```
POST /api/orders
```

**Headers**

| Header | Required | Notes |
|--------|----------|-------|
| `Authorization` | Yes | Bearer token |
| `Idempotency-Key` | Recommended | UUID v4 — prevents duplicate orders on network retry |

**Body**

```json
{
  "restaurantId": "664abc...",
  "type": "delivery",
  "items": [
    { "menuItemId": "664item...", "quantity": 2 },
    { "menuItemId": "664item2...", "quantity": 1 }
  ],
  "deliveryAddress": {
    "street": "45 Park Lane",
    "city": "Mumbai",
    "state": "Maharashtra",
    "pincode": "400001",
    "coordinates": [72.8777, 19.0760]
  },
  "paymentMethod": "cash",
  "specialInstructions": "Extra spicy please"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `restaurantId` | string | Yes | MongoDB ObjectId |
| `type` | `"delivery"` \| `"takeaway"` | Yes | Not delivery-only — `"takeaway"` is also accepted here |
| `items` | array | Yes | Min 1 item |
| `items[].menuItemId` | string | Yes | |
| `items[].quantity` | number | Yes | Min 1 |
| `items[].note` | string | No | Per-item note, e.g. "no onions" |
| `deliveryAddress` | object | No | Optional on this endpoint — no address lookup/validation happens here (unlike `POST /api/orders/checkout`, which resolves a saved address) |
| `paymentMethod` | `"cash"` \| `"online"` \| `"card"` | No | Default `"cash"` |
| `specialInstructions` | string | No | |

**Response `201`**

```json
{
  "status": "success",
  "message": "Order placed",
  "data": {
    "order": {
      "_id": "664ord...",
      "restaurantId": "664abc...",
      "userId": "664u...",
      "type": "delivery",
      "status": "placed",
      "items": [
        {
          "menuItemId": "664item...",
          "name": "Tomato Soup",
          "price": 120,
          "quantity": 2,
          "note": ""
        }
      ],
      "subtotal": 330,
      "deliveryAddress": { ... },
      "specialInstructions": "Extra spicy please",
      "createdAt": "2026-06-17T10:45:00.000Z"
    }
  }
}
```

Item prices are **snapshotted** at order creation — future menu price changes do not affect this order. Note the order's customer-reference field is `userId`, not `customerId`.

> If `Idempotency-Key` matches a request already processed within the last 24h, the response is `200` with `message: "Duplicate — existing order returned"` and a minimal `data: { order: { orderId: "<id>" } }` — **not** the full order body shown above.

---

### Checkout (place order from cart)

```
POST /api/orders/checkout
```

The primary, recommended way to place a delivery order — turns the customer's current
cart (Prompt 9) into a real `Order`. Distinct from `POST /api/orders` above (a different
input contract: this reads the server-side cart rather than trusting a client-sent
`items` array), which remains available unchanged.

**Headers**

| Header | Required | Notes |
|--------|----------|-------|
| `Authorization` | Yes | Bearer token |
| `Idempotency-Key` | Recommended | Same UUID v4 convention as `POST /api/orders` |

**Body**

```json
{
  "addressId": "664addr...",
  "deliveryInstructions": "Leave at the door, ring the bell",
  "cookingRequests": false,
  "extraCutlery": true,
  "tip": 20,
  "vegFleetOptIn": true,
  "paymentMethod": "cod"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `addressId` | string | No | Defaults to the customer's default saved address (same fallback as [Get Checkout Summary](#customer--checkout)). `400 VALIDATION_ERROR` if omitted and no saved address exists. |
| `deliveryInstructions` | string | No | Free text **for the delivery partner** — distinct from kitchen-facing `specialInstructions`. Surfaces in the partner's order-offer payload. |
| `cookingRequests` | boolean | No | Default `false`. Flows to the restaurant/kitchen (`new_order` socket event), not the delivery partner. |
| `extraCutlery` | boolean | No | Default `false`. Same audience as `cookingRequests`. |
| `tip` | number | No | Default `0`. Added to `grandTotal`. |
| `vegFleetOptIn` | boolean | No | Default `false`. Only actually honored if the cart's restaurant has `vegFleetAvailable: true` — see [Get Checkout Summary](#customer--checkout)'s `vegFleetEligible`. A `true` sent for an ineligible restaurant is silently treated as `false`, never trusted at face value. |
| `paymentMethod` | `"cod"` \| `"online"` | No | Default `"cod"` — a fully first-class path, not a fallback (matches screen 19's default-selected payment bar). `"online"` creates a real Razorpay order (when `RAZORPAY_KEY_ID` is configured) and returns `clientSecret` for the client to open Razorpay Checkout with. |

Before creating the order, this **re-validates every cart item fresh** against the
current menu (prices/availability may have changed since items were added to the cart):

- If an item is no longer available (or its customization is no longer valid — e.g. the
  owner deleted an option group it depended on), the whole checkout is rejected with
  `400 ORDER_ITEM_UNAVAILABLE` and `details.items` listing which ones.
- If an item's current price differs from what the cart displayed, checkout is rejected
  with `409 CART_PRICE_CHANGED` and `details.items` showing `oldPrice`/`newPrice` per
  item — **never** silently charges a different amount than what was shown. Re-fetch
  `GET /api/cart` (which recomputes against current prices) and retry.

On success, the cart is cleared (items, restaurant, and applied discount all reset).

**Response `201`** (or `200` if idempotency key matched)

```json
{
  "status": "success",
  "message": "Order placed",
  "data": {
    "orderId": "664ord...",
    "restaurantName": "Green Leaf Kitchen",
    "status": "placed",
    "vegFleetOptIn": true,
    "order": {
      "_id": "664ord...",
      "restaurantId": "664abc...",
      "type": "delivery",
      "status": "placed",
      "items": [ { "menuItemId": "664item...", "name": "Paneer Butter Masala", "price": 350, "quantity": 1 } ],
      "subtotal": 350,
      "deliveryFee": 35,
      "platformFee": 6,
      "tax": 17.5,
      "tip": 20,
      "discountAmount": 0,
      "grandTotal": 428.5,
      "paymentMethod": "cash",
      "paymentStatus": "pending_cod",
      "paymentIntentId": null,
      "deliveryInstructions": "Leave at the door, ring the bell",
      "cookingRequests": false,
      "extraCutlery": true,
      "vegFleetOptIn": true,
      "vegFleetAssignmentStatus": "searching",
      "vegFleetSearchDeadline": "2026-06-17T11:03:00.000Z",
      "dedicatedBagRequired": true,
      "createdAt": "2026-06-17T11:00:00.000Z"
    }
  }
}
```

`orderId`/`restaurantName`/`status`/`vegFleetOptIn` are pulled to the top level so the
order-confirmation screen (22/22v) can render immediately from this one response — no
extra round-trip needed. `clientSecret` is only present as a key at all when
`paymentMethod: "online"` — for `"cod"` (as in the example above), the key is omitted
entirely, not sent as `null`.

> Same idempotency caveat as `POST /api/orders`: if `Idempotency-Key` matches a request
> already processed within the last 24h, the response is `200` with
> `message: "Duplicate — existing order returned"` and a minimal
> `data: { order: { orderId: "<id>" } }` — not the full response shown above.

When `vegFleetOptIn` is honored, `vegFleetAssignmentStatus` starts as `"searching"` (not
`"assigned"`) with a `vegFleetSearchDeadline` a few minutes out — see the veg-fleet
endpoints below for how that resolves. Delivery-partner search itself doesn't start at
order placement; it starts when the restaurant confirms the order (`status: "placed" ->
"confirmed"`), same as every other delivery order — this is unchanged by veg-fleet.

**`paymentStatus` at creation** depends on `paymentMethod`:

| `paymentMethod` | Initial `paymentStatus` | Meaning |
|---|---|---|
| `"cod"` | `"pending_cod"` | Cash/UPI-QR to be collected in person on delivery — not "payment failed to start", a normal first-class end state until the delivery partner marks it collected |
| `"online"` | `"pending"` | Awaiting confirmation via [Verify Payment](#verify-payment) below or the Razorpay webhook |

---

### Verify Payment

```
POST /api/orders/:id/payment/verify
```

Confirms an `"online"` payment after the client's Razorpay Checkout flow completes.
Called with the three values Razorpay's Checkout SDK returns to the client on success.

**Body**

```json
{
  "razorpay_payment_id": "pay_XYZ789",
  "razorpay_order_id": "order_ABC123",
  "razorpay_signature": "5f4dcc3b5aa765d61d8327deb882cf99..."
}
```

| Field | Type | Required |
|-------|------|----------|
| `razorpay_payment_id` | string | Yes |
| `razorpay_order_id` | string | Yes |
| `razorpay_signature` | string | Yes |

Verifies `razorpay_order_id` matches this order's stored `paymentIntentId` (set when the
Razorpay order was created at checkout — rejects with `400 VALIDATION_ERROR` if it
doesn't, i.e. this payment doesn't belong to this order), then verifies
`razorpay_signature` is a valid HMAC-SHA256 of `"<razorpay_order_id>|<razorpay_payment_id>"`
using `RAZORPAY_KEY_SECRET` — Razorpay's documented client-side verification scheme.

**Response `200`** (signature valid)

```json
{
  "status": "success",
  "message": "Payment verified",
  "data": { "order": { "...": "...", "paymentStatus": "paid" } }
}
```

**Response `400`** (signature invalid) — `Order.paymentStatus` is set to `"failed"` either way

```json
{
  "status": "error",
  "code": "PAYMENT_VERIFICATION_FAILED",
  "message": "Payment signature verification failed"
}
```

If the client-side call never arrives at all (network drop, app killed mid-payment), the
[Razorpay webhook](#webhooks) below reaches the same end state independently.

---

### Veg-Fleet Assignment (screen 23)

Only relevant for orders placed with `vegFleetOptIn: true`. All three require
`Authorization: Bearer <accessToken>` with role `customer`, and only operate on the
caller's own order (`404 NOT_FOUND` otherwise).

#### Get Status

```
GET /api/orders/:id/veg-fleet/status
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Veg-fleet status",
  "data": { "status": "searching", "remainingSeconds": 142 }
}
```

`status` is one of `not_requested` / `searching` / `assigned` / `fallback_any_partner`
(`Order.vegFleetAssignmentStatus`). `remainingSeconds` is derived from
`vegFleetSearchDeadline` and is `null` once the order is `assigned` or
`fallback_any_partner` (no countdown applies anymore).

A `veg_fleet_status_updated` event is also emitted on the existing `order:<id>` socket
room every time this status changes (placement, keep-waiting, fallback, the auto-extend
sweep, or an actual assignment) — see [WebSocket Events](#websocket-events). Poll this
endpoint as a fallback; prefer the socket event to avoid polling.

---

#### Keep Waiting

```
POST /api/orders/:id/veg-fleet/keep-waiting
```

**Body** — none. Extends `vegFleetSearchDeadline` by another full search window; status
stays `"searching"`. This is also what happens **automatically**, with no customer
action, if the deadline passes on its own — screen 23's "Auto-defaults to keep waiting"
copy is literal: silence defaults to continuing the search, never to relaxing it.

**Response `200`**

```json
{
  "status": "success",
  "message": "Still searching for a veg-only partner",
  "data": { "status": "searching", "remainingSeconds": 180 }
}
```

`400 INVALID_STATE` if the order isn't currently `"searching"` (already assigned, already
fell back, or never requested a veg fleet).

---

#### Fall Back to Any Partner

```
POST /api/orders/:id/veg-fleet/fallback
```

**Body** — none. The customer's explicit "Send any available partner" choice. Relaxes the
partner search to any active, verified delivery partner — **not just** veg-fleet-capable
ones — and retries assignment immediately rather than waiting for the next automatic
retry. `dedicatedBagRequired` stays `true` regardless: screen 23 promises a sanitised,
unbatched bag even on fallback, and this only relaxes *which partner* may be offered the
order, not that hygiene guarantee.

**Response `200`**

```json
{
  "status": "success",
  "message": "Searching for any available partner",
  "data": { "status": "fallback_any_partner" }
}
```

`400 INVALID_STATE` under the same conditions as Keep Waiting above.

---

### List My Orders

```
GET /api/orders
```

**Query parameters**

| Param | Type | Default |
|-------|------|---------|
| `page` | number | 1 |
| `limit` | number | 20 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Orders",
  "data": {
    "orders": [
      {
        "_id": "664ord...",
        "status": "delivered",
        "items": [ ... ],
        "grandTotal": 408.5,
        "vegFleetOptIn": true,
        "vegFleetAssignmentStatus": "assigned",
        "dedicatedBagRequired": true,
        "rating": null,
        "createdAt": "..."
      }
    ],
    "total": 15,
    "page": 1,
    "pages": 1
  }
}
```

`rating` is `null` if the customer hasn't reviewed this order yet, else `{ value,
comment, createdAt }` — a join against `Review` (indexed on `orderId`), not a field
stored on `Order` itself. Screen 28's order-history cards use this to decide whether to
show a "Rate order" prompt or the rating already given.

---

### Get Order Details

```
GET /api/orders/:id
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Order",
  "data": {
    "order": {
      "_id": "664ord...",
      "status": "preparing",
      "items": [ ... ],
      "subtotal": 330,
      "deliveryFee": 35,
      "platformFee": 6,
      "tax": 17.5,
      "tip": 20,
      "discountAmount": 0,
      "grandTotal": 408.5,
      "deliveryInstructions": "Leave at the door",
      "cookingRequests": false,
      "extraCutlery": true,
      "vegFleetOptIn": true,
      "vegFleetAssignmentStatus": "assigned",
      "dedicatedBagRequired": true,
      "rating": { "value": 5, "comment": "Great food!", "createdAt": "2026-06-17T12:00:00.000Z" },
      "createdAt": "..."
    }
  }
}
```

Orders placed via `POST /api/orders/checkout` include the full bill breakdown
(`deliveryFee`/`platformFee`/`tax`/`tip`/`discountAmount`/`grandTotal`) and the
veg-fleet/fulfillment fields shown above; orders placed via the raw-items `POST
/api/orders` only ever populate `subtotal` (the other bill fields stay at their `0`/`null`
defaults, since that endpoint has no cart or checkout step to derive them from). `rating`
is the same `Review` join described under [List My Orders](#customer--orders) above.

---

### Reorder

```
POST /api/orders/:id/reorder
```

**Body** — none. Seeds the customer's cart from a past order (screen 25/28's "Reorder"
button) rather than placing a new order directly — checkout still happens normally via
`GET /api/checkout/summary` + `POST /api/orders/checkout`. `400 VALIDATION_ERROR` if the
order isn't `type: "delivery"`.

Each original item is re-validated against the **current** menu before being added:

- If it's no longer available (or the restaurant deleted an option group it depended on,
  making its stored customization invalid), it's dropped and reported in `removedItems`.
- If the customer's **current** `preferences.vegModeEnabled` is on and the item isn't
  veg, it's swapped for its linked veg substitute (`MenuItem.vegVariantId`, Prompt 5) if
  one exists — with its original customization reset, since the substitute's option
  groups are a different item's and essentially never compatible with the original
  selections. If no substitute exists, the item is dropped instead of being added
  non-veg, and reported in `removedItems`.
- Otherwise the item is re-added with its original quantity and customization
  (`selectedOptions`), snapshotted from the original order — orders placed before this
  field existed reorder without their customization (added plain, base price).

This reuses the same `POST /api/cart/items` logic per item, so it inherits that
endpoint's existing behavior exactly — including `409 CART_RESTAURANT_CONFLICT` if the
customer already has an unrelated cart going (this does **not** silently discard it for
them; the client shows the same "Discard cart from X?" dialog it already has for that case).

**Response `200`**

```json
{
  "status": "success",
  "message": "Items added to cart",
  "data": {
    "cart": { "...": "same shape as GET /api/cart" },
    "bill": { "...": "same shape as GET /api/cart" },
    "removedItems": [
      { "menuItemId": "664item...", "name": "Mutton Curry", "reason": "no_veg_substitute" }
    ]
  }
}
```

`removedItems[].reason` is one of `unavailable`, `no_veg_substitute`, or
`invalid_customization` — enough for the client to render "2 items removed" messaging
with a reasonable explanation for each.

---

## Customer — Order Tracking

### Get Order Tracking

```
GET /api/orders/:id/tracking
```

Requires `Authorization: Bearer <accessToken>` with role `customer`, scoped to the
caller's own order. Everything screen 24's tracking bottom sheet needs in one call.
`400 VALIDATION_ERROR` if the order isn't `type: "delivery"` (dine-in/takeaway orders
aren't tracked this way).

**Response `200`**

```json
{
  "status": "success",
  "message": "Order tracking",
  "data": {
    "status": "out_for_delivery",
    "etaMinutes": 12,
    "timeline": [
      { "stage": "placed", "timestamp": "2026-06-17T20:15:00.000Z", "completed": true },
      { "stage": "confirmed", "timestamp": null, "completed": true },
      { "stage": "preparing", "timestamp": null, "completed": true },
      { "stage": "ready", "timestamp": null, "completed": true },
      { "stage": "out_for_delivery", "timestamp": "2026-06-17T20:35:00.000Z", "completed": true },
      { "stage": "delivered", "timestamp": null, "completed": false }
    ],
    "restaurant": { "name": "Biryani Palace", "rating": 4.8 },
    "deliveryPartner": {
      "name": "Rahul S.",
      "avatarUrl": "https://res.cloudinary.com/...",
      "rating": 4.9,
      "totalDeliveries": 2400,
      "usesVegOnlyFleetBag": true
    },
    "orderItems": [
      { "menuItemId": "664item...", "name": "Awadhi Dum Biryani", "price": 299, "quantity": 1 }
    ],
    "totalPaid": 1384
  }
}
```

**Field notes:**

- `status` is the order's own `Order.status` (one of `placed`/`confirmed`/`preparing`/
  `ready`/`out_for_delivery`/`delivered`/`cancelled`) — the client maps this to whichever
  banner/pill copy it wants ("On the way", etc.).
- `timeline` — `Order.status` is a single mutable field with **no per-stage history**
  recorded anywhere in this codebase, so `timestamp` is only ever populated where a real
  one actually exists: `placed` (`createdAt`), `delivered` (`deliveredAt`), whichever
  stage is the order's *current* status (`updatedAt` — accurate only for that one
  transition, since it's the last write), and `out_for_delivery` additionally prefers
  `deliveryAssignment.pickupOtpVerifiedAt` when set (a more precise, independently-real
  "partner actually picked up" signal). Every other already-completed stage gets
  `timestamp: null` rather than a fabricated guess — `completed: true` still tells the
  client it happened, just not precisely when.
- `etaMinutes` — a straight-line-distance/average-speed estimate (`services/geo.service.js`'s
  `haversineKm`/`estimateEtaMinutes`), **not** a real routing/traffic-aware ETA. Only
  computed while the delivery partner is actively en route to the customer
  (`deliveryAssignment.status: "picked_up"`) **and** their last location ping is still
  fresh (< 120s old) — `null` at every other stage, or if the partner's position isn't
  currently trustworthy, rather than showing a stale/guessed number.
- `deliveryPartner` — `null` until a partner has actually accepted the order.
  `usesVegOnlyFleetBag` is `Order.dedicatedBagRequired` (Prompt 10) — a fact about *this
  order's* fleet requirement, not derived from the partner's own `fleetType` (which is
  fixed per-partner and shown as context in the partner's own app instead).
- Call/Chat buttons shown on screen 24 are **not** covered by this endpoint — no masked
  calling or in-app chat exists in this codebase yet (a deferred follow-up, not built here).

For live updates without polling this endpoint, join the existing `order:<id>` Socket.IO
room (see [WebSocket Events](#websocket-events)) — `order_status_updated` already covers
`status` changes, and the new `partner_location_updated` event below carries the
delivery partner's live position while they're en route.

---

## Customer — Reviews

Requires `Authorization: Bearer <accessToken>` with role `customer`.

### Create Review

```
POST /api/reviews/:orderId/review
```

**Body**

```json
{
  "rating": 5,
  "comment": "Absolutely loved the food!"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `rating` | number | Yes | 1–5 |
| `comment` | string | No | |

**Response `201`**

```json
{
  "status": "success",
  "message": "Review submitted",
  "data": {
    "review": {
      "_id": "664rev...",
      "restaurantId": "664abc...",
      "orderId": "664ord...",
      "userId": "664u...",
      "rating": 5,
      "comment": "Absolutely loved the food!",
      "createdAt": "2026-06-17T11:00:00.000Z"
    }
  }
}
```

Submitting a review automatically recalculates and updates the restaurant's `avgRating` and `totalRatings`.

---

## Customer — Support

Base path: `/api/support`. Requires `Authorization: Bearer <accessToken>` with role
`customer`. Reuses the existing `SupportTicket` model (previously only reachable via the
owner/admin ticket endpoints and the delivery-partner support flow) — `raisedByType:
'customer'` already existed in its enum with no route ever built to use it.

A support ticket is a **case**, not a live conversation with a specific delivery
partner — the "Chat with delivery partner" row on screen 26 is a different, deferred
feature (masked calling/in-app chat, not built in this codebase yet), not this thread.

### Create Ticket

```
POST /api/support/tickets
```

**Body**

```json
{
  "category": "wrong_missing_items",
  "description": "Received a Butter Naan instead of the Garlic Naan I ordered.",
  "orderId": "664ord..."
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `category` | `"order_delayed"` \| `"wrong_missing_items"` \| `"veg_fleet_issue"` \| `"payment_refund"` \| `"other"` | Yes | Matches screen 26's fixed category rows exactly |
| `description` | string | Yes | |
| `orderId` | string | No | If provided, must be one of the caller's own orders (`404 NOT_FOUND` otherwise) — carries context from "Need help with this order?" deep links (screen 24b) |

There's no free-text subject field in this flow — screen 26 only shows category rows, so
`SupportTicket.subject` (required by the schema, shared with the owner/admin/
delivery-partner ticket flows which do collect one) is filled in automatically from
`category` (e.g. `wrong_missing_items` → `"Wrong or missing items"`).

**Response `201`**

```json
{
  "status": "success",
  "message": "Support ticket submitted",
  "data": {
    "ticket": {
      "_id": "664tix...",
      "raisedByType": "customer",
      "raisedBy": "664u...",
      "orderId": "664ord...",
      "subject": "Wrong or missing items",
      "description": "Received a Butter Naan instead of the Garlic Naan I ordered.",
      "category": "wrong_missing_items",
      "status": "open",
      "messages": [],
      "createdAt": "2026-06-17T13:00:00.000Z"
    }
  }
}
```

---

### List My Tickets

```
GET /api/support/tickets
```

Only the caller's own tickets — filtered by `raisedBy`, unlike the admin-facing list
endpoint (which sees every raiser's tickets across the whole platform).

**Query parameters**

| Param | Type | Default |
|-------|------|---------|
| `page` | number | 1 |
| `limit` | number | 20 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Support tickets",
  "data": { "tickets": [ { ... } ], "total": 3, "page": 1, "pages": 1 }
}
```

---

### Get Ticket

```
GET /api/support/tickets/:id
```

**Response `200`** — `data: { ticket }`. `404 NOT_FOUND` if `:id` isn't one of the
caller's own tickets.

---

### Reply to Ticket

```
POST /api/support/tickets/:id/messages
```

**Body**

```json
{ "text": "Any update on this?" }
```

Appends to the same `messages` thread the admin-facing reply endpoint writes to (shared
logic, not a separate implementation) — the only difference is `senderType: "user"`
instead of `"admin"`. If the ticket's `status` was `"open"`, it flips to `"in_progress"`,
same as an admin reply does.

**Response `200`** — `data: { ticket }`. `404 NOT_FOUND` if `:id` isn't one of the
caller's own tickets.

---

## Owner — Restaurant Management

All owner routes require:
- `Authorization: Bearer <accessToken>` with role `restaurant_owner`
- Scoped routes: `:restaurantId` must belong to the authenticated owner

### List My Restaurants

```
GET /api/owner/restaurants
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Your restaurants",
  "data": { "restaurants": [ { ... } ] }
}
```

---

### Create Restaurant

```
POST /api/owner/restaurants
```

**Body**

```json
{
  "name": "Spice Garden",
  "description": "Authentic Indian cuisine",
  "cuisineTypes": ["Indian", "Mughlai"],
  "address": { "street": "12 Main Road", "city": "Delhi", "state": "Delhi", "pincode": "110001" },
  "location": { "coordinates": [77.2090, 28.6139] }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `name` | Yes | The only field actually validated as required server-side |
| `location.coordinates` | No | `[longitude, latitude]` — GeoJSON order. Silently defaults to `[0, 0]` if omitted or malformed — not validated as required despite appearances |
| others | No | |

**Response `201`**

---

Base path for all scoped routes: `/api/owner/:restaurantId`

### Get / Update Restaurant Profile

```
GET   /api/owner/:restaurantId/restaurant
PATCH /api/owner/:restaurantId/restaurant
```

`PATCH` body: any subset of `name`, `description`, `cuisineTypes`, `address`, `location`,
`isActive`, `isPureVeg`, `vegFleetAvailable`, `badges`.

| Field | Type | Notes |
|-------|------|-------|
| `isPureVeg` | boolean | Menu-composition flag — "every dish here is vegetarian". Surfaces as the "Pure veg restaurant" badge to customers. |
| `vegFleetAvailable` | boolean | Whether a veg-only delivery fleet is available for this restaurant. Manually set by the owner/admin for now — not yet computed from live partner coverage. Gates the checkout veg-fleet toggle. |
| `badges` | string[] | Free-form tags for restaurant cards (e.g. `"great_offers"`). Not yet consumed by any read endpoint. |

---

### Get / Update Settings (name, logo, banner)

```
GET   /api/owner/:restaurantId/settings
PATCH /api/owner/:restaurantId/settings
```

`PATCH` accepts `multipart/form-data`. Optional file fields: `logo` and `banner` (both max
5 MB, images only). Plain text fields `name`/`description` are accepted normally.
**`cuisineTypes`, `address`, and `settings` are NOT safely updatable in this multipart
request** — the controller reads them as-is with no JSON-parsing step, so nested
objects/arrays sent as multipart text fields will not round-trip correctly (a JSON-encoded
string for `settings` is saved as a literal string, not parsed back into an object, and its
sub-fields end up `undefined`). To update `cuisineTypes`/`address`/`settings`, omit the
file fields and send a plain `application/json` body instead.

---

### Get / Update Operating Hours

```
GET   /api/owner/:restaurantId/settings/hours
PATCH /api/owner/:restaurantId/settings/hours
```

**PATCH body**

```json
{
  "operatingHours": [
    { "day": "monday", "isOpen": true, "openTime": 900, "closeTime": 2200 }
  ]
}
```

`openTime`/`closeTime` are integers in HHMM format.

---

### Get / Update Delivery Config

```
GET   /api/owner/:restaurantId/settings/delivery
PATCH /api/owner/:restaurantId/settings/delivery
```

**PATCH body** — a **full replacement** of the `delivery` sub-document, not a partial
merge like the other settings endpoints on this page. Omitted fields are NOT preserved —
they reset to schema defaults (`radiusKm: 5`, `baseCharge: 0`) or become `undefined`
(`freeThreshold`, `estimatedMinutes` have no default). Always send all four fields.

```json
{
  "radiusKm": 10,
  "baseCharge": 30,
  "freeThreshold": 500,
  "estimatedMinutes": 45
}
```

---

## Owner — Staff Management

Base path: `/api/owner/:restaurantId/staff`

### List Staff

```
GET /api/owner/:restaurantId/staff
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Staff members",
  "data": {
    "staff": [
      { "_id": "664s...", "staffCode": "W01", "name": "Ravi Kumar", "role": "waiter", "email": "ravi@x.com", "isActive": true }
    ]
  }
}
```

`pinHash` is never returned.

---

### Create Staff Member

```
POST /api/owner/:restaurantId/staff
```

**Body**

```json
{
  "name": "Ravi Kumar",
  "role": "waiter",
  "pin": "1234",
  "email": "ravi@example.com"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | |
| `role` | `"waiter"` \| `"chef"` | Yes | `chef` = kitchen display; waiter routes check for `waiter`, kitchen routes check for `chef` |
| `pin` | string | Yes | 4–8 digits, stored as argon2id hash |
| `email` | string | No | |

**Response `201`**

---

### Update Staff Member

```
PATCH /api/owner/:restaurantId/staff/:staffId
```

**Body** — any of `name`, `email`, `isActive`, `pin`

---

### Deactivate Staff Member

```
DELETE /api/owner/:restaurantId/staff/:staffId
```

Soft delete — sets `isActive: false`.

**Response `200`** — `data: null`

---

## Owner — Categories & Subcategories

Base path: `/api/owner/:restaurantId/categories`

### List Categories

```
GET /api/owner/:restaurantId/categories
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Categories",
  "data": {
    "categories": [
      {
        "_id": "664cat...",
        "restaurantId": "664abc...",
        "name": "Starters",
        "displayOrder": 1,
        "isVisible": true
      }
    ]
  }
}
```

---

### Create Category

```
POST /api/owner/:restaurantId/categories
```

**Body**

```json
{
  "name": "Starters",
  "displayOrder": 1
}
```

**Response `201`**

```json
{
  "status": "success",
  "message": "Category created",
  "data": {
    "category": { ... }
  }
}
```

---

### Update Category

```
PATCH /api/owner/:restaurantId/categories/:cId
```

**Body**

```json
{
  "name": "Appetizers",
  "displayOrder": 2,
  "isVisible": false
}
```

**Response `200`**

---

### Delete Category

```
DELETE /api/owner/:restaurantId/categories/:cId
```

**Response `200`** — `data: null`

---

### List Subcategories

```
GET /api/owner/:restaurantId/categories/:cId/subcategories
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Sub-categories",
  "data": {
    "subCategories": [
      {
        "_id": "664sub...",
        "categoryId": "664cat...",
        "name": "Soups",
        "displayOrder": 1
      }
    ]
  }
}
```

---

### Create Subcategory

```
POST /api/owner/:restaurantId/categories/:cId/subcategories
```

**Body**

```json
{
  "name": "Soups",
  "displayOrder": 1
}
```

**Response `201`**

---

### Update Subcategory

```
PATCH /api/owner/:restaurantId/categories/:cId/subcategories/:sId
```

---

### Delete Subcategory

```
DELETE /api/owner/:restaurantId/categories/:cId/subcategories/:sId
```

---

## Owner — Menu Items

Base path: `/api/owner/:restaurantId/menu-items`

### List Menu Items

```
GET /api/owner/:restaurantId/menu-items
```

Returns all items (including unavailable) for management purposes.

**Response `200`**

```json
{
  "status": "success",
  "message": "Menu items",
  "data": {
    "items": [
      {
        "_id": "664item...",
        "restaurantId": "664abc...",
        "categoryId": "664cat...",
        "subCategoryId": "664sub...",
        "name": "Tomato Soup",
        "description": "Fresh tomatoes blended smooth",
        "foodType": "veg",
        "sellingPrice": 150,
        "discountedPrice": 120,
        "effectivePrice": 120,
        "prepTime": 10,
        "ingredients": [
          { "name": "tomato", "quantity": "500", "unit": "gm", "cost": 50 },
          { "name": "cream", "quantity": "100", "unit": "ml", "cost": 80 }
        ],
        "badges": ["bestseller"],
        "vegVariantId": null,
        "image": "https://...",
        "isAvailable": true,
        "createdAt": "2026-06-01T10:00:00.000Z"
      }
    ]
  }
}
```

---

### Create Menu Item

```
POST /api/owner/:restaurantId/menu-items
```

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | |
| `description` | string | No | |
| `foodType` | `"veg"` \| `"non_veg"` \| `"egg"` | Yes | |
| `categoryId` | string | Yes | ObjectId |
| `subCategoryId` | string | No | ObjectId |
| `sellingPrice` | number | Yes | MRP |
| `discountedPrice` | number | No | Offer price; `effectivePrice` uses this if set |
| `prepTime` | number | No | Minutes |
| `ingredients` | JSON array string | No | e.g. `'[{"name":"tomato","quantity":"500","unit":"gm","cost":50}]'` — see Ingredient Object Fields below |
| `badges` | JSON array string | No | e.g. `'["bestseller","highly_reordered"]'` — array of strings |
| `vegVariantId` | string | No | ObjectId of this item's veg substitute (e.g. a "Hyderabadi Biryani" item pointing at a "Veg Hyderabadi Biryani" item). Only meaningful on a `non_veg` item; not auto-generated — set only when a real veg alternative exists. |
| `image` | file | No | Max 5 MB |

**Response `201`**

```json
{
  "status": "success",
  "message": "Menu item created",
  "data": {
    "item": { ... }
  }
}
```

**Ingredient Object Format**

When sending ingredients (for both create and update), use this structure:

```json
{
  "name": "string (required)",
  "quantity": "string (optional, e.g., '100', '500')",
  "unit": "string (optional, e.g., 'gm', 'ml', 'piece')",
  "cost": "number (optional, cost in rupees)"
}
```

**Example - Multiple Ingredients:**
```json
"ingredients": '[
  { "name": "Basmati Rice", "quantity": "100", "unit": "gm", "cost": 100 },
  { "name": "Chicken", "quantity": "300", "unit": "gm", "cost": 400 },
  { "name": "Ghee", "quantity": "50", "unit": "ml", "cost": 150 }
]'
```

---

### Get Menu Item

```
GET /api/owner/:restaurantId/menu-items/:itemId
```

**Response `200`**

---

### Update Menu Item

```
PATCH /api/owner/:restaurantId/menu-items/:itemId
```

**Content-Type:** `multipart/form-data` (same fields as create — all optional)

If a new `image` is uploaded, the old Cloudinary image is deleted automatically after the DB write succeeds.

**Response `200`**

---

### Delete Menu Item (soft)

```
DELETE /api/owner/:restaurantId/menu-items/:itemId
```

Sets `isAvailable: false`. Does not hard-delete to preserve order history.

**Response `200`** — `data: null`

---

### Toggle Availability

```
PATCH /api/owner/:restaurantId/menu-items/:itemId/toggle
```

**Body** — none

**Response `200`**

```json
{
  "status": "success",
  "message": "Availability toggled",
  "data": {
    "isAvailable": false
  }
}
```

---

### Update Ingredients

```
PATCH /api/owner/:restaurantId/menu-items/:itemId/ingredients
```

**Body**

```json
{
  "ingredients": [
    { "name": "tomato", "quantity": "500", "unit": "gm", "cost": 50 },
    { "name": "basil", "quantity": "50", "unit": "gm", "cost": 100 },
    { "name": "mozzarella", "quantity": "200", "unit": "gm", "cost": 300 }
  ]
}
```

**Ingredient Object Fields:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Ingredient name (e.g., "tomato", "basil") |
| `quantity` | string | No | Amount (e.g., "500") |
| `unit` | string | No | Measurement unit (e.g., "gm", "ml", "piece") |
| `cost` | number | No | Cost per unit in rupees |

**Response `200`**

```json
{
  "status": "success",
  "message": "Ingredients updated",
  "data": {
    "item": {
      "_id": "664item...",
      "name": "Tomato Basil Pizza",
      "ingredients": [
        { "name": "tomato", "quantity": "500", "unit": "gm", "cost": 50 },
        { "name": "basil", "quantity": "50", "unit": "gm", "cost": 100 },
        { "name": "mozzarella", "quantity": "200", "unit": "gm", "cost": 300 }
      ]
    }
  }
}
```

---

### Option Groups

Base path: `/api/owner/:restaurantId/menu-items/:itemId/option-groups`

One unified model covers both customization patterns customers see: a required
single-select group (`type: "single_choice"`, e.g. "Choice of seasonal veg") and a
multi-select add-ons group where each add-on carries its own quantity
(`type: "addons"`, e.g. "Extra butter dollop, +₹30 ×2").

#### List Option Groups

```
GET /api/owner/:restaurantId/menu-items/:itemId/option-groups
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Option groups",
  "data": {
    "optionGroups": [
      {
        "_id": "664og1...",
        "menuItemId": "664item...",
        "title": "Choice of seasonal veg",
        "type": "single_choice",
        "required": true,
        "minSelect": 0,
        "maxSelect": null,
        "sortOrder": 0,
        "options": [
          { "_id": "664opt1...", "name": "Bhindi Masala", "priceDeltaMinor": 0, "maxQty": 1, "isDefaultSelected": true }
        ]
      }
    ]
  }
}
```

---

#### Create Option Group

```
POST /api/owner/:restaurantId/menu-items/:itemId/option-groups
```

**Body**

```json
{
  "title": "Add-ons",
  "type": "addons",
  "required": false,
  "minSelect": 0,
  "maxSelect": null,
  "sortOrder": 1,
  "options": [
    { "name": "Extra butter dollop", "priceDeltaMinor": 30, "maxQty": 3 }
  ]
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `title` | string | Yes | |
| `type` | `"single_choice"` \| `"addons"` | Yes | Determines which selection rules apply at checkout |
| `required` | boolean | No | Default `false`. For `single_choice`, `true` means exactly one selection is mandatory |
| `minSelect` / `maxSelect` | number | No | Only meaningful for `"addons"`. `maxSelect: null` = unlimited distinct add-ons |
| `sortOrder` | number | No | Default `0` |
| `options[].priceDeltaMinor` | number | No | Default `0`. Can be `0` (a free choice within a required group) |
| `options[].maxQty` | number | No | Default `1`. `>1` only meaningful for `"addons"` — lets one add-on be added multiple times |
| `options[].isDefaultSelected` | boolean | No | Pre-selects this option client-side; not enforced server-side |

**Response `201`**

```json
{
  "status": "success",
  "message": "Option group created",
  "data": { "optionGroup": { ... } }
}
```

---

#### Update Option Group

```
PATCH /api/owner/:restaurantId/menu-items/:itemId/option-groups/:groupId
```

**Body** — same shape as create. **Replaces the entire `options` array** if provided —
send the complete list, not a diff.

**Response `200`**

```json
{
  "status": "success",
  "message": "Option group updated",
  "data": { "optionGroup": { ... } }
}
```

---

#### Delete Option Group

```
DELETE /api/owner/:restaurantId/menu-items/:itemId/option-groups/:groupId
```

**Response `200`** — `data: null`

---

## Owner — Tables & QR

Base path: `/api/owner/:restaurantId/tables`

### List Tables

```
GET /api/owner/:restaurantId/tables
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Tables",
  "data": {
    "tables": [
      {
        "_id": "664tbl...",
        "identifier": "T1",
        "capacity": 4,
        "isActive": true,
        "qrCode": {
          "url": "https://yourdomain.com/menu?restaurantId=664abc...&tableId=664tbl...",
          "imageUrl": "data:image/png;base64,...",
          "status": "active"
        }
      }
    ]
  }
}
```

---

### Create Table

```
POST /api/owner/:restaurantId/tables
```

**Body**

```json
{
  "identifier": "T1",
  "capacity": 4
}
```

**Response `201`**

---

### Update Table

```
PATCH /api/owner/:restaurantId/tables/:tableId
```

**Body**

```json
{
  "capacity": 6,
  "isActive": true
}
```

**Response `200`**

---

### Delete Table

```
DELETE /api/owner/:restaurantId/tables/:tableId
```

**Response `200`** — `data: null`

---

### Generate QR Code

```
POST /api/owner/:restaurantId/tables/:tableId/qr
```

Generates a QR code for the table. The QR URL encodes the `tableId` so the waiter can scan and identify the table exactly.

**Body** — none

**Response `200`**

```json
{
  "status": "success",
  "message": "QR generated",
  "data": {
    "qr": {
      "url": "https://yourdomain.com/menu?restaurantId=664abc...&tableId=664tbl...",
      "imageUrl": "https://res.cloudinary.com/... (or base64 data URL if Cloudinary not configured)",
      "tableNumber": "T1",
      "qrDataUrl": "data:image/png;base64,iVBORw0KGgo..."
    }
  }
}
```

---

### Void QR Code

```
PATCH /api/owner/:restaurantId/tables/:tableId/qr/void
```

Invalidates the current QR token. Any waiter scan with the old token will fail.

**Body** — none

**Response `200`**

```json
{
  "status": "success",
  "message": "QR voided",
  "data": { "table": { "_id": "664tbl...", "identifier": "T3", "qrCode": { "status": "void" } } }
}
```

Returns the updated table object (not `null`) — check `table.qrCode.status` to confirm.

---

## Owner — Orders (view only)

Base path: `/api/owner/:restaurantId/orders`

### List Orders

```
GET /api/owner/:restaurantId/orders
```

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `status` | string | (all) | Filter by status |
| `type` | `"dine_in"` \| `"delivery"` \| `"takeaway"` | (all) | |
| `page` | number | 1 | |
| `limit` | number | 20 | |

**Response `200`**

```json
{
  "status": "success",
  "message": "Orders",
  "data": {
    "orders": [ { ... } ],
    "total": 200,
    "page": 1,
    "pages": 10
  }
}
```

---

### Get Order

```
GET /api/owner/:restaurantId/orders/:orderId
```

**Response `200`**

---

## Owner — Bills

Base path: `/api/owner/:restaurantId/bills`

### List Bills

```
GET /api/owner/:restaurantId/bills
```

**Query parameters**

| Param | Type | Notes |
|-------|------|-------|
| `status` | `"open"` \| `"paid"` \| `"cancelled"` | Filter |
| `page` | number | |
| `limit` | number | |

**Response `200`**

```json
{
  "status": "success",
  "message": "Bills",
  "data": {
    "bills": [
      {
        "_id": "664bill...",
        "tableSessionId": "664sess...",
        "restaurantId": "664abc...",
        "subtotal": 750,
        "gstPercent": 5,
        "gstAmount": 37.5,
        "serviceChargePercent": 10,
        "serviceChargeAmount": 75,
        "discountsApplied": [
          { "discountId": "664disc...", "code": "WEEKEND15", "description": "Weekend Special", "amount": 50 }
        ],
        "grandTotal": 812.5,
        "status": "paid",
        "paidBy": "upi",
        "paidAt": "2026-06-17T13:00:00.000Z"
      }
    ]
  }
}
```

Real field names differ from earlier revisions of this doc: `gstPercent`/`gstAmount` (not
`taxAmount`), `serviceChargePercent`/`serviceChargeAmount` (not documented before at all),
`discountsApplied` (an array of applied discounts, not a single `discountAmount` number),
and `paidBy` (not `paymentMethod`).

---

### Get Bill

```
GET /api/owner/:restaurantId/bills/:billId
```

**Response `200`**

---

## Owner — Discounts

Base path: `/api/owner/:restaurantId/discounts`

Discounts start in `draft` status. They must be explicitly published to become `active`.

### List Discounts

```
GET /api/owner/:restaurantId/discounts
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Discounts",
  "data": {
    "discounts": [
      {
        "_id": "664disc...",
        "offerName": "Weekend Special",
        "type": "percentage",
        "percentage": 15,
        "code": "WEEKEND15",
        "applicableTo": "both",
        "minimumOrderValue": 300,
        "startDate": "2026-06-20T00:00:00.000Z",
        "endDate": "2026-06-22T23:59:59.000Z",
        "status": "active"
      }
    ]
  }
}
```

---

### Create Discount

```
POST /api/owner/:restaurantId/discounts
```

**Common fields (all types)**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `type` | see below | Yes | Discriminated union |
| `offerName` | string | Yes | |
| `code` | string | No | Coupon code (unique per restaurant) |
| `applicableTo` | `"dine_in"` \| `"delivery"` \| `"both"` | No | Default `"both"` |
| `minimumOrderValue` | number | No | Default 0 |
| `startDate` | ISO date string | Yes | |
| `endDate` | ISO date string | Yes | Must be after `startDate` |
| `applicableTableNumbers` | string[] | No | |
| `applicableCategories` | ObjectId[] | No | |
| `applicableSubCategories` | ObjectId[] | No | |
| `applicableItems` | ObjectId[] | No | |
| `isFeatured` | boolean | No | Default `false`. Eligible to surface as the customer Home feed's banner (see [Customer — Home](#customer--home)) while `status: "active"` and within its date range — still a normal per-restaurant discount otherwise |

**Type-specific fields**

*`"percentage"`*
```json
{
  "type": "percentage",
  "offerName": "Weekend 15% Off",
  "percentage": 15,
  "startDate": "2026-06-20T00:00:00.000Z",
  "endDate": "2026-06-22T23:59:59.000Z"
}
```

| Extra field | Type | Required |
|-------------|------|----------|
| `percentage` | number 1–100 | Yes |

*`"flat_amount"`*
```json
{
  "type": "flat_amount",
  "offerName": "₹50 Off",
  "flatAmount": 50,
  "minimumOrderValue": 300,
  "startDate": "2026-06-20T00:00:00.000Z",
  "endDate": "2026-06-30T23:59:59.000Z"
}
```

| Extra field | Type | Required |
|-------------|------|----------|
| `flatAmount` | positive number | Yes |

*`"free_item"`*
```json
{
  "type": "free_item",
  "offerName": "Free Dessert",
  "freeItemId": "664item...",
  "freeItemName": "Gulab Jamun",
  "startDate": "2026-06-17T00:00:00.000Z",
  "endDate": "2026-06-30T23:59:59.000Z"
}
```

| Extra field | Type | Required |
|-------------|------|----------|
| `freeItemId` | ObjectId string | Yes |
| `freeItemName` | string | No |

*`"tablewise"`*
```json
{
  "type": "tablewise",
  "offerName": "Table 5 Loyalty Discount",
  "flatAmount": 100,
  "applicableTableNumbers": ["T5"],
  "startDate": "2026-06-17T00:00:00.000Z",
  "endDate": "2026-06-30T23:59:59.000Z"
}
```

| Extra field | Type | Required |
|-------------|------|----------|
| `flatAmount` | positive number | Yes |
| `applicableTableNumbers` | string[] min 1 | Yes |

**Response `201`**

```json
{
  "status": "success",
  "message": "Discount created",
  "data": {
    "discount": { ... }
  }
}
```

New discounts are created in `draft` status.

---

### Update Discount

```
PATCH /api/owner/:restaurantId/discounts/:dId
```

Same body as create. Full replacement of all fields.

**Response `200`**

---

### Delete Discount

```
DELETE /api/owner/:restaurantId/discounts/:dId
```

**Response `200`** — `data: null`

---

### Publish Discount

```
PATCH /api/owner/:restaurantId/discounts/:dId/publish
```

Transitions status: `draft` → `active`. Fails if discount is already active.

**Body** — none

**Response `200`**

```json
{
  "status": "success",
  "message": "Discount published",
  "data": {
    "discount": { "status": "active", ... }
  }
}
```

---

### Revert to Draft

```
PATCH /api/owner/:restaurantId/discounts/:dId/draft
```

Transitions status: `active` → `draft`. Fails if already draft.

**Body** — none

**Response `200`**

---

## Owner — Loyalty Program

Base path: `/api/owner/:restaurantId/loyalty`

### Get Loyalty Program

```
GET /api/owner/:restaurantId/loyalty
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Loyalty program",
  "data": {
    "program": {
      "_id": "664loy...",
      "restaurantId": "664abc...",
      "name": null,
      "isActive": true,
      "pointsPerRupee": 1
    }
  }
}
```

`redemptionRate` and `minimumRedemption` **do not exist** on this model — there is no
points-redemption mechanism implemented yet (`pointsPerRupee` is the only real earn-rate
field). `name` is a real, optional field previously undocumented here.

---

### Update Loyalty Program

```
PATCH /api/owner/:restaurantId/loyalty
```

Upserts — safe to call even if no program exists yet.

**Body**

```json
{
  "name": "Spice Garden Rewards",
  "isActive": true,
  "pointsPerRupee": 2
}
```

Only `name`, `isActive`, and `pointsPerRupee` are read from the body — `redemptionRate`/
`minimumRedemption` are not accepted (see note above).

**Response `200`**

---

### List Milestones

```
GET /api/owner/:restaurantId/loyalty/milestones
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Milestones",
  "data": {
    "milestones": [
      {
        "_id": "664mil...",
        "programId": "664loy...",
        "offerName": "Bronze Member Deal",
        "rewardType": "percentage",
        "rewardValue": 5,
        "minimumOrderValue": 300,
        "description": "5% off for loyal customers"
      }
    ]
  }
}
```

---

### Create Milestone

```
POST /api/owner/:restaurantId/loyalty/milestones
```

**Body**

```json
{
  "offerName": "Silver Member Deal",
  "rewardType": "percentage",
  "rewardValue": 10,
  "minimumOrderValue": 500,
  "description": "10% off on every visit"
}
```

| Field | Type | Notes |
|-------|------|-------|
| `offerName` | string | Display name of the milestone offer |
| `rewardType` | `"free_item"` \| `"flat_amount"` \| `"percentage"` \| `"tablewise"` | |
| `rewardValue` | number | Amount/percent depending on type |
| `freeItemId` | ObjectId | Not currently enforced server-side even when `rewardType` is `"free_item"` — the model doesn't mark it required, so omitting it silently creates a milestone with no linked item |
| `minimumOrderValue` | number | Minimum order total to unlock reward |
| `startDate` / `endDate` | ISO date | Optional validity window |
| `description` | string | |

**Response `201`**

---

### Update Milestone

```
PATCH /api/owner/:restaurantId/loyalty/milestones/:mId
```

---

### Delete Milestone

```
DELETE /api/owner/:restaurantId/loyalty/milestones/:mId
```

---

## Owner — Dashboard

Base path: `/api/owner/:restaurantId/dashboard`

All responses are aggregations over the restaurant's data. Use query param `period` to control the date window.

| `period` value | Meaning |
|---------------|---------|
| `today` | Calendar day |
| `week` | Last 7 days |
| `month` | Last 30 days |
| `year` | Last 365 days |

---

### KPIs

```
GET /api/owner/:restaurantId/dashboard
```

`period` is **not supported** by this endpoint despite appearances — it's always computed
for the current calendar day (midnight to now), and any query string is ignored.

**Response `200`**

```json
{
  "status": "success",
  "message": "Dashboard KPIs",
  "data": {
    "totalOrders": 87,
    "revenue": 12450.00,
    "liveCount": 23,
    "avgRating": 4.3,
    "totalRatings": 210
  }
}
```

Real fields are `totalOrders`, `revenue`, `liveCount` (active visitor count), `avgRating`,
`totalRatings` — `avgOrderValue`, `dineIn`, `delivery`, `cancelledOrders`, `newCustomers`,
and `period` do not exist in this response.

---

### Sales Chart

```
GET /api/owner/:restaurantId/dashboard/sales?period=week
```

`period` maps to a lookback window: `today`/`day` → 1 day, `week` → 7, `month` → 30,
`year` → 365; an unrecognized value defaults to 7 days.

**Response `200`**

```json
{
  "status": "success",
  "message": "Sales chart",
  "data": {
    "chart": [
      { "_id": "2026-06-11", "revenue": 1200, "orders": 10 },
      { "_id": "2026-06-12", "revenue": 980, "orders": 8 }
    ]
  }
}
```

The response is `{ chart: [...] }` — an **array of per-day objects** sorted by `_id`
(the date string) ascending, not the parallel `labels`/`revenue`/`orders` arrays shown in
earlier revisions of this doc. There are no day-name labels.

---

### Top Items

```
GET /api/owner/:restaurantId/dashboard/top-items?limit=10
```

All-time top items by quantity sold (paid orders only) — `period` is **not supported**
here; the real control is `limit` (default 5, capped at 20).

**Response `200`**

```json
{
  "status": "success",
  "message": "Top items",
  "data": {
    "items": [
      { "_id": "664item...", "name": "Butter Chicken", "totalQty": 234, "totalRevenue": 46800 }
    ]
  }
}
```

Real field names are `_id` (not `menuItemId`) and `totalQty` (not `totalQuantity`).

---

### Recent Orders

```
GET /api/owner/:restaurantId/dashboard/recent-orders?limit=20
```

Returns the most recent orders, sorted newest-first. `limit` defaults to 10, capped at 50
(previously undocumented).

**Response `200`**

```json
{
  "status": "success",
  "message": "Recent orders",
  "data": {
    "orders": [
      {
        "_id": "664ord...",
        "type": "dine_in",
        "status": "delivered",
        "subtotal": 650,
        "createdAt": "2026-06-17T12:30:00.000Z"
      }
    ]
  }
}
```

---

## Owner — Live Monitor

Base path: `/api/owner/:restaurantId/live-monitor`

Real-time visitor and operational stats backed by Redis.

### Get Stats

```
GET /api/owner/:restaurantId/live-monitor
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Live stats",
  "data": {
    "restaurantId": "664abc...",
    "activeVisitors": 23,
    "openSessions": 7,
    "pendingOrders": 12,
    "gmv": 18450.50
  }
}
```

The revenue field is `gmv`, not `todayGMV`; there's also an extra `restaurantId` field.
This is the same payload broadcast via the `live_visitor_update` Socket.IO event every
30 seconds — see [WebSocket Events](#live_visitor_update).

---

### Get Active Visitors

```
GET /api/owner/:restaurantId/live-monitor/visitors
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Active visitors",
  "data": {
    "count": 1,
    "visitors": [
      {
        "sessionId": "abc123",
        "userId": "664u...",
        "user": { "name": "Rahul K", "email": "rahul@x.com", "phone": "9876543210" },
        "cartItems": [],
        "intentScore": 0,
        "updatedAt": 1718617800000
      }
    ]
  }
}
```

The response shape differs from earlier revisions of this doc: there's a top-level
`count`, `name` is nested under `user` (not a flat `visitor.name`), there is no `tableId`
field, and the timestamp field is `updatedAt` (a raw epoch-ms number set via
`redis.hset`), not `lastSeen`. Visitors expire from Redis after 5 minutes of inactivity.

---

### Get Repeat Visitors

```
GET /api/owner/:restaurantId/live-monitor/repeat
```

Customers who have placed more than one order at this restaurant.

**Response `200`**

```json
{
  "status": "success",
  "message": "Repeat visitors",
  "data": {
    "visitors": [
      {
        "user": { "name": "Priya S", "email": "priya@example.com", "phone": "9876543210" },
        "orderCount": 8,
        "lastOrder": "2026-06-15T19:20:00.000Z"
      }
    ]
  }
}
```

`user` is a nested object (`name`/`email`/`phone`) rather than flat fields on the visitor,
there is no top-level `_id`, and `lastOrder` (previously undocumented) is included.

---

### Create Targeted Offer

```
POST /api/owner/:restaurantId/live-monitor/offer
```

Creates a discount and broadcasts it in real time to all active visitors via Socket.IO.
Field shape is the same as [Create Discount](#create-discount), but **validation is not
shared** — this endpoint skips the Zod discriminated-union check entirely, so type-specific
required fields (e.g. `percentage` for `type: "percentage"`) are not enforced, and an
offer created with no `startDate`/`endDate` is active forever (the expiry check silently
no-ops against `undefined` dates). Unlike normal discounts, targeted offers are created
directly with `status: "active"` — they skip the `draft` state.

**Body**

```json
{
  "offerName": "Flash 10% Off — Next 30 mins",
  "type": "percentage",
  "percentage": 10,
  "startDate": "2026-06-17T14:00:00.000Z",
  "endDate": "2026-06-17T14:30:00.000Z"
}
```

**Response `201`**

```json
{
  "status": "success",
  "message": "Targeted offer created and broadcast",
  "data": {
    "discount": { ... }
  }
}
```

The offer is emitted as a `targeted_offer` Socket.IO event to the `restaurant:<restaurantId>` room.

---

## Admin

All admin routes require `Authorization: Bearer <accessToken>` with role `admin`, and live under `/api/admin`. Any other role gets `403 FORBIDDEN`. Most state-changing actions are recorded in an internal activity log (`adminId`, `action`, `targetType`, `targetId`, `metadata`) — not exposed via its own endpoint yet. Not logged: store profile update (`PATCH /stores/:id`), document verification on either stores or delivery partners, delivery-partner profile update (`PATCH /delivery-partners/:id`), ticket update, and adding a ticket message — everything else that mutates state is logged.

Every list endpoint below (`stores`, `customers`, `delivery-partners`, `tickets`) shares the same pagination shape — `?page=&limit=` in, `{ ..., total, page, pages }` out — so a single `usePaginatedQuery` hook can drive all four admin tables.

### Quick Reference

| Method | Path | Body | Description |
|--------|------|------|--------------|
| `GET` | `/api/admin/dashboard` | — | [Platform KPI totals](#platform-overview) |
| `GET` | `/api/admin/dashboard/revenue-overview?range=` | — | [Revenue chart points](#revenue-overview) |
| `GET` | `/api/admin/dashboard/live-activity` | — | [Live activity counters](#live-activity) |
| `GET` | `/api/admin/dashboard/hourly-activity?days=` | — | [Hourly order activity](#hourly-activity) |
| `GET` | `/api/admin/finance/overview?from=&to=` | — | [Finance overview](#finance-overview) |
| `GET` | `/api/admin/finance/revenue-trend?months=` | — | [Monthly revenue trend](#revenue-trend) |
| `GET` | `/api/admin/finance/earnings-vs-spending?months=` | — | [Earnings vs. payout spending](#earnings-vs-spending) |
| `GET` | `/api/admin/finance/restaurants?page=&limit=&from=&to=` | — | [Per-restaurant revenue table](#restaurant-revenue-table) |
| `PATCH` | `/api/admin/orders/:id/delivery-partner` | `{ partnerId, reason? }` | [Reassign delivery partner](#reassign-delivery-partner) |
| `GET` | `/api/admin/reports/top-stores?limit=` | — | [Top stores by revenue](#top-stores) |
| `GET` | `/api/admin/reports/top-delivery-partners?limit=` | — | [Top delivery partners by deliveries](#top-delivery-partners) |
| `GET` | `/api/admin/stores?status=&plan=&search=&page=&limit=` | — | [List stores + tab counts](#list-stores) |
| `POST` | `/api/admin/stores` | see [Create Store](#create-store) | [Admin-onboard a store directly (pre-approved)](#create-store) |
| `GET` | `/api/admin/stores/:id` | — | [Get one store](#get-store) |
| `PATCH` | `/api/admin/stores/:id/approve` | none | [Approve → `active`](#approve-store) |
| `PATCH` | `/api/admin/stores/:id/reject` | `{ reason }` | [Reject → `rejected`](#reject-store) |
| `PATCH` | `/api/admin/stores/:id/suspend` | none | [Suspend → `suspended` (from `active` only)](#suspend-store) |
| `PATCH` | `/api/admin/stores/:id/reactivate` | none | [Reactivate → `active` (from `suspended` only)](#reactivate-store) |
| `PATCH` | `/api/admin/stores/:id` | whitelisted fields | [Update store profile](#update-store) |
| `POST` | `/api/admin/stores/:id/notes` | `{ note }` | [Add internal note](#add-admin-note) |
| `PATCH` | `/api/admin/stores/:id/documents/:docId` | `{ status }` | [Verify/reject a document](#verify-document) |
| `DELETE` | `/api/admin/stores/:id` | — | [Soft-remove store](#remove-store) |
| `GET` | `/api/admin/customers?search=&status=&page=&limit=` | — | [List customers](#list-customers) |
| `GET` | `/api/admin/customers/:id` | — | [Get one customer](#get-customer) |
| `PATCH` | `/api/admin/customers/:id/status` | `{ isActive }` | [Activate/deactivate customer](#set-customer-status) |
| `GET` | `/api/admin/delivery-partners?search=&status=&page=&limit=` | — | [List delivery partners](#list-delivery-partners) |
| `POST` | `/api/admin/delivery-partners` | `multipart/form-data` | [Onboard delivery partner + documents](#create-delivery-partner) |
| `GET` | `/api/admin/delivery-partners/:id` | — | [Get one delivery partner](#get-delivery-partner) |
| `PATCH` | `/api/admin/delivery-partners/:id` | whitelisted fields | [Update delivery partner](#update-delivery-partner) |
| `DELETE` | `/api/admin/delivery-partners/:id` | — | [Hard-remove delivery partner](#remove-delivery-partner) |
| `PATCH` | `/api/admin/delivery-partners/:id/verify` | `{ decision, notes? }` | [Verify/reject onboarding](#verify-delivery-partner) |
| `PATCH` | `/api/admin/delivery-partners/:id/documents/:docType/verify` | `{ status }` | [Verify a document](#verify-delivery-partner-document) |
| `GET` | `/api/admin/delivery-partners/:id/orders?status=&page=&limit=` | — | [List a partner's orders](#list-delivery-partner-orders) |
| `GET` | `/api/admin/delivery-partners/payouts/summary?period=` | — | [Payout summary](#payouts-summary) |
| `POST` | `/api/admin/delivery-partners/payouts/mark-paid` | `{ payoutIds }` | [Mark payouts paid](#mark-payouts-paid) |
| `GET` | `/api/admin/delivery-partners/:id/payouts?period=&page=&limit=` | — | [List a partner's payouts](#list-delivery-partner-payouts) |
| `PATCH` | `/api/admin/delivery-partners/:id/payouts/:payoutId` | `{ incentives?, deductions?, notes? }` | [Adjust a payout](#adjust-payout) |
| `GET` | `/api/admin/delivery-partners/fleet-change-requests?status=&page=&limit=` | — | [List fleet change requests](#list-fleet-change-requests) |
| `PATCH` | `/api/admin/delivery-partners/fleet-change-requests/:requestId` | `{ decision, notes? }` | [Resolve fleet change request](#resolve-fleet-change-request) |
| `GET` | `/api/admin/tickets?status=&priority=&category=&page=&limit=` | — | [List support tickets](#list-tickets) |
| `GET` | `/api/admin/tickets/:id` | — | [Get one ticket](#get-ticket) |
| `PATCH` | `/api/admin/tickets/:id` | `{ status?, priority?, assignedTo? }` | [Update ticket](#update-ticket) |
| `POST` | `/api/admin/tickets/:id/messages` | `{ text }` | [Reply to ticket](#add-message) |

---

### Admin — Stores

Base path: `/api/admin/stores`

#### List Stores

```
GET /api/admin/stores
```

**Query parameters**

| Param | Type | Notes |
|-------|------|-------|
| `status` | `"pending"` \| `"active"` \| `"suspended"` \| `"rejected"` \| `"expired"` | Filters by `approvalStatus` |
| `plan` | `"trial"` \| `"basic"` \| `"standard"` \| `"premium"` | |
| `search` | string | Case-insensitive match on `name` |
| `page` | number | Default 1 |
| `limit` | number | Default 20 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Stores",
  "data": {
    "stores": [ { "_id": "664abc...", "name": "Spice Garden", "approvalStatus": "pending", "plan": "trial", "revenue": 0, "ownerId": { "_id": "664u...", "name": "Amir", "email": "amir@x.com", "phone": "+91..." } } ],
    "total": 42,
    "page": 1,
    "pages": 3,
    "statusCounts": { "pending": 5, "active": 30, "suspended": 2, "rejected": 3, "expired": 2 }
  }
}
```

`statusCounts` powers the All / Pending / Active / Suspended / Expired / Rejected tab counts and is computed over the full collection, independent of `status`/`plan`/`search` filters. `revenue` (previously undocumented) is the sum of `grandTotal` across that store's paid `Bill`s, computed only for the stores on the current page, not the full collection.

---

#### Create Store

```
POST /api/admin/stores
```

Admin-onboards a store directly, bypassing the normal pending-approval queue — not
documented in earlier revisions of this doc despite being a real, implemented endpoint.

**Body**

```json
{
  "name": "Spice Garden",
  "category": "North Indian",
  "cuisineTypes": ["North Indian", "Chinese"],
  "address": { "street": "12 MG Road", "city": "Bengaluru", "state": "KA", "pincode": "560001" },
  "location": { "coordinates": [77.5946, 12.9716] },
  "plan": "trial",
  "owner": { "name": "Amir", "email": "amir@x.com", "phone": "+91..." }
}
```

| Field | Type | Required |
|-------|------|----------|
| `name` | string | Yes |
| `category`, `description`, `logo`, `bannerImage`, `coverImage` | string | No |
| `cuisineTypes` | string[] | No |
| `address` | `{ street?, city?, state?, pincode? }` | No |
| `location.coordinates` | `[lng, lat]` | No — defaults to `[0, 0]` |
| `delivery` | `{ radiusKm?, baseCharge?, freeThreshold?, estimatedMinutes? }` | No |
| `settings` | object | No |
| `plan` | `"trial"` \| `"basic"` \| `"standard"` \| `"premium"` | No |
| `owner.name` | string | Yes |
| `owner.email` | string (valid email) | Yes |
| `owner.phone` | string | No |

If no user exists with `owner.email`, a `restaurant_owner` account is created
automatically with a random temp password. If a user with that email exists under a
*different* role, returns `409 DUPLICATE_KEY`. The store is created already
`approvalStatus: 'active'` (admin-onboarded stores skip the pending queue), with
`reviewedAt`/`reviewedBy` set to the acting admin. Logs `STORE_CREATED`.

**Response `201`**

```json
{
  "status": "success",
  "message": "Store created",
  "data": { "store": { "...": "..." }, "ownerCreated": true, "tempPassword": "aZ3f..." }
}
```

`tempPassword` is `null` when `ownerCreated` is `false` (an existing `restaurant_owner`
account was reused instead of creating a new one).

---

#### Get Store

```
GET /api/admin/stores/:id
```

Populates `ownerId` with `name email phone`. `404 NOT_FOUND` if the store doesn't exist.

**Response `200`** — `data: { store }`

---

#### Approve Store

```
PATCH /api/admin/stores/:id/approve
```

**Body** — none

Sets `approvalStatus: 'active'`, `reviewedAt: now`, `reviewedBy: <adminId>`. Logs `STORE_APPROVED`.

**Response `200`** — `data: { store }`

---

#### Reject Store

```
PATCH /api/admin/stores/:id/reject
```

**Body**

```json
{ "reason": "Uploaded FSSAI license has expired" }
```

| Field | Type | Required |
|-------|------|----------|
| `reason` | string | Yes, min 1 char |

Sets `approvalStatus: 'rejected'`, `rejectionReason`, `reviewedAt`, `reviewedBy`. Logs `STORE_REJECTED` with `metadata: { reason }`.

**Response `200`** — `data: { store }`

---

#### Suspend Store

```
PATCH /api/admin/stores/:id/suspend
```

**Body** — none

Only allowed from `approvalStatus: 'active'` — otherwise `400 INVALID_STATE`. Logs `STORE_SUSPENDED`.

**Response `200`** — `data: { store }`

---

#### Reactivate Store

```
PATCH /api/admin/stores/:id/reactivate
```

**Body** — none

Only allowed from `approvalStatus: 'suspended'` — otherwise `400 INVALID_STATE`. Logs `STORE_REACTIVATED`.

**Response `200`** — `data: { store }`

---

#### Update Store

```
PATCH /api/admin/stores/:id
```

**Body** — any subset of a fixed whitelist; any other field is silently dropped

| Field | Notes |
|-------|-------|
| `name` | |
| `description` | |
| `category` | Previously undocumented but real and updatable |
| `cuisineTypes` | |
| `address` | |
| `delivery` | |
| `settings` | |
| `plan` | |

**Response `200`** — `data: { store }`

---

#### Add Admin Note

```
POST /api/admin/stores/:id/notes
```

**Body**

```json
{ "note": "Owner confirmed correct GST number over phone" }
```

Pushes `{ note, addedBy: <adminId>, addedAt: now }` onto `adminNotes`. Logs `STORE_NOTE_ADDED`.

**Response `200`** — `data: { store }`

---

#### Verify Document

```
PATCH /api/admin/stores/:id/documents/:docId
```

**Body**

```json
{ "status": "verified" }
```

| Field | Type | Notes |
|-------|------|-------|
| `status` | `"verified"` \| `"rejected"` | |

Updates the matching entry inside the store's `documents` array in place. `404 NOT_FOUND` if the store or the document id doesn't match.

**Response `200`** — `data: null`

---

#### Remove Store

```
DELETE /api/admin/stores/:id
```

Soft-delete only — sets `isActive: false`; `approvalStatus` is left unchanged. Order/bill history referencing this `restaurantId` is preserved. Logs `STORE_REMOVED`.

**Response `200`** — `data: { store }`

---

### Admin — Customers

Base path: `/api/admin/customers`

#### List Customers

```
GET /api/admin/customers
```

**Query parameters**

| Param | Type | Notes |
|-------|------|-------|
| `search` | string | Matches `name`, `email`, or `phone` |
| `status` | `"active"` \| `"inactive"` | Maps to `isActive` |
| `profileStatus` | `"complete"` \| `"incomplete"` | Previously undocumented. `"complete"` = has `phone` and ≥1 saved address; `"incomplete"` otherwise |
| `page` | number | Default 1 |
| `limit` | number | Default 20 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Customers",
  "data": {
    "customers": [ { "_id": "664u...", "name": "Priya S", "email": "priya@x.com", "phone": "+91...", "isActive": true, "location": "Bengaluru, KA", "profileStatus": "complete" } ],
    "total": 500,
    "page": 1,
    "pages": 25
  }
}
```

`passwordHash` is explicitly excluded via `.select('-passwordHash')` (results are `.lean()`, which bypasses the schema's `toJSON` stripping). `location` (derived from the customer's first saved address's `city, state`, or `null` if none) and `profileStatus` (previously undocumented) are computed and attached to every customer in the response.

---

#### Get Customer

```
GET /api/admin/customers/:id
```

`404 NOT_FOUND` if no customer (i.e. `role: 'customer'`) matches.

**Response `200`** — `data: { customer }`

---

#### Set Customer Status

```
PATCH /api/admin/customers/:id/status
```

**Body**

```json
{ "isActive": false }
```

Logs `CUSTOMER_ACTIVATED` or `CUSTOMER_DEACTIVATED` depending on the value.

**Response `200`** — `data: { customer }`

---

### Admin — Delivery Partners

Base path: `/api/admin/delivery-partners`

#### List Delivery Partners

```
GET /api/admin/delivery-partners
```

**Query parameters**

| Param | Type | Notes |
|-------|------|-------|
| `search` | string | Matches `fullName`, `email`, or `phone` |
| `status` | `"active"` \| `"busy"` \| `"inactive"` \| `"suspended"` | |
| `page` | number | Default 1 |
| `limit` | number | Default 20 |

**Response `200`** — `data: { partners, total, page, pages }`

---

#### Get Delivery Partner

```
GET /api/admin/delivery-partners/:id
```

**Response `200`** — `data: { partner }`

---

#### Create Delivery Partner

```
POST /api/admin/delivery-partners
```

**Content-Type:** `multipart/form-data`

| Field | Type | Notes |
|-------|------|-------|
| `fullName`, `email`, `phone` | string | |
| `dateOfBirth` | date string | |
| `gender` | `"male"` \| `"female"` \| `"other"` | |
| `emergencyPhone`, `aadharNumber`, `panNumber` | string | |
| `vehicleModel`, `vehicleNumber`, `vehicleRcNumber`, `insuranceProvider`, `insuranceNumber` | string | |
| `vehicleType` | `"2_wheeler"` \| `"ev_2_wheeler"` \| `"non_rto_2_wheeler"` | |
| `insuranceValidTill` | date string | |
| `bankName`, `accountHolderName`, `accountNumber`, `ifscCode`, `branchName`, `upiId` | string | |
| `accountType` | `"savings"` \| `"current"` | |
| `aadharCard` | file | Optional, max 5 MB, JPEG/PNG/WebP/PDF |
| `drivingLicense` | file | Optional, same limits |
| `vehicleRc` | file | Optional, same limits |
| `insuranceDocument` | file | Optional, same limits |
| `profilePhoto` | file | Optional, same limits |

Each uploaded file is stored in Cloudinary under `yulostores/delivery-partners/<timestamp>` (PDFs use `resource_type: 'auto'`, images use `'image'`) and recorded in the partner's `documents` array with the matching type (`aadhar_card`, `driving_license`, `vehicle_rc`, `insurance_document`, `profile_photo`). If any upload fails partway through, the files already uploaded for this request are deleted from Cloudinary and the request fails with `500 UPLOAD_FAILED`. Logs `DELIVERY_PARTNER_ADDED`.

`fullName`, `email`, and `phone` are the only fields checked server-side (`400
VALIDATION_ERROR` if any is missing) — there is no schema validation for the rest.
Enum fields (`gender`, `vehicleType`, `accountType`) that don't match the model's allowed
values, or an `email`/`phone` collision with an existing partner, fail at the
database-write step as a raw Mongoose validation error, not as a clean
`400 VALIDATION_ERROR` — any documents already uploaded for the request are still cleaned
up from Cloudinary the same as an upload failure, but the response won't be
`500 UPLOAD_FAILED` either.

**Response `201`** — `data: { partner }`

---

#### Update Delivery Partner

```
PATCH /api/admin/delivery-partners/:id
```

**Body** — any subset of a fixed whitelist

| Field |
|-------|
| `fullName`, `phone`, `dateOfBirth`, `gender`, `emergencyPhone`, `aadharNumber`, `panNumber`, `vehicle`, `bankDetails`, `status` |

**Response `200`** — `data: { partner }`

---

#### Remove Delivery Partner

```
DELETE /api/admin/delivery-partners/:id
```

Hard delete. `Order.deliveryAssignment.partnerId`, `Payout.partnerId`,
`CashDeposit.partnerId`, and `FleetChangeRequest.partnerId` all reference
`DeliveryPartner` by ObjectId with no cascade — deleting a partner with delivery/payout/
cash-deposit history leaves those references dangling (in particular, any of the
partner's unpaid `Payout.netPayable` silently drops out of the admin payout-summary
total). Logs `DELIVERY_PARTNER_REMOVED` before deleting.

**Response `200`** — `data: null`

---

#### Verify Delivery Partner

```
PATCH /api/admin/delivery-partners/:id/verify
```

Previously undocumented.

**Body**

```json
{ "decision": "approve", "notes": null }
```

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"approve"` \| `"reject"` \| `"request_resubmission"` | Yes |
| `notes` | string | Required unless `decision` is `"approve"` |

**Response `200`** — `data: { partner }`. Logs `DELIVERY_PARTNER_VERIFIED` /
`DELIVERY_PARTNER_REJECTED` / `DELIVERY_PARTNER_RESUBMISSION_REQUESTED`.

---

#### Verify Delivery Partner Document

```
PATCH /api/admin/delivery-partners/:id/documents/:docType/verify
```

Previously undocumented. Matched by document `type` (`:docType`), not a document `_id` —
unlike the equivalent store-document endpoint.

**Body**

```json
{ "status": "verified" }
```

| Field | Type | Required |
|-------|------|----------|
| `status` | `"verified"` \| `"rejected"` | Yes |

**Response `200`** — `data: { partner }`

---

#### List Delivery Partner Orders

```
GET /api/admin/delivery-partners/:id/orders?status=&page=&limit=
```

Previously undocumented. Standard pagination shape.

---

#### Payouts Summary

```
GET /api/admin/delivery-partners/payouts/summary?period=weekly
```

Previously undocumented.

**Response `200`** — `data: { totalPending, totalPaid, totalPayable, count }` (aggregated across all partners for the period).

---

#### Mark Payouts Paid

```
POST /api/admin/delivery-partners/payouts/mark-paid
```

Previously undocumented.

**Body**

```json
{ "payoutIds": ["664payout1...", "664payout2..."] }
```

| Field | Type | Required |
|-------|------|----------|
| `payoutIds` | string[] | Yes, min 1 |

Atomically updates all matching payouts still in `pending`/`processing` status to `paid`
in one `updateMany` — already-paid payouts are not double-processed. Logs
`PAYOUTS_MARKED_PAID`.

**Response `200`** — `data: { modifiedCount }`

---

#### List Delivery Partner Payouts

```
GET /api/admin/delivery-partners/:id/payouts?period=weekly&page=&limit=
```

Previously undocumented. Standard pagination shape.

---

#### Adjust Payout

```
PATCH /api/admin/delivery-partners/:id/payouts/:payoutId
```

Previously undocumented.

**Body** (all optional — send only what changed)

```json
{ "incentives": 100, "deductions": 0, "notes": "Diwali bonus" }
```

**Response `200`** — `data: { payout }`. Logs `PAYOUT_ADJUSTED`.

---

#### List Fleet Change Requests

```
GET /api/admin/delivery-partners/fleet-change-requests?status=&page=&limit=
```

Previously undocumented. Populates `partnerId` with `fullName phone fleetType`.

---

#### Resolve Fleet Change Request

```
PATCH /api/admin/delivery-partners/fleet-change-requests/:requestId
```

Previously undocumented.

**Body**

```json
{ "decision": "approve", "notes": null }
```

| Field | Type | Required |
|-------|------|----------|
| `decision` | `"approve"` \| `"reject"` | Yes |
| `notes` | string | No |

`400 INVALID_STATE` if the request isn't currently `pending`. Approval updates the
partner's `fleetType` to the requested value. Logs `FLEET_CHANGE_APPROVED` /
`FLEET_CHANGE_REJECTED`.

**Response `200`** — `data: { request }`

---

### Admin — Support Tickets

Base path: `/api/admin/tickets`

#### List Tickets

```
GET /api/admin/tickets
```

**Query parameters**

| Param | Type |
|-------|------|
| `status` | `"open"` \| `"in_progress"` \| `"resolved"` \| `"closed"` |
| `priority` | `"low"` \| `"medium"` \| `"high"` |
| `category` | `"billing"` \| `"technical"` \| `"account"` \| `"delivery"` \| `"other"` \| `"order_delayed"` \| `"wrong_missing_items"` \| `"veg_fleet_issue"` \| `"payment_refund"` |
| `page` / `limit` | number |

The last four `category` values are customer-app-specific (see [Customer —
Support](#customer--support)) — this endpoint sees tickets from every `raisedByType`
(owner/customer/delivery_partner), unlike the customer's own list endpoint, which is
filtered to their own tickets only.

Populates `assignedTo` with `name email`.

**Response `200`** — `data: { tickets, total, page, pages }`

---

#### Get Ticket

```
GET /api/admin/tickets/:id
```

**Response `200`** — `data: { ticket }`

---

#### Update Ticket

```
PATCH /api/admin/tickets/:id
```

**Body** — any subset

```json
{
  "status": "resolved",
  "priority": "high",
  "assignedTo": "664admin..."
}
```

| Field | Type | Notes |
|-------|------|-------|
| `status` | `"open"` \| `"in_progress"` \| `"resolved"` \| `"closed"` | No |
| `priority` | `"low"` \| `"medium"` \| `"high"` | No |
| `assignedTo` | ObjectId string | No |

When `status` is set to `"resolved"` or `"closed"`, `resolvedAt` is set automatically.

**Response `200`** — `data: { ticket }`

---

#### Add Message

```
POST /api/admin/tickets/:id/messages
```

**Body**

```json
{ "text": "We've forwarded this to billing, you'll hear back within 24h." }
```

Pushes `{ senderType: 'admin', sender: <adminId>, text, sentAt: now }` onto `messages`. If the ticket's `status` is `"open"`, it automatically flips to `"in_progress"`.

**Response `200`** — `data: { ticket }`

---

### Admin — Dashboard

Base path: `/api/admin/dashboard`

#### Platform Overview

```
GET /api/admin/dashboard
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Platform overview",
  "data": {
    "stores": { "pending": 5, "active": 30, "suspended": 2, "rejected": 3, "expired": 2 },
    "customers": 500,
    "tickets": { "open": 12, "in_progress": 4, "resolved": 40, "closed": 55 },
    "revenue": { "total": 184500.5, "orders": 620 }
  }
}
```

`revenue` is computed over all `Bill` documents with `status: 'paid'`.

---

#### Revenue Overview

```
GET /api/admin/dashboard/revenue-overview
```

**Query parameters**

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `range` | `"day"` \| `"week"` \| `"month"` \| `"year"` | `"month"` | Bucket granularity + lookback window |

| `range` | Bucketed by | Lookback |
|---------|-------------|----------|
| `day` | hour | last 24 hours |
| `week` | day | last 7 days |
| `month` | day | last 30 days |
| `year` | month | last 12 months |

**Response `200`**

```json
{
  "status": "success",
  "message": "Revenue overview",
  "data": {
    "range": "month",
    "points": [
      { "date": "2026-06-10T00:00:00.000Z", "revenue": 4200, "orders": 18 },
      { "date": "2026-06-11T00:00:00.000Z", "revenue": 3900, "orders": 15 }
    ]
  }
}
```

---

#### Live Activity

```
GET /api/admin/dashboard/live-activity
```

Previously undocumented.

**Response `200`**

```json
{
  "status": "success",
  "message": "Live activity",
  "data": { "openTableSessions": 14, "ordersInProgress": 22, "liveConnections": 37 }
}
```

---

#### Hourly Activity

```
GET /api/admin/dashboard/hourly-activity?days=30
```

Previously undocumented. `days` defaults to 30.

**Response `200`**

```json
{
  "status": "success",
  "message": "Hourly activity",
  "data": {
    "hours": [ { "hour": 0, "orders": 12 }, { "hour": 1, "orders": 4 } ],
    "peakHour": 20,
    "leastActiveHour": 3
  }
}
```

---

### Admin — Finance

Base path: `/api/admin/finance`. This entire router was previously undocumented despite
being fully implemented.

#### Finance Overview

```
GET /api/admin/finance/overview?from=&to=
```

Defaults to a 365-day trailing window when `from`/`to` are omitted.

**Response `200`**

```json
{
  "status": "success",
  "message": "Finance overview",
  "data": {
    "grossRevenue": 184500.50,
    "onlineRevenue": 92000.00,
    "dineInRevenue": 92500.50,
    "deliveryPartnerPayout": 24500.00,
    "commissionRevenue": 27675.08,
    "netPlatformProfit": 3175.08,
    "range": { "from": "2025-08-06T00:00:00.000Z", "to": "2026-08-06T00:00:00.000Z" }
  }
}
```

> **Caveat:** `deliveryPartnerPayout` only counts `Payout` documents whose entire
> `periodStart`–`periodEnd` window falls inside `from`/`to`, while `commissionRevenue` is
> matched by exact date range against `Bill.paidAt`. For a date range that doesn't align
> with weekly/monthly payout cycles, this can under-count real partner payouts and make
> `netPlatformProfit` look larger than it actually is — don't treat this figure as
> audit-grade for arbitrary custom ranges.

#### Revenue Trend

```
GET /api/admin/finance/revenue-trend?months=12
```

**Response `200`** — `data: { points: [ { date, online, dineIn } ] }`, one point per month.

#### Earnings vs Spending

```
GET /api/admin/finance/earnings-vs-spending?months=12
```

**Response `200`** — `data: { points: [ { date, earnings, spending } ] }`. `earnings` is
commission on paid bills for that month; `spending` is `Payout.netPayable` attributed to
the month the payout *period started* in (a payout period straddling a month boundary is
attributed entirely to its start month, which can make month-over-month comparisons near
boundaries slightly misleading).

#### Restaurant Revenue Table

```
GET /api/admin/finance/restaurants?page=&limit=&from=&to=
```

**Response `200`** — `data: { restaurants: [ { restaurantId, name, revenue, growthPercent } ], total, page, pages }`. `growthPercent` compares the requested range against the equivalent prior period.

---

### Admin — Orders

Base path: `/api/admin/orders`. Previously undocumented.

#### Reassign Delivery Partner

```
PATCH /api/admin/orders/:id/delivery-partner
```

**Body**

```json
{ "partnerId": "664partner...", "reason": "Original partner went offline" }
```

| Field | Type | Required |
|-------|------|----------|
| `partnerId` | string | Yes |
| `reason` | string | No |

Only allowed on `type: 'delivery'` orders (`400 INVALID_ORDER_TYPE` otherwise). Pushes
the previous assignment onto `deliveryAssignment.history`, sets the new `partnerId`,
`status: 'assigned'`, `assignedBy: 'admin'`. `partnerId` is not checked for existence or
verification status before assignment. Logs `ORDER_DELIVERY_REASSIGNED`.

**Response `200`** — `data: { order }`

---

### Admin — Reports

Base path: `/api/admin/reports`

#### Top Stores

```
GET /api/admin/reports/top-stores
```

**Query parameters**

| Param | Type | Default |
|-------|------|---------|
| `limit` | number | 10 |

Aggregates paid `Bill`s grouped by `restaurantId`, sorted by revenue descending, joined against `restaurants` for `name`/`avgRating`.

**Response `200`**

```json
{
  "status": "success",
  "message": "Top stores",
  "data": {
    "stores": [
      { "restaurantId": "664abc...", "revenue": 92000, "orders": 340, "name": "Spice Garden", "avgRating": 4.3 }
    ]
  }
}
```

---

#### Top Delivery Partners

```
GET /api/admin/reports/top-delivery-partners
```

**Query parameters**

| Param | Type | Default |
|-------|------|---------|
| `limit` | number | 10 |

Sorted by `totalDeliveries` descending.

**Response `200`** — `data: { partners }`

---

## Partner — Auth

The delivery-partner mobile app has its own API surface, entirely separate from
`/api/admin/delivery-partners/*` (the admin's management of partner records — onboarding
review, payouts, suspension). Everything under `/api/partner/*` is called by the delivery
partner's own device.

Base path: `/api/partner/auth`

### Partner tokens

Partner auth issues an access + refresh token pair, both signed with `JWT_PARTNER_SECRET` —
a separate secret from customer/owner (`JWT_ACCESS_SECRET`/`JWT_REFRESH_SECRET`) and staff
(`JWT_STAFF_SECRET`) tokens. A partner token is never valid on a customer/owner/staff route
and vice versa.

| Token | Where sent | Lifetime |
|-------|-----------|----------|
| `accessToken` | `Authorization: Bearer <token>` header | 15 min |
| `refreshToken` | JSON response body (not a cookie — React Native has no cookie jar) | 30 days |

Every route except `request-otp`/`verify-otp`/`refresh` requires
`Authorization: Bearer <partnerAccessToken>` (enforced by `authenticatePartner`
middleware, applied at the top of each sub-router). A token whose partner record has
`status: 'suspended'` is rejected with `401 INVALID_TOKEN` even if otherwise valid.

### Request OTP

```
POST /api/partner/auth/request-otp
```

**No auth required.** Rate-limited: 10 requests/minute per IP (`authLimiter`), plus 3
requests per 10 minutes per phone number (`429 RATE_LIMITED` beyond either).

**Body**

```json
{ "phone": "9876543210" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | Exactly 10 digits |

**Response `200`**

```json
{
  "status": "success",
  "message": "OTP sent",
  "data": { "phone": "9876543210", "devOtp": "482913" }
}
```

`devOtp` is only present outside `NODE_ENV=production` — no real SMS provider is
configured anywhere in this codebase; in dev/staging the code is echoed back instead of
sent. The OTP is valid for 5 minutes and allows up to 5 verify attempts before it's
invalidated.

---

### Verify OTP

```
POST /api/partner/auth/verify-otp
```

**No auth required.**

**Body**

```json
{ "phone": "9876543210", "otp": "482913" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | Exactly 10 digits |
| `otp` | string | Yes | Exactly 6 digits |

On first verification for a phone number, a bare `DeliveryPartner` record is created
automatically (`phone` only — `status: 'inactive'`, `verificationStatus:
'pending_documents'`). Full onboarding (name, vehicle, bank, documents) is submitted
separately via the onboarding endpoints below. On a returning phone number, the existing
record logs in as-is.

**Response `200`**

```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "partner": {
      "_id": "664prt...",
      "phone": "9876543210",
      "status": "inactive",
      "verificationStatus": "pending_documents",
      "fleetType": "standard",
      "documents": [],
      "training": { "currentModuleId": null, "watchedSeconds": 0, "certificateStatus": "pending" },
      "notificationPreferences": { "orders": true, "payments": true, "promotions": true, "appUpdates": true, "soundVibration": true },
      "rating": 0,
      "totalDeliveries": 0
    },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  }
}
```

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `OTP_EXPIRED` | OTP expired or was never requested |
| 400 | `INVALID_OTP` | Wrong code |
| 400 | `OTP_LOCKED` | 5 wrong attempts — request a new OTP |
| 401 | `ACCOUNT_SUSPENDED` | This phone number's partner account is suspended |

---

### Refresh Access Token

```
POST /api/partner/auth/refresh
```

**No auth required** (the refresh token itself is the credential).

**Body**

```json
{ "refreshToken": "eyJ..." }
```

| Field | Type | Required |
|-------|------|----------|
| `refreshToken` | string | Yes |

**Response `200`**

```json
{
  "status": "success",
  "message": "Token refreshed",
  "data": { "accessToken": "eyJ..." }
}
```

**Response `401`** — `INVALID_TOKEN` if the refresh token is malformed/expired, the partner
no longer exists, or the partner is now suspended. `400 VALIDATION_ERROR` if
`refreshToken` is missing from the body.

---

### Logout

```
POST /api/partner/auth/logout
```

**Auth: Partner Bearer token**

**Body** — none

**Response `200`** — `data: null`

The access token presented is blacklisted in Redis for its remaining lifetime (same
mechanism as staff logout).

---

## Partner — Onboarding

Base path: `/api/partner/onboarding`. All routes require a partner Bearer token.

A partner progresses `pending_documents` → (submit) → `under_review` → `approved` (or
`rejected` / `resubmission_required`, both of which allow resubmitting). Editing a
KYC-sensitive field (`aadharNumber`/`panNumber`; `vehicle.number`/`rcNumber`/
`insuranceNumber`/`insuranceValidTill`; `bankDetails.accountNumber`/`ifscCode`) after
approval automatically reverts `verificationStatus` back to `under_review` — cosmetic
fields (name spelling, vehicle model/color, bank branch name, gender) do not.

### Update Personal Details

```
PATCH /api/partner/onboarding/personal
```

**Body** (all optional — send only what changed)

```json
{
  "fullName": "Ravi Kumar",
  "email": "ravi@example.com",
  "dateOfBirth": "1998-04-12",
  "gender": "male",
  "emergencyPhone": "9876500000",
  "aadharNumber": "1234-5678-9012",
  "panNumber": "ABCDE1234F"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `fullName` | string | No | Min 2 chars |
| `email` | string | No | Valid email |
| `dateOfBirth` | date string | No | Coerced to `Date` |
| `gender` | `"male"` \| `"female"` \| `"other"` | No | |
| `emergencyPhone` | string | No | |
| `aadharNumber` | string | No | KYC-sensitive — triggers re-review if changed post-approval |
| `panNumber` | string | No | KYC-sensitive — triggers re-review if changed post-approval |

**Response `200`** — `data: { partner }` (full updated partner document)

**Errors:** `400 VALIDATION_ERROR`, `404 NOT_FOUND`

---

### Update Vehicle Details

```
PATCH /api/partner/onboarding/vehicle
```

**Body**

```json
{
  "vehicle": {
    "model": "Honda Activa",
    "number": "KA01AB1234",
    "type": "2_wheeler",
    "rcNumber": "RC123456",
    "insuranceProvider": "Acko",
    "insuranceNumber": "INS98765",
    "insuranceValidTill": "2027-01-01"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `vehicle.model` | string | No | |
| `vehicle.number` | string | No | KYC-sensitive |
| `vehicle.type` | `"2_wheeler"` \| `"ev_2_wheeler"` \| `"non_rto_2_wheeler"` | No | |
| `vehicle.rcNumber` | string | No | KYC-sensitive |
| `vehicle.insuranceProvider` | string | No | |
| `vehicle.insuranceNumber` | string | No | KYC-sensitive |
| `vehicle.insuranceValidTill` | date string | No | KYC-sensitive |

`fleetType` (`veg`/`standard`) is **not** settable here — it defaults to `standard` at
signup and can only change via the Fleet Change Request flow below or an admin action.
The whole `vehicle` object is replaced with what's sent (no partial-object merge at the
sub-field level beyond what's included in the request).

**Response `200`** — `data: { partner }`

**Errors:** `400 VALIDATION_ERROR`, `404 NOT_FOUND`

---

### Update Bank Details

```
PATCH /api/partner/onboarding/bank
```

**Body**

```json
{
  "bankDetails": {
    "bankName": "HDFC Bank",
    "accountHolderName": "Ravi Kumar",
    "accountNumber": "50100123456789",
    "accountType": "savings",
    "ifscCode": "HDFC0000123",
    "branchName": "MG Road",
    "upiId": "ravi@okhdfcbank"
  }
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `bankDetails.bankName` | string | No | |
| `bankDetails.accountHolderName` | string | No | |
| `bankDetails.accountNumber` | string | No | KYC-sensitive — the real payout destination |
| `bankDetails.accountType` | `"savings"` \| `"current"` | No | |
| `bankDetails.ifscCode` | string | No | KYC-sensitive |
| `bankDetails.branchName` | string | No | |
| `bankDetails.upiId` | string | No | |

**Response `200`** — `data: { partner }`

**Errors:** `400 VALIDATION_ERROR`, `404 NOT_FOUND`

---

### Upload Onboarding Documents

```
POST /api/partner/onboarding/documents
```

**Content-Type:** `multipart/form-data`

| Field | Type | Notes |
|-------|------|-------|
| `aadharCard` | file | Optional, max 5 MB, JPEG/PNG/WebP/PDF |
| `drivingLicense` | file | Optional, same limits |
| `vehicleRc` | file | Optional, same limits |
| `insuranceDocument` | file | Optional, same limits |
| `profilePhoto` | file | Optional, same limits |

At least one file is required. Each is stored in Cloudinary under
`yulostores/delivery-partners/<partnerId>` (PDFs use `resource_type: 'auto'`, images use
`'image'`) and recorded in `documents` with type `aadhar_card` / `driving_license` /
`vehicle_rc` / `insurance_document` / `profile_photo` and `status: 'pending'`.
Re-uploading a document type **replaces** the existing entry for that type (old Cloudinary
asset is best-effort deleted) rather than appending a duplicate. If any upload in the
batch fails partway through, the ones that already succeeded in this request are rolled
back from Cloudinary and the whole request fails.

**Response `200`**

```json
{
  "status": "success",
  "message": "Documents uploaded",
  "data": {
    "documents": [
      { "type": "aadhar_card", "url": "https://res.cloudinary.com/.../aadharCard_...", "status": "pending", "uploadedAt": "2026-08-06T10:00:00.000Z" }
    ]
  }
}
```

**Errors:** `400 INVALID_FILE_TYPE` (multer file filter), `400 VALIDATION_ERROR` (no files
provided), `404 NOT_FOUND`, `500 UPLOAD_FAILED`

---

### Submit For Review

```
POST /api/partner/onboarding/submit
```

**Body** — none

Validates that `fullName`, `phone`, all 5 required document types, and
`bankDetails.accountNumber` are present, then moves `verificationStatus` to
`under_review`. Callable from `pending_documents` (first submission) or
`resubmission_required` (after admin requested fixes) — not callable from
`under_review`, `approved`, or `rejected`.

**Response `200`** — `data: { partner }`

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `ALREADY_UNDER_REVIEW` | Already submitted, awaiting admin |
| 400 | `ALREADY_APPROVED` | Already verified |
| 400 | `REJECTED` | Application was rejected — contact support |
| 400 | `INCOMPLETE_ONBOARDING` | Missing fields — see `details.missing` (array of field/`document:<type>` names) |

---

### Get Onboarding Status

```
GET /api/partner/onboarding/status
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Onboarding status",
  "data": {
    "verificationStatus": "under_review",
    "verificationNotes": null,
    "documents": [ { "type": "aadhar_card", "url": "...", "status": "pending" } ]
  }
}
```

---

## Partner — Duty & Location

Going online (`status: 'active'`) requires `verificationStatus === 'approved'`. A partner
at their concurrent-order limit is moved to `status: 'busy'` by the system automatically
(see Orders below) and cannot manually toggle duty out of `busy` — the system clears it
back to `active` once their last active order is delivered.

### Toggle Duty

```
POST /api/partner/duty/toggle
```

**Body**

```json
{ "online": true }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `online` | boolean | Yes | `true` → `status: 'active'`, `false` → `status: 'inactive'` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Duty status updated",
  "data": { "status": "active", "verificationStatus": "approved" }
}
```

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 403 | `NOT_VERIFIED` | Must complete verification (`approved`) before going online |
| 409 | `PARTNER_BUSY` | Cannot change duty status while on an active delivery |

---

### Get Duty Status

```
GET /api/partner/duty/status
```

**Response `200`** — `data: { status, verificationStatus }` (same shape as toggle's response)

---

### Update Location

```
POST /api/partner/location
```

Pings the partner's current position. Called periodically while the app is foregrounded
(recommended more frequently than 120s — see Freshness below).

**Body**

```json
{ "coordinates": [77.5946, 12.9716] }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `coordinates` | `[number, number]` | Yes | `[lng, lat]` — GeoJSON order, lng ∈ [-180,180], lat ∈ [-90,90] |

Stores `currentLocation` (GeoJSON `Point`) and `currentLocationUpdatedAt`. A ping older
than 120 seconds (`LOCATION_FRESHNESS_SECONDS`) is treated as stale and excluded from
proximity-based order ranking and distance display. If this partner is currently
`picked_up` on an order, a `partner_location_updated` Socket.IO event
(`{ orderId, lat, lng }`) is emitted to that order's room — see WebSocket Events.

**Response `200`** — `data: null`

**Errors:** `400 VALIDATION_ERROR`

---

## Partner — Orders

Base path: `/api/partner/orders`. Assignment is a real-time offer, not a silent write: the
best eligible online candidate receives an `order_offer` Socket.IO event (join the
`partner:<partnerId>` room via `join_partner` — see WebSocket Events) with a countdown
window (`DELIVERY_OFFER_WINDOW_SECONDS`, ~18-22s); accept or reject via these endpoints
before it expires, or it's automatically re-offered to the next candidate.

### Get Current Order

```
GET /api/partner/orders/current
```

Returns whichever order this partner has in flight — an outstanding offer (in case the
app was backgrounded mid-offer) takes priority over an already-accepted assignment.
Lazily expires a stale offer before answering.

**Response `200`** — one of three shapes:

```json
{ "status": "success", "message": "Current order", "data": { "kind": "none", "order": null } }
```
```json
{ "status": "success", "message": "Current order", "data": { "kind": "offer", "order": { "orderId": "664ord...", "restaurantName": "Spice Villa", "restaurantAddress": "12 MG Road, Bengaluru", "fleetType": "standard", "vegFleetOptIn": false, "dedicatedBagRequired": false, "deliveryInstructions": "Ring the bell twice", "pickupKm": 1.4, "dropKm": 3.2, "totalKm": 4.6, "fare": 40, "payment": "cod", "codAmount": 560, "items": [ { "name": "Butter Chicken", "qty": 2 } ], "customerName": "Amir", "customerAddress": "45 Residency Rd, Bengaluru", "customerEtaMin": null, "pickupEtaMin": null, "countdownSeconds": 20 } } }
```
```json
{ "status": "success", "message": "Current order", "data": { "kind": "assigned", "order": { "_id": "664ord...", "deliveryAssignment": { "status": "picked_up", "pickupOtp": "4821" }, "restaurantId": { "name": "Spice Villa", "address": { "street": "12 MG Road" } } } } }
```

`kind: "offer"` uses the same payload shape as the `order_offer` socket push.
`pickupKm`/`customerEtaMin`/`pickupEtaMin` are `null` whenever the partner's own location
ping isn't fresh (< 120s old) — never estimated from a stale position. There is no real
routing/ETA engine; distances are straight-line (haversine), not road-network.

---

### Accept Order

```
POST /api/partner/orders/:orderId/accept
```

**Body** — none

Moves `deliveryAssignment.status` to `assigned`, generates a 4-digit `pickupOtp`, and
records the acceptance in `deliveryAssignment.history`. If this acceptance pushes the
partner to their max concurrent-order limit (`DELIVERY_PARTNER_MAX_CONCURRENT_ORDERS`),
their `status` is flipped to `busy`.

**Response `200`** — `data: { order }` (full order document)

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 403 | `NOT_YOUR_OFFER` | This order was not offered to you (or already resolved) |
| 409 | `OFFER_EXPIRED` | The offer window passed — it's already been re-offered |
| 404 | `NOT_FOUND` | Order doesn't exist |

---

### Reject Order

```
POST /api/partner/orders/:orderId/reject
```

**Body**

```json
{ "reason": "Restaurant too far", "notes": null }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `reason` | enum | Yes | One of: `"Restaurant too far"`, `"Drop location too far"`, `"Too many active orders"`, `"Taking a break"`, `"Other"` |
| `notes` | string | Conditional | Required when `reason` is `"Other"` |

Immediately triggers re-assignment to the next candidate.

**Response `200`**

```json
{ "status": "success", "message": "Order rejected", "data": { "reassigned": true } }
```

**Errors:** `400 VALIDATION_ERROR`, `403 NOT_YOUR_OFFER`, `409 OFFER_EXPIRED`, `404 NOT_FOUND`

---

### Verify Pickup

```
POST /api/partner/orders/:orderId/verify-pickup
```

**Body**

```json
{ "otp": "4821", "packagingChecklist": { "sealIntact": true, "tempBagUsed": true } }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `otp` | string | Yes | Exactly 4 digits — compared with a timing-safe check |
| `packagingChecklist.sealIntact` | boolean | Conditional | Required only if this partner's `fleetType` is `veg` |
| `packagingChecklist.tempBagUsed` | boolean | Conditional | Required only if this partner's `fleetType` is `veg` |

The checklist requirement is driven by the **partner's own** `fleetType`, not this
particular order's veg-fleet flag.

**Response `200`** — `data: { order }`

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 403 | `NOT_YOUR_ORDER` | Order is not assigned to you |
| 400 | `INVALID_STATE` | Order isn't in `assigned` status |
| 400 | `INVALID_OTP` | Wrong pickup code |
| 400 | `CHECKLIST_INCOMPLETE` | Veg-fleet packaging checklist not confirmed |

---

### Deliver Order

```
POST /api/partner/orders/:orderId/deliver
```

**Body**

```json
{ "codCollected": 560 }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `codCollected` | number | Conditional | Required (min 0) only if `order.paymentMethod === 'cash'` |

Freezes `deliveryAssignment.earningsBreakdown` (basePay + haversine-based distancePay;
surge/tip/penalty are always 0 — no engine for any exists) permanently at this moment —
later rate changes never retroactively affect a delivered order. For COD orders, a
mismatch between `codCollected` and `order.subtotal` is recorded as
`codDiscrepancy` rather than blocking the delivery (self-reported cash handoff, nothing
to authoritatively verify against). Marks the order `delivered`, bills it, and — if this
was the partner's last active order — flips their `status` back from `busy` to `active`.

**Response `200`** — `data: { order }`

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 403 | `NOT_YOUR_ORDER` | Order is not assigned to you |
| 400 | `INVALID_STATE` | Order isn't in `picked_up` status |
| 400 | `VALIDATION_ERROR` | `codCollected` missing on a cash order |

---

### Get Order Summary

```
GET /api/partner/orders/:orderId/summary
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Order summary",
  "data": {
    "totalKm": 4.6,
    "payout": { "basePay": 40, "distancePay": 12, "surge": 0, "tip": 0, "penalty": 0 }
  }
}
```

Once `delivered`, returns the exact frozen `earningsBreakdown` figures. Before delivery,
returns a live preview estimate (flat `basePay` only, `distancePay: 0`) using the same
fresh-location-or-null logic as the offer payload — never disagrees with what the partner
saw on the original offer card.

**Errors:** `403 NOT_YOUR_ORDER`, `404 NOT_FOUND`

---

## Partner — Earnings, Payouts & Deposits

There is **no partner-facing endpoint to list Payout documents** — payouts (weekly/monthly
`netPayable`, incentives, deductions) are entered and paid entirely through
`/api/admin/delivery-partners/:id/payouts` by the admin. The endpoints below are the
partner's own read-only earnings view (an informational estimate, see note below) and
their COD cash-in-hand/deposit ledger.

### Get Earnings

```
GET /api/partner/earnings?period=today
```

| Query | Type | Required | Notes |
|-------|------|----------|-------|
| `period` | `"today"` \| `"weekly"` \| `"monthly"` | No | Default `"today"` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Earnings",
  "data": {
    "label": "today",
    "totalEarned": 340,
    "orders": 6,
    "incentiveBonus": 0,
    "idlePay": 0,
    "basePay": 240,
    "distancePay": 100,
    "peakSurge": 0,
    "tips": 0,
    "penalties": 0
  }
}
```

`basePay` here is computed the same way (same rate, same delivered-order set) as the
admin's `grossEarnings` for the period, so the two never disagree on that component. The
rest (`distancePay`, and the always-zero `incentiveBonus`/`idlePay`/`peakSurge`/`tips`)
are informational estimates/placeholders, not yet folded into any actual admin payout —
`totalEarned` here can legitimately exceed what the admin payout eventually pays out.

**Errors:** `400 VALIDATION_ERROR` (invalid `period`)

---

### Get Cash In Hand

```
GET /api/partner/earnings/cash-in-hand
```

**Response `200`**

```json
{ "status": "success", "message": "Cash in hand", "data": { "cashInHand": 1240 } }
```

Full-ledger computation: total COD collected across all delivered cash orders, minus
total confirmed deposits — never negative (clamped at 0).

---

### Create Deposit

```
POST /api/partner/deposits
```

**Body**

```json
{ "amount": 1240, "depositPointRestaurantId": "664abc...", "notes": "Handed to store manager" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `amount` | number | Yes | Positive |
| `depositPointRestaurantId` | string | No | Must reference an existing restaurant if provided |
| `notes` | string | No | |

Self-confirmed immediately (`status: 'confirmed'`) — no cashier/restaurant-side
reconciliation step exists in this codebase yet.

**Response `201`**

```json
{
  "status": "success",
  "message": "Deposit recorded",
  "data": {
    "deposit": {
      "_id": "664dep...",
      "amount": 1240,
      "depositMethod": "store_deposit",
      "reference": "DEP-4F2A9C1B",
      "status": "confirmed",
      "createdAt": "2026-08-06T18:00:00.000Z"
    },
    "cashInHand": 0
  }
}
```

**Errors:** `400 VALIDATION_ERROR`

---

### List Deposits

```
GET /api/partner/deposits?page=&limit=
```

**Response `200`** — `data: { rows, total, page, pages }` (standard pagination shape, `rows` = `CashDeposit[]`)

---

## Partner — Fleet Change Requests

Base path: `/api/partner/fleet-change-requests`. A partner is currently either on the
`veg`-only fleet or the `standard` fleet (`fleetType`, fixed at signup default
`standard`); switching requires admin approval via this request flow.

### Create Fleet Change Request

```
POST /api/partner/fleet-change-requests
```

**Body**

```json
{ "requestedFleetType": "veg", "reason": "Not enough orders on veg fleet", "notes": "optional" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `requestedFleetType` | `"veg"` \| `"standard"` | Yes | Must differ from current `fleetType` |
| `reason` | enum | Yes | One of: `"Not enough orders on veg fleet"`, `"Moving to a different zone"`, `"Equipment issue (bag problem)"`, `"Personal reason"` (no free-text "Other") |
| `notes` | string | No | |

Only one `pending` request per partner at a time.

**Response `201`**

```json
{
  "status": "success",
  "message": "Fleet change request submitted",
  "data": {
    "request": { "_id": "664fcr...", "currentFleetType": "standard", "requestedFleetType": "veg", "reason": "Not enough orders on veg fleet", "status": "pending" },
    "expectedResponseHours": 72
  }
}
```

**Errors**

| HTTP | Code | Meaning |
|------|------|---------|
| 400 | `VALIDATION_ERROR` | Requested fleet type is the same as current, or bad reason |
| 409 | `ALREADY_PENDING` | A pending request already exists |

---

### Get Fleet Change Requests

```
GET /api/partner/fleet-change-requests?page=&limit=
```

Paginated history — the most recent row is the current pending request, if one exists.

**Response `200`** — `data: { rows, total, page, pages, expectedResponseHours: 72 }`

---

## Partner — Training

Base path: `/api/partner/training`. Reachable only once `verificationStatus === 'approved'`
(`403 NOT_APPROVED` on every endpoint below otherwise). Three fixed modules, completed in
order: `app-basics` → `veg-handling` → `safety-and-conduct`.

### Get Training Status

```
GET /api/partner/training/status
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Training status",
  "data": {
    "moduleId": "veg-handling",
    "moduleLabel": "Veg Handling SOP",
    "moduleIndex": 2,
    "totalModules": 3,
    "watchedSeconds": 120,
    "durationSeconds": 500,
    "completedModules": [ { "moduleId": "app-basics", "quizScore": 9, "completedAt": "2026-08-01T10:00:00.000Z" } ],
    "lastQuizScore": 9,
    "certificateStatus": "pending"
  }
}
```

Once fully complete, `moduleId`/`moduleLabel`/`moduleIndex`/`durationSeconds` are all
`null` and `certificateStatus` is `"issued"`.

---

### Update Training Progress

```
PATCH /api/partner/training/progress
```

**Body**

```json
{ "moduleId": "veg-handling", "watchedSeconds": 250 }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `moduleId` | string | Yes | Must match the partner's current module |
| `watchedSeconds` | number | Yes | Min 0 — monotonic, clamped to the module's real duration |

**Response `200`** — same shape as Get Training Status

**Errors:** `400 VALIDATION_ERROR`, `403 NOT_APPROVED`, `400 TRAINING_COMPLETE`, `400 INVALID_MODULE` (moduleId doesn't match current)

---

### Complete Module

```
POST /api/partner/training/:moduleId/complete
```

**Body**

```json
{ "quizScore": 9 }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `quizScore` | number | Yes | 0–10 |

Requires `watchedSeconds >= durationSeconds` for the current module first. Advances to
the next module (resetting `watchedSeconds` to 0), or issues the certificate
(`certificateStatus: 'issued'`) if this was the last module.

**Response `200`** — same shape as Get Training Status

**Errors:** `400 VALIDATION_ERROR`, `403 NOT_APPROVED`, `400 TRAINING_COMPLETE`, `400 INVALID_MODULE`, `400 MODULE_NOT_WATCHED`

---

## Partner — Profile & Support

### Get Profile

```
GET /api/partner/profile
```

**Response `200`** — `data: { partner }` (full `DeliveryPartner` document, same shape as the login response's `partner`)

---

### Update Notification Preferences

```
PATCH /api/partner/notifications
```

Note the path — this endpoint is mounted at `/api/partner/notifications`, not under
`/profile`, even though it's implemented in `profile.controller.js`.

**Body** (all optional — send only what changed)

```json
{ "orders": true, "payments": true, "promotions": false, "appUpdates": true, "soundVibration": true }
```

| Field | Type | Required |
|-------|------|----------|
| `orders`, `payments`, `promotions`, `appUpdates`, `soundVibration` | boolean | No |

**Response `200`** — `data: { notificationPreferences }`

**Errors:** `400 VALIDATION_ERROR`

---

### Create Support Ticket

```
POST /api/partner/support/tickets
```

**Body**

```json
{ "subject": "App crashed mid-delivery", "description": "...", "category": "technical" }
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `subject` | string | Yes | Min 1 char |
| `description` | string | Yes | Min 1 char |
| `category` | `"billing"` \| `"technical"` \| `"account"` \| `"delivery"` \| `"other"` | No | Default `"other"` |

Creates a `SupportTicket` with `raisedByType: 'delivery_partner'` — the same admin ticket
queue used for other raiser types, filtered by `raisedByType`/`raisedBy` for this
partner's own list view. Only "Report an issue" is backed by a real endpoint; the app's
"Call support"/"Chat with us"/"Email us" rows have no telephony/chat/email integration
anywhere in this codebase.

**Response `201`** — `data: { ticket }`

**Errors:** `400 VALIDATION_ERROR`

---

### List Support Tickets

```
GET /api/partner/support/tickets?page=&limit=
```

**Response `200`** — `data: { rows, total, page, pages }` — only this partner's own tickets (`raisedByType: 'delivery_partner'`, `raisedBy: <partnerId>`)

---

## Staff — Authentication

### Staff Login

```
POST /api/staff/auth/login
```

**No auth required.**

**Body**

```json
{
  "restaurantId": "664abc...",
  "staffCode": "W-104",
  "pin": "1234"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `restaurantId` | string | Yes | ObjectId |
| `staffCode` | string | Yes | 1–10 chars; matched against the restaurant's staff roster (uppercased server-side) |
| `pin` | string | Yes | 4–8 digits |

**Response `200`**

```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "staffToken": "eyJ...",
    "role": "waiter",
    "name": "Ravi Kumar",
    "staffCode": "W-104",
    "restaurantId": "664abc..."
  }
}
```

Note the response is a **flat** object — there is no nested `staff` object and no `_id`
returned. The PIN is verified with argon2id. The same generic error
(`401 INVALID_CREDENTIALS`) is returned whether the `staffCode` doesn't exist or the PIN
is wrong — no user enumeration.

---

### Staff Logout

```
POST /api/staff/auth/logout
```

**Auth: Staff Bearer token**

**Body** — none

**Response `200`** — `data: null`

The staff token is blacklisted in Redis.

---

## Waiter — Tables & Orders

All waiter routes require `Authorization: Bearer <staffToken>` with role `waiter`. The
`:restaurantId` in the path must also match the restaurant embedded in the staff token,
or the request is rejected with `403 WRONG_RESTAURANT`.

Base path: `/api/staff/:restaurantId/waiter`

### Scan Table QR

```
POST /api/staff/:restaurantId/waiter/tables/scan
```

Called when a waiter scans a physical table QR code. Opens a new session if none is active.

The QR URL has the form: `https://yourdomain.com/menu?restaurantId=<id>&tableId=<id>`. Extract the `tableId` query param and pass it as `qrToken`.

**Body**

```json
{
  "qrToken": "664tbl..."
}
```

`qrToken` is the table's `_id` (extracted from the `tableId` query param in the QR URL).

**Response `200`**

```json
{
  "status": "success",
  "message": "Table scanned",
  "data": {
    "table": {
      "_id": "664tbl...",
      "identifier": "T3",
      "capacity": 4
    },
    "session": {
      "_id": "664sess...",
      "status": "open",
      "batchCount": 1,
      "orders": []
    }
  }
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| 404 | `NOT_FOUND` | Table doesn't exist, isn't `isActive`, or belongs to another restaurant |
| 400 | `QR_VOID` | The table's QR code has been voided (`table.qrCode.status === 'void'`) |

---

### Get All Tables

```
GET /api/staff/:restaurantId/waiter/tables
```

Returns all active tables with their current open session (if any).

**Response `200`**

```json
{
  "status": "success",
  "message": "Tables fetched",
  "data": {
    "tables": [
      {
        "_id": "664tbl...",
        "identifier": "T1",
        "capacity": 4,
        "isActive": true,
        "session": {
          "_id": "664sess...",
          "status": "open",
          "batchCount": 2
        }
      },
      {
        "_id": "664tbl2...",
        "identifier": "T2",
        "capacity": 2,
        "isActive": true,
        "session": null
      }
    ]
  }
}
```

---

### Get Menu

```
GET /api/staff/:restaurantId/waiter/menu
```

Same response as `GET /api/restaurants/:id/menu` — served from 5-minute Redis cache.

---

### Create Dine-In Order

```
POST /api/staff/:restaurantId/waiter/orders
```

**Headers**

| Header | Required | Notes |
|--------|----------|-------|
| `Authorization` | Yes | Staff Bearer token |
| `Idempotency-Key` | Recommended | UUID v4 |

**Body**

```json
{
  "tableSessionId": "664sess...",
  "items": [
    { "menuItemId": "664item...", "quantity": 2 },
    { "menuItemId": "664item2...", "quantity": 1 }
  ],
  "specialInstructions": "No onions please"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `tableSessionId` | string | Yes | |
| `items` | array | Yes, min 1 | |
| `items[].menuItemId` | string | Yes | |
| `items[].quantity` | number | Yes, min 1 | |
| `items[].note` | string | No | Per-item note |
| `specialInstructions` | string | No | |

**Response `201`**

```json
{
  "status": "success",
  "message": "Order placed",
  "data": {
    "order": {
      "_id": "664ord...",
      "restaurantId": "664abc...",
      "tableSessionId": "664sess...",
      "staffId": "664staff...",
      "type": "dine_in",
      "status": "placed",
      "batchNumber": 2,
      "items": [
        {
          "menuItemId": "664item...",
          "name": "Butter Chicken",
          "price": 350,
          "quantity": 2,
          "note": ""
        }
      ],
      "subtotal": 820,
      "specialInstructions": "No onions please",
      "paymentMethod": "cash",
      "paymentStatus": "pending",
      "createdAt": "2026-06-17T13:15:00.000Z"
    }
  }
}
```

Order items do **not** carry a per-line `subtotal` — only `price` (unit) and `quantity`.
Only the order-level `subtotal` is the line-item sum.

**Response `200`** (idempotency key matched a prior request) — a **different, minimal**
shape, not a repeat of the order:

```json
{
  "status": "success",
  "message": "Duplicate — existing order returned",
  "data": { "order": { "orderId": "664ord...", "duplicate": true } }
}
```

**Errors**

| Status | Code | When |
|--------|------|------|
| 404 | `NOT_FOUND` | Restaurant not found or inactive |
| 400 | `ORDER_ITEM_UNAVAILABLE` | One or more `items[].menuItemId` don't exist or aren't available |
| 400 | `TABLE_SESSION_CLOSED` | `tableSessionId` doesn't resolve to a session with `status: 'open'` |

Order creation uses sequential operations to increment `batchCount` on the session and create the order (no MongoDB transactions — standalone MongoDB is supported). A `new_order` Socket.IO event is emitted to kitchen and restaurant rooms.

---

### Get Active Sessions

```
GET /api/staff/:restaurantId/waiter/sessions
```

Returns all open table sessions with their orders and a running total.

**Response `200`**

```json
{
  "status": "success",
  "message": "Active sessions",
  "data": {
    "sessions": [
      {
        "_id": "664sess...",
        "tableId": "664tbl...",
        "status": "open",
        "batchCount": 3,
        "orders": [ { ... }, { ... } ],
        "runningTotal": 1450
      }
    ]
  }
}
```

---

### Get Bill for Session

```
GET /api/staff/:restaurantId/waiter/sessions/:sessionId/bill
```

Assembles (or fetches cached) bill for the session. Idempotent — safe to call multiple times.

**Response `200`**

```json
{
  "status": "success",
  "message": "Bill",
  "data": {
    "bill": {
      "_id": "664bill...",
      "restaurantId": "664abc...",
      "tableSessionId": "664sess...",
      "batches": [
        {
          "batchNumber": 1,
          "orderId": "664ord...",
          "items": [
            { "name": "Butter Chicken", "quantity": 2, "price": 350, "lineTotal": 700 }
          ],
          "batchTotal": 700,
          "placedAt": "2026-06-17T13:15:00.000Z"
        }
      ],
      "subtotal": 1200,
      "gstPercent": 5,
      "gstAmount": 60,
      "serviceChargePercent": 10,
      "serviceChargeAmount": 120,
      "discountsApplied": [],
      "grandTotal": 1380,
      "status": "open"
    }
  }
}
```

Items only ever exist nested inside `batches[]` — there is no top-level `items` array,
and the real fee fields are `gstPercent`/`gstAmount` and `serviceChargePercent`/
`serviceChargeAmount` (not `taxRate`/`taxAmount`), with `discountsApplied` as an array of
`{discountId, code, description, amount}` rather than a single `discountAmount` number.

A `bill_updated` Socket.IO event is emitted to the table room when the bill is assembled —
see [WebSocket Events](#bill_updated) for its actual (different, trimmed) payload shape.

---

### Mark Bill as Paid

```
POST /api/staff/:restaurantId/waiter/sessions/:sessionId/bill/mark-paid
```

Closes the bill, closes the table session, and marks the table as available.

**Body**

```json
{
  "paymentMethod": "upi"
}
```

| `paymentMethod` | Values |
|-----------------|--------|
| Accepted values | `"cash"`, `"upi"`, `"card"`, `"online"` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Bill marked as paid",
  "data": {
    "bill": {
      "_id": "664bill...",
      "restaurantId": "664abc...",
      "tableSessionId": "664sess...",
      "subtotal": 1200,
      "gstPercent": 5,
      "gstAmount": 60,
      "serviceChargePercent": 10,
      "serviceChargeAmount": 120,
      "discountsApplied": [],
      "grandTotal": 1380,
      "status": "paid",
      "paidBy": "upi",
      "paidAt": "2026-06-17T14:00:00.000Z"
    }
  }
}
```

The schema field is `paidBy`, not `paymentMethod` — the request body still uses
`paymentMethod` (see above), but the value is stored and returned under `paidBy`. The
response is the full bill (see [Get Bill for Session](#get-bill-for-session) for the
complete shape), not the trimmed subset shown here previously.

A `table_status_changed` Socket.IO event (`{ tableId, identifier, sessionStatus: "paid" }`
— field is `sessionStatus`, not `status`) is emitted to the restaurant room.

---

## Kitchen — KDS

All kitchen routes require `Authorization: Bearer <staffToken>` with role `chef`. The
`:restaurantId` in the path must also match the restaurant embedded in the staff token,
or the request is rejected with `403 WRONG_RESTAURANT`.

Base path: `/api/staff/:restaurantId/kitchen`

### Get Order Queue

```
GET /api/staff/:restaurantId/kitchen/queue
```

Returns active orders (status: `placed` or `confirmed`) **created since local midnight
today**, sorted by creation time ascending. Orders older than today are excluded from
this endpoint even if still in an active status.

**Response `200`**

```json
{
  "status": "success",
  "message": "Kitchen queue",
  "data": {
    "orders": [
      {
        "_id": "664ord...",
        "type": "dine_in",
        "status": "placed",
        "batchNumber": 1,
        "tableSessionId": "664sess...",
        "items": [
          {
            "menuItemId": "664item...",
            "name": "Paneer Tikka",
            "quantity": 2,
            "price": 280
          }
        ],
        "subtotal": 560,
        "specialInstructions": "Extra chutney",
        "createdAt": "2026-06-17T13:10:00.000Z"
      }
    ]
  }
}
```

---

### Get Prep Board

```
GET /api/staff/:restaurantId/kitchen/board
```

Returns orders grouped by status for the Kanban board view: `preparing`, `ready`, and a
bounded `completed` list. There is no `placed` or `confirmed` key on this endpoint —
those statuses live only in [Get Order Queue](#get-order-queue) above.

**Response `200`**

```json
{
  "status": "success",
  "message": "Kitchen board",
  "data": {
    "preparing": [ { ... } ],
    "ready": [ { ... } ],
    "completed": [ { ... } ]
  }
}
```

`preparing`/`ready` are live orders currently in that status. `completed` is orders with
status `delivered` or `out_for_delivery`, updated today only, newest 20 (sorted by
`updatedAt` descending).

---

### Update Order Status

```
PATCH /api/staff/:restaurantId/kitchen/orders/:orderId/status
```

Uses optimistic concurrency control internally, but the server re-reads the order's
current status itself immediately before writing — it does **not** use any
`currentStatus` field the client sends (the request schema only defines `newStatus`;
anything else in the body is silently ignored by Zod's default unknown-key stripping).
You do not need to track or send the status you currently see.

**Body**

```json
{
  "newStatus": "confirmed"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `newStatus` | string | Yes | The desired next status |

**Allowed transitions**

| From | To (allowed values) |
|------|---------------------|
| `placed` | `confirmed`, `preparing`, `cancelled` |
| `confirmed` | `preparing`, `cancelled` |
| `preparing` | `ready`, `cancelled` |
| `ready` | `out_for_delivery`, `delivered`, `cancelled` |
| `out_for_delivery` | `delivered`, `cancelled` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Order status updated",
  "data": {
    "order": { "...": "the full Order document, not just _id/status/updatedAt" }
  }
}
```

For `type: "delivery"` orders transitioning to `confirmed`, this also triggers
delivery-partner auto-assignment. For non-`dine_in` orders transitioning to `delivered`,
this bills the order and flips `paymentStatus` to `paid` if it was `pending`/`pending_cod`
— side effects the customer- and partner-facing docs describe from their own side, not
repeated in full here.

**Response `409`** — if the order's status changed between the server's own read and its
write (a race with another concurrent request, not with anything the client claims to
have seen)

```json
{
  "status": "error",
  "code": "CONCURRENT_UPDATE",
  "message": "Status was already changed by another request — please refresh"
}
```

An `order_status_updated` Socket.IO event is emitted unconditionally to the kitchen,
restaurant, and order rooms — and, only when the order has an associated `staffId`
(dine-in orders placed by a waiter), to that specific waiter's own room. There is no
generic "waiter" broadcast room this event goes to.

---

### Get Order Detail

```
GET /api/staff/:restaurantId/kitchen/orders/:orderId
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Order detail",
  "data": {
    "order": {
      "_id": "664ord...",
      "type": "dine_in",
      "status": "preparing",
      "items": [ ... ],
      "subtotal": 560,
      "specialInstructions": "Extra chutney",
      "createdAt": "..."
    }
  }
}
```

---

## Webhooks

Server-to-server callbacks from third-party providers. No `Authorization` header —
authenticated entirely by a per-provider signature check instead.

### Razorpay

```
POST /api/webhooks/razorpay
```

Fallback path for confirming an `"online"` payment when [Verify Payment](#verify-payment)
never gets called from the client (network drop, app killed mid-payment) — configured as
a webhook URL in the Razorpay dashboard, pointed at this endpoint.

**Headers**

| Header | Notes |
|-------|-------|
| `X-Razorpay-Signature` | HMAC-SHA256 of the **raw** request body using `RAZORPAY_WEBHOOK_SECRET` — a separate secret from `RAZORPAY_KEY_SECRET` used by the client-side verify endpoint above |

This route is mounted ahead of this API's normal JSON body parser specifically so the
signature check sees Razorpay's exact original bytes, not a re-serialized copy — the
signature would not reliably match otherwise.

Handles `payment.captured` and `payment.failed` events; any other event type is accepted
(`200`) but ignored. Matches the incoming payload's `payload.payment.entity.order_id`
against `Order.paymentIntentId` to find the order; if the signature doesn't verify, or no
order matches, nothing is written.

**Response `200`** — always, once the signature check passes, whether or not the event
type/order match led to any actual update. Razorpay treats any non-2xx as delivery
failure and retries automatically, so this only returns non-2xx (`400
INVALID_SIGNATURE`) when the signature itself doesn't verify — never for "nothing to do."

This endpoint is **idempotent** — redelivery of the same event (which Razorpay does on
any non-2xx response, and may occasionally do anyway) simply re-sets the same
`paymentStatus`, with no double-processing effect.

---

## WebSocket Events

Connect using Socket.IO client:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000');
// The connection itself is anonymous — server/socket.js has no handshake-level auth
// middleware and never reads socket.handshake.auth. Each join_* event below carries
// and verifies its own token independently; there is no top-level `auth: {token}` option.
```

### Rooms

After connecting, the client must emit one of the `join_*` events below to receive
targeted updates — connecting alone joins no rooms. **Every `join_*` event requires a
real, valid token as shown below**; an invalid/missing/mismatched one gets the socket
disconnected (`socket.disconnect()` server-side), not just silently ignored.

> **Correction:** earlier versions of this section omitted the required `token`/
> `staffToken` field on every one of these events, and documented two events
> (`join_table`, `track_visitor`) that were never actually implemented anywhere in this
> codebase. The events and payloads below match `server/socket.js` exactly.

---

### Client → Server Events

#### join_restaurant

Subscribe to all events for a restaurant (owner dashboard, live monitor). Requires the
restaurant owner's own access token — the socket is disconnected if `token` doesn't
decode to role `restaurant_owner`, or that user doesn't own `restaurantId`.

```js
socket.emit('join_restaurant', { restaurantId: '664abc...', token: ownerAccessToken });
```

| Field | Type |
|-------|------|
| `restaurantId` | string |
| `token` | string — the owner's `accessToken` |

---

#### join_kitchen

Subscribe to kitchen display events for a restaurant. Requires a staff token whose
decoded role is `chef` and whose `restaurantId` matches.

```js
socket.emit('join_kitchen', { restaurantId: '664abc...', staffToken: chefStaffToken });
```

---

#### join_waiter

Subscribe to events for a specific waiter at a restaurant. Requires a staff token whose
decoded role is `waiter` and whose `restaurantId` matches — `staffId` is read from the
token itself, not a separate field.

```js
socket.emit('join_waiter', { restaurantId: '664abc...', staffToken: waiterStaffToken });
```

Joins **two** rooms: `waiter:<restaurantId>:<staffId>` (waiter-specific events) and also
`restaurant:<restaurantId>` (the same restaurant-wide room `join_restaurant` uses) — so a
waiter's socket also receives every restaurant-wide event (`new_order`,
`table_status_changed`, `targeted_offer`, `live_visitor_update`), not only events
addressed to its own waiter room.

---

#### join_order

Subscribe to real-time updates for a specific order — this is what the **customer app**
uses for live order tracking. Requires the customer's own access token; the socket is
disconnected unless the token decodes to the same `userId` the order belongs to (i.e. you
can only join your own orders' rooms).

```js
socket.emit('join_order', { orderId: '664ord...', token: customerAccessToken });
```

| Field | Type |
|-------|------|
| `orderId` | string |
| `token` | string — the customer's `accessToken` |

---

#### join_partner

Subscribe to order-offer events for a delivery partner (used by the Delivery-Partner
app, not the customer app). Requires the partner's own access token; also registers the
partner as online-and-reachable for auto-assignment (`live:active_partners`).

```js
socket.emit('join_partner', { token: partnerAccessToken });
```

---

### Server → Client Events

#### new_order

Emitted to: `restaurant:<restaurantId>`, `kitchen:<restaurantId>`

Triggered when a new order is placed.

```json
{
  "order": {
    "_id": "664ord...",
    "type": "dine_in",
    "status": "placed",
    "items": [ ... ],
    "subtotal": 560,
    "createdAt": "2026-06-17T13:15:00.000Z"
  }
}
```

---

#### order_status_updated

Emitted to: `restaurant:<restaurantId>`, `kitchen:<restaurantId>`, `waiter:<restaurantId>:<staffId>`, `order:<orderId>`

Triggered on every kitchen status change.

```json
{
  "orderId": "664ord...",
  "status": "confirmed",
  "updatedAt": "2026-06-17T13:17:00.000Z"
}
```

---

#### veg_fleet_status_updated

Emitted to: `order:<orderId>`

Triggered whenever `Order.vegFleetAssignmentStatus` changes — order placement (if
`vegFleetOptIn` was honored), `POST .../veg-fleet/keep-waiting`, `POST
.../veg-fleet/fallback`, the background auto-extend sweep, or a delivery partner
accepting the order. Lets the customer's tracking screen (screen 23) update live instead
of polling `GET /api/orders/:id/veg-fleet/status`.

```json
{
  "orderId": "664ord...",
  "status": "searching",
  "remainingSeconds": 142
}
```

Same `status`/`remainingSeconds` semantics as the REST endpoint above.

---

#### partner_location_updated

Emitted to: `order:<orderId>`

Triggered by the delivery partner's own location-ping endpoint
(`POST /api/partner/location`), for whichever order that partner is currently
`deliveryAssignment.status: "picked_up"` on, if any — i.e. only while actively en route
to the customer, not during the earlier assigned-but-not-yet-picked-up leg. Live-only:
no location history is persisted anywhere, matching this codebase's existing
`LOCATION_FRESHNESS_SECONDS` precedent of only ever trusting the single latest ping.

```json
{
  "orderId": "664ord...",
  "lat": 19.076,
  "lng": 72.8777
}
```

Powers the live-moving rider marker on screen 24's map. Combine with
[Get Order Tracking](#customer--order-tracking)'s `etaMinutes` (which the client should
re-derive or re-fetch as the position updates, since this event carries only the raw
coordinates, not a recomputed ETA).

---

#### order_offer

Emitted to: `partner:<partnerId>`

Triggered when `autoAssign` (`services/deliveryAssignment.service.js`) selects this
partner as the best eligible candidate for a delivery order — on kitchen confirm, on
offer-expiry reassignment, or on veg-fleet fallback. This is the event the
[`join_partner`](#join_partner) room exists for. Has a `countdownSeconds`-second
acceptance window before the offer expires and reassigns to the next candidate.

```json
{
  "orderId": "664ord...",
  "restaurantName": "Spice Villa",
  "restaurantAddress": "12 MG Road, Bengaluru",
  "fleetType": "standard",
  "vegFleetOptIn": false,
  "dedicatedBagRequired": false,
  "deliveryInstructions": "Ring the bell twice",
  "pickupKm": 1.4,
  "dropKm": 3.2,
  "totalKm": 4.6,
  "fare": 40,
  "payment": "cod",
  "codAmount": 560,
  "items": [ { "name": "Butter Chicken", "qty": 2 } ],
  "customerName": "Amir",
  "customerAddress": "45 Residency Rd, Bengaluru",
  "customerEtaMin": null,
  "pickupEtaMin": null,
  "countdownSeconds": 20
}
```

Same payload shape `GET /api/partner/orders/current` returns under `kind: "offer"`.
`pickupKm`/`customerEtaMin`/`pickupEtaMin` are `null` whenever the partner's own location
ping isn't fresh (< 120s old).

---

#### bill_updated

Emitted to: `table:<tableId>`

Triggered when a bill is assembled or updated (`services/notify.service.js`).

```json
{
  "billId": "664bill...",
  "grandTotal": 1416,
  "discountsApplied": [],
  "lastBatch": { "batchNumber": 2, "items": [ "..." ] }
}
```

There is no nested `bill` object and no `subtotal`/`taxAmount`/`status` fields on this
event — only `billId`, `grandTotal`, `discountsApplied` (array, matching `Bill`'s real
schema shape), and `lastBatch` (the most recently added batch). For the full bill detail,
call `GET .../sessions/:sessionId/bill`.

---

#### table_status_changed

Emitted to: `restaurant:<restaurantId>`

Triggered when a table's bill is paid (`sessionStatus: "paid"`) or when the table's QR
code is voided by the owner (`sessionStatus: "qr_voided"`, from
`PATCH .../tables/:tableId/qr/void`) — **not** on table-session open, and the field name
is `sessionStatus`, not `status`.

```json
{
  "tableId": "664tbl...",
  "identifier": "T3",
  "sessionStatus": "paid"
}
```

---

#### live_visitor_update

Emitted to: `restaurant:<restaurantId>` every 30 seconds automatically.

```json
{
  "restaurantId": "664abc...",
  "activeVisitors": 23,
  "openSessions": 7,
  "pendingOrders": 12,
  "gmv": 18450.50
}
```

Note: the event name is `live_visitor_update`, not `live_stats`, and the revenue field is
`gmv`, not `todayGMV`.

---

#### targeted_offer

Emitted to: `restaurant:<restaurantId>`

Triggered when the owner creates a targeted offer via live monitor.

```json
{
  "discountId": "664disc...",
  "code": "FLASH10",
  "offerName": "Flash 10% Off — Next 30 mins"
}
```

The payload is flat — there is no nested `discount` object, and `type`/`percentage`/
`endDate` are not sent. Fetch the discount by `discountId` if those details are needed
client-side.

---

## Common Patterns

### Axios setup (customer/owner app)

```js
import axios from 'axios';

const api = axios.create({ baseURL: 'http://localhost:3000/api', withCredentials: true });

let accessToken = null;

api.interceptors.request.use((config) => {
  if (accessToken) config.headers.Authorization = `Bearer ${accessToken}`;
  return config;
});

api.interceptors.response.use(
  (res) => res,
  async (err) => {
    if (err.response?.status === 401 && err.response?.data?.code === 'TOKEN_EXPIRED') {
      const { data } = await api.post('/auth/refresh');
      accessToken = data.data.accessToken;
      err.config.headers.Authorization = `Bearer ${accessToken}`;
      return api.request(err.config);
    }
    return Promise.reject(err);
  }
);

export function setToken(token) { accessToken = token; }
export default api;
```

### Idempotency key for orders

```js
import { v4 as uuid } from 'uuid';

await api.post('/orders', body, {
  headers: { 'Idempotency-Key': uuid() }
});
```

> **Caveat:** the server's idempotency check (`services/order.service.js`) is a
> check-then-act read-then-write against Redis, not an atomic `SET NX` — it reads the
> cached order id, and only writes the new one back *after* the full order is created.
> Two requests carrying the *same* key that arrive close enough together (e.g. a rapid
> double-submit, or a client retry fired before the first attempt's write completed) can
> both miss the cache and each create a separate, real duplicate order. This pattern
> reliably de-duplicates a retry fired *after* receiving a prior response/timeout, but is
> not a hard guarantee against concurrent identical in-flight requests.

### Kitchen retry on conflict

The server determines `currentStatus` itself — a fresh DB read taken immediately before
the atomic update — it does **not** read any `currentStatus` field from the request body
(the endpoint's schema only defines `newStatus`; anything else sent is silently ignored).
There is nothing for the client to track or resend. A `409 CONCURRENT_UPDATE` can still
occur (a narrow race between another request's write and this one), and a plain retry of
the same call is sufficient:

```js
async function updateOrderStatus(orderId, newStatus, attempt = 0) {
  try {
    await staffApi.patch(
      `/staff/${restaurantId}/kitchen/orders/${orderId}/status`,
      { newStatus }
    );
  } catch (err) {
    if (err.response?.data?.code === 'CONCURRENT_UPDATE' && attempt === 0) {
      // No need to fetch/send currentStatus — the server re-reads it fresh on every
      // call. A bare retry is enough; a second CONCURRENT_UPDATE isn't retried again
      // here to avoid masking a real, persistent conflict.
      return updateOrderStatus(orderId, newStatus, attempt + 1);
    }
    throw err;
  }
}
```
