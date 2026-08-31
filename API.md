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
8. [Customer — Profile](#customer--profile)
9. [Customer — Orders](#customer--orders)
10. [Customer — Reviews](#customer--reviews)
11. [Owner — Authentication](#owner--authentication)
12. [Owner — Restaurant Management](#owner--restaurant-management)
13. [Owner — Staff Management](#owner--staff-management)
14. [Owner — Categories & Subcategories](#owner--categories--subcategories)
15. [Owner — Menu Items](#owner--menu-items)
16. [Owner — Tables & QR](#owner--tables--qr)
17. [Owner — Orders (view only)](#owner--orders-view-only)
18. [Owner — Bills](#owner--bills)
19. [Owner — Discounts](#owner--discounts)
20. [Owner — Loyalty Program](#owner--loyalty-program)
21. [Owner — Dashboard](#owner--dashboard)
22. [Owner — Live Monitor](#owner--live-monitor)
23. [Admin](#admin)
24. [Staff — Authentication](#staff--authentication)
25. [Waiter — Tables & Orders](#waiter--tables--orders)
26. [Kitchen — KDS](#kitchen--kds)
27. [Partner — Authentication](#partner--authentication)
28. [WebSocket Events](#websocket-events)

---

## Base URL & Transport

```
http://localhost:3000/api          (development)
https://your-domain.com/api       (production)
```

All request and response bodies are `application/json` unless the endpoint accepts a file upload (`multipart/form-data`).

---

## Authentication

Each portal has its own login endpoint — a token minted by one portal's login is only ever
usable for that portal's role, and each login endpoint only accepts credentials for its own
role (e.g. an admin account gets `401 INVALID_CREDENTIALS` at `/api/owner/auth/login`, not just
a wrong-role error — the account is treated as if it doesn't exist there).

| Portal | Login endpoint | Role |
|--------|----------------|------|
| Customer | `POST /api/auth/login` | `customer` |
| Restaurant Owner | `POST /api/owner/auth/login` | `restaurant_owner` |
| Super Admin | `POST /api/admin/auth/login` | `admin` |

### Customer / Owner / Admin tokens

Each of the three login endpoints above issues the same shape of token pair:

| Token | Where sent | Lifetime |
|-------|-----------|---------|
| `accessToken` | `Authorization: Bearer <token>` header | 15 min |
| `refreshToken` | `Set-Cookie: refreshToken=...; HttpOnly; SameSite=Strict` | 7 days |

Include the access token on every protected request:

```
Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

`POST /api/auth/refresh` and `POST /api/auth/logout` are shared across all three roles — they
key off the `refreshToken` cookie / access token itself, not off which login endpoint was used.

### Staff token

Obtained from `POST /api/staff/auth/login`. Single long-lived token (8 hours):

```
Authorization: Bearer <staffToken>
```

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

`details` is present only for validation errors and contains field-level messages.

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
| 401 | `UNAUTHORIZED` | No token provided |
| 401 | `INVALID_TOKEN` | Malformed or revoked token |
| 401 | `TOKEN_EXPIRED` | Access token has expired — call `/auth/refresh` |
| 401 | `INVALID_CREDENTIALS` | Wrong email/password or wrong PIN |
| 403 | `FORBIDDEN` | Authenticated but not permitted for this action |
| 403 | `RESTAURANT_NOT_APPROVED` | Restaurant's `approvalStatus` isn't `active` yet — staff/menu-item/category routes are locked until an admin approves it |
| 403 | `NOT_OWNER` | `:restaurantId` in the URL doesn't belong to the authenticated owner |
| 400 | `INVALID_STATE` | Admin store transition not allowed from its current `approvalStatus` (e.g. suspending a non-active store) |
| 404 | `NOT_FOUND` | Resource does not exist |
| 409 | `CONCURRENT_UPDATE` | Kitchen status was changed by another request — retry with the new `currentStatus` |
| 409 | `DUPLICATE` | Unique constraint violated (e.g. duplicate discount code) |
| 429 | `RATE_LIMITED` | Too many requests |
| 500 | `INTERNAL_ERROR` | Unexpected server error |
| 502 | `SMS_PROVIDER_ERROR` | The SMS provider failed to send or validate the OTP |
| 500 | `UPLOAD_FAILED` | Cloudinary upload failed |

---

## Rate Limiting

| Scope | Limit |
|-------|-------|
| Auth endpoints (`/api/auth/*`, `/api/owner/auth/*`, `/api/admin/auth/*`, `/api/staff/auth/*`) | 10 requests / 15 min per IP |
| All other `/api/*` endpoints | 100 requests / 15 min per IP |

Exceeded limits return `429` with `Retry-After` header.

---

## Public — Auth

Customer-only. Restaurant owners sign up at [`POST /api/owner/auth/signup`](#owner--authentication)
instead — admins have no public signup endpoint at all (see [Admin — Authentication](#admin)).

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
  "password": "mypassword123"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Min 2 chars |
| `email` | string | Yes | Valid email |
| `password` | string | Yes | Min 8 chars |

Always creates a `customer` account — there is no `role` field here anymore. This keeps the
customer portal from ever being able to mint a `restaurant_owner` or `admin` account.

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

A `refreshToken` cookie is also set automatically.

---

### Log In

```
POST /api/auth/login
```

**No auth required.** Customer accounts only — a `restaurant_owner` or `admin` email/password
gets `401 INVALID_CREDENTIALS` here (not a role error) even if the password is correct; use
that role's own login endpoint instead.

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

### Send Customer OTP

```
POST /api/auth/customer/otp/send
```

**No auth required.**

**Body**

```json
{
  "phone": "9876543210"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | 10-digit phone number |

**Response `200`**

```json
{
  "status": "success",
  "message": "OTP sent",
  "data": {
    "phone": "9876543210"
  }
}
```

Outside production (`NODE_ENV !== 'production'`), `data` also includes a `devOtp` field with the
generated code, since no real SMS is sent in that mode. In production this field is always
absent — the OTP is delivered via SMS through MessageCentral.

---

### Verify Customer OTP

```
POST /api/auth/customer/otp/verify
```

**No auth required.**

**Body**

```json
{
  "phone": "9876543210",
  "code": "123456",
  "tosAccepted": true
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | 10-digit phone number |
| `code` | string | Yes | 6-digit OTP |
| `tosAccepted` | boolean | Yes | Must be `true` |

**Response `200` / `201`**

```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "user": {
      "_id": "664abc...",
      "phone": "9876543210",
      "role": "customer"
    },
    "accessToken": "eyJ...",
    "isNewUser": false
  }
}
```

`201` + `"Account created"` + `isNewUser: true` on first verification for a phone number that has
no existing account; `200` + `"Login successful"` + `isNewUser: false` otherwise. A `refreshToken`
HttpOnly cookie is also set.

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

**Auth: Bearer token (customer or owner)**

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

**No auth required.**

**Query parameters**

| Param | Type | Example | Notes |
|-------|------|---------|-------|
| `lat` | number | `28.6139` | Required for geo-sort |
| `lng` | number | `77.2090` | Required for geo-sort |
| `radius` | number | `5000` | Meters, default 5000 |
| `cuisine` | string | `"Indian"` | Filter by cuisine type |
| `page` | number | `1` | Default 1 |
| `limit` | number | `20` | Default 20, max 50 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Restaurants",
  "data": {
    "restaurants": [
      {
        "_id": "664abc...",
        "name": "Spice Garden",
        "description": "Authentic Indian cuisine",
        "cuisineType": ["Indian", "Mughlai"],
        "avgRating": 4.3,
        "totalRatings": 128,
        "priceRange": "$$",
        "isOpen": true,
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
        "logo": "https://res.cloudinary.com/..."
      }
    ],
    "total": 42,
    "page": 1,
    "pages": 3
  }
}
```

Results are cached in Redis for 60 seconds.

---

### Get Restaurant

```
GET /api/restaurants/:id
```

**No auth required.**

**Response `200`**

```json
{
  "status": "success",
  "message": "Restaurant",
  "data": {
    "restaurant": {
      "_id": "664abc...",
      "name": "Spice Garden",
      "description": "...",
      "cuisineType": ["Indian"],
      "avgRating": 4.3,
      "totalRatings": 128,
      "priceRange": "$$",
      "isOpen": true,
      "openingHours": {
        "monday": { "open": "09:00", "close": "22:00" },
        "tuesday": { "open": "09:00", "close": "22:00" }
      },
      "address": { ... },
      "location": { ... },
      "logo": "https://...",
      "coverImage": "https://...",
      "ownerId": "664..."
    }
  }
}
```

---

### Get Restaurant Menu

```
GET /api/restaurants/:id/menu
```

**No auth required.**

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
                "image": "https://...",
                "isAvailable": true
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
| `limit` | number | 20 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Reviews",
  "data": {
    "reviews": [
      {
        "_id": "664rev...",
        "userId": { "_id": "664u...", "name": "John" },
        "orderId": "664ord...",
        "rating": 5,
        "comment": "Excellent food and service!",
        "createdAt": "2026-06-17T10:30:00.000Z"
      }
    ],
    "total": 128,
    "page": 1,
    "pages": 7
  }
}
```

---

## Customer — Profile

All routes require `Authorization: Bearer <accessToken>` with role `customer` or `restaurant_owner`.

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
          "label": "Home",
          "street": "45 Park Lane",
          "city": "Mumbai",
          "state": "Maharashtra",
          "pincode": "400001",
          "location": { "coordinates": [72.8777, 19.0760] }
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
  "phone": "+919876543210"
}
```

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

### Add Saved Address

```
POST /api/users/me/addresses
```

**Body**

```json
{
  "label": "Office",
  "street": "100 Business Park",
  "city": "Bangalore",
  "state": "Karnataka",
  "pincode": "560001",
  "location": { "coordinates": [77.5946, 12.9716] }
}
```

`label` accepts any string (e.g. `"Home"`, `"Office"`, `"Parents' Place"`). Defaults to `"home"` if omitted.

**Response `201`**

```json
{
  "status": "success",
  "message": "Address added",
  "data": {
    "user": { ... }
  }
}
```

---

### Remove Saved Address

```
DELETE /api/users/me/addresses/:addrId
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Address removed",
  "data": null
}
```

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
  "specialInstructions": "Extra spicy please"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `restaurantId` | string | Yes | MongoDB ObjectId |
| `type` | `"delivery"` | Yes | Customer orders are always delivery |
| `items` | array | Yes | Min 1 item |
| `items[].menuItemId` | string | Yes | |
| `items[].quantity` | number | Yes | Min 1 |
| `deliveryAddress` | object | Yes | |
| `specialInstructions` | string | No | |

**Response `201`** (or `200` if idempotency key matched)

```json
{
  "status": "success",
  "message": "Order placed",
  "data": {
    "order": {
      "_id": "664ord...",
      "restaurantId": "664abc...",
      "customerId": "664u...",
      "type": "delivery",
      "status": "placed",
      "items": [
        {
          "menuItemId": "664item...",
          "name": "Tomato Soup",
          "price": 120,
          "quantity": 2,
          "subtotal": 240
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

Item prices are **snapshotted** at order creation — future menu price changes do not affect this order.

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
    "orders": [ { ... } ],
    "total": 15,
    "page": 1,
    "pages": 1
  }
}
```

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
      "createdAt": "..."
    }
  }
}
```

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

## Owner — Authentication

The owner portal has its own signup and login, separate from `/api/auth/*` — an owner account
can never log in at the customer endpoint, and vice versa (see [Authentication](#authentication)).

**The approval flow:**

1. `POST /api/owner/auth/signup` — create the owner account (no approval needed for this step).
2. `POST /api/owner/restaurants` — submit a restaurant profile. This is unrestricted too; it's
   the application itself, created with `approvalStatus: "pending"`.
3. An admin reviews it and calls `PATCH /api/admin/stores/:id/approve` (or `/reject`) — see
   [Approve Store](#approve-store).
4. Only once `approvalStatus` is `"active"` can the owner create staff
   (`POST /api/owner/:restaurantId/staff`) or build out the menu
   (`POST /api/owner/:restaurantId/categories`, `POST /api/owner/:restaurantId/menu-items`).
   Before that, all three return `403 RESTAURANT_NOT_APPROVED`. Viewing/editing the restaurant's
   own profile (`/restaurant`, `/settings`) is allowed at any approval status, so the owner can
   finish filling out their profile while waiting on review.

### Sign Up

```
POST /api/owner/auth/signup
```

**No auth required.**

**Body**

```json
{
  "name": "Amir Suhail",
  "email": "owner@example.com",
  "password": "mypassword123",
  "phone": "9876543210"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `name` | string | Yes | Min 2 chars |
| `email` | string | Yes | Valid email |
| `password` | string | Yes | Min 8 chars |
| `phone` | string | No | |

Always creates a `restaurant_owner` account.

**Response `201`**

```json
{
  "status": "success",
  "message": "Account created — add a restaurant to begin admin review",
  "data": {
    "user": {
      "_id": "664abc...",
      "name": "Amir Suhail",
      "email": "owner@example.com",
      "role": "restaurant_owner"
    },
    "accessToken": "eyJ..."
  }
}
```

A `refreshToken` cookie is also set automatically.

---

### Log In

```
POST /api/owner/auth/login
```

**No auth required.** Restaurant-owner accounts only — a `customer` or `admin` email/password
gets `401 INVALID_CREDENTIALS` here, not a role error.

**Body**

```json
{
  "email": "owner@example.com",
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
      "email": "owner@example.com",
      "role": "restaurant_owner"
    },
    "accessToken": "eyJ..."
  }
}
```

A `refreshToken` HttpOnly cookie is set.

---

### Log Out

```
POST /api/owner/auth/logout
```

**Requires**: `Authorization: Bearer <accessToken>` with role `restaurant_owner`.

Blacklists the access token and clears the `refreshToken` cookie. Behaves identically to
[`POST /api/auth/logout`](#log-out) — provided here too so the owner portal is fully
self-contained.

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
| `name` | Yes | |
| `location.coordinates` | Yes | `[longitude, latitude]` — GeoJSON order |
| others | No | |

Always created with `approvalStatus: "pending"` — no approval is needed to submit this, it
*is* the submission. See [Owner — Authentication](#owner--authentication) for the full flow.

**Response `201`**

---

Base path for all scoped routes: `/api/owner/:restaurantId`. Viewing/editing the profile below
is allowed regardless of `approvalStatus`; staff and menu routes further down are not (see
[Owner — Staff Management](#owner--staff-management) and [Owner — Categories & Subcategories](#owner--categories--subcategories)).

### Get / Update Restaurant Profile

```
GET   /api/owner/:restaurantId/restaurant
PATCH /api/owner/:restaurantId/restaurant
```

`PATCH` body: any subset of `name`, `description`, `cuisineTypes`, `address`, `location`, `isActive`.

---

### Get / Update Settings (name, logo, banner)

```
GET   /api/owner/:restaurantId/settings
PATCH /api/owner/:restaurantId/settings
```

`PATCH` accepts `multipart/form-data`. Optional file fields: `logo` and `banner` (both max 5 MB, images only). JSON fields: `name`, `description`, `cuisineTypes`, `address`, `settings`.

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

**PATCH body**

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

**Requires the restaurant to be approved** — every route below (including `GET`) returns
`403 RESTAURANT_NOT_APPROVED` until an admin sets `approvalStatus` to `"active"` via
`PATCH /api/admin/stores/:id/approve`. See [Owner — Authentication](#owner--authentication).

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
      { "_id": "664s...", "name": "Ravi Kumar", "role": "waiter", "email": "ravi@x.com", "isActive": true }
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

**Requires the restaurant to be approved** — every route below (including `GET`) returns
`403 RESTAURANT_NOT_APPROVED` until an admin sets `approvalStatus` to `"active"` via
`PATCH /api/admin/stores/:id/approve`. See [Owner — Authentication](#owner--authentication).

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
        "sortOrder": 1,
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
  "sortOrder": 1
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
  "sortOrder": 2,
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
  "message": "Subcategories",
  "data": {
    "subCategories": [
      {
        "_id": "664sub...",
        "categoryId": "664cat...",
        "name": "Soups",
        "sortOrder": 1
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
  "sortOrder": 1
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

**Requires the restaurant to be approved** — every route below (including `GET`) returns
`403 RESTAURANT_NOT_APPROVED` until an admin sets `approvalStatus` to `"active"` via
`PATCH /api/admin/stores/:id/approve`. See [Owner — Authentication](#owner--authentication).

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
        "ingredients": ["tomato", "cream"],
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
| `ingredients` | JSON array string | No | e.g. `'["tomato","cream"]'` |
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
  "ingredients": ["tomato", "basil", "mozzarella"]
}
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Ingredients updated",
  "data": {
    "item": { ... }
  }
}
```

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

**Response `200`** — `data: null`

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
| `type` | `"dine_in"` \| `"delivery"` | (all) | |
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
| `status` | `"open"` \| `"paid"` | Filter |
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
        "taxAmount": 135,
        "discountAmount": 50,
        "grandTotal": 835,
        "status": "paid",
        "paymentMethod": "upi",
        "paidAt": "2026-06-17T13:00:00.000Z"
      }
    ]
  }
}
```

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
| `applicableItems` | ObjectId[] | No | |

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
      "isActive": true,
      "pointsPerRupee": 1,
      "redemptionRate": 0.5,
      "minimumRedemption": 100
    }
  }
}
```

---

### Update Loyalty Program

```
PATCH /api/owner/:restaurantId/loyalty
```

Upserts — safe to call even if no program exists yet.

**Body**

```json
{
  "isActive": true,
  "pointsPerRupee": 2,
  "redemptionRate": 0.5,
  "minimumRedemption": 200
}
```

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
| `freeItemId` | ObjectId | Required when `rewardType` is `"free_item"` |
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
GET /api/owner/:restaurantId/dashboard?period=today
```

**Response `200`**

```json
{
  "status": "success",
  "message": "KPIs",
  "data": {
    "revenue": 12450.00,
    "orders": 87,
    "avgOrderValue": 143.10,
    "dineIn": 54,
    "delivery": 33,
    "cancelledOrders": 3,
    "newCustomers": 12,
    "period": "today"
  }
}
```

---

### Sales Chart

```
GET /api/owner/:restaurantId/dashboard/sales?period=week
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Sales chart",
  "data": {
    "labels": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
    "revenue": [1200, 980, 1450, 1100, 1800, 2300, 1620],
    "orders": [10, 8, 12, 9, 15, 19, 14]
  }
}
```

---

### Top Items

```
GET /api/owner/:restaurantId/dashboard/top-items?period=month
```

**Response `200`**

```json
{
  "status": "success",
  "message": "Top items",
  "data": {
    "items": [
      {
        "menuItemId": "664item...",
        "name": "Butter Chicken",
        "totalQuantity": 234,
        "totalRevenue": 46800
      }
    ]
  }
}
```

---

### Recent Orders

```
GET /api/owner/:restaurantId/dashboard/recent-orders
```

Returns last 10 orders.

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
    "activeVisitors": 23,
    "openSessions": 7,
    "pendingOrders": 12,
    "todayGMV": 18450.50
  }
}
```

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
    "visitors": [
      {
        "userId": "664u...",
        "name": "Rahul K",
        "lastSeen": 1718617800,
        "tableId": "664tbl..."
      }
    ]
  }
}
```

Visitors expire from Redis after 5 minutes of inactivity.

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
        "_id": "664u...",
        "name": "Priya S",
        "email": "priya@example.com",
        "orderCount": 8
      }
    ]
  }
}
```

---

### Create Targeted Offer

```
POST /api/owner/:restaurantId/live-monitor/offer
```

Creates a discount and broadcasts it in real time to all active visitors via Socket.IO.

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

Same body schema as `POST /api/owner/:restaurantId/discounts`.

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

All admin routes require `Authorization: Bearer <accessToken>` with role `admin`, and live under `/api/admin`. Any other role gets `403 FORBIDDEN`. Every state-changing action is recorded in an internal activity log (`adminId`, `action`, `targetType`, `targetId`, `metadata`) — not exposed via its own endpoint yet.

Every list endpoint below (`stores`, `customers`, `delivery-partners`, `tickets`) shares the same pagination shape — `?page=&limit=` in, `{ ..., total, page, pages }` out — so a single `usePaginatedQuery` hook can drive all four admin tables.

### Admin — Authentication

```
POST /api/admin/auth/login
```

**No auth required.** Admin accounts only — a `customer` or `restaurant_owner` email/password
gets `401 INVALID_CREDENTIALS` here, not a role error.

**There is no public admin signup endpoint.** Admin accounts are provisioned via
`scripts/seedSuperAdmin.js <email> <password>` (run against the target `MONGODB_URI`) or, once
one admin exists, could be created by another admin through a future internal endpoint.

**Body**

```json
{
  "email": "admin@example.com",
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
      "name": "Super Admin",
      "email": "admin@example.com",
      "role": "admin"
    },
    "accessToken": "eyJ..."
  }
}
```

A `refreshToken` HttpOnly cookie is set.

```
POST /api/admin/auth/logout
```

**Requires**: `Authorization: Bearer <accessToken>` with role `admin`. Blacklists the access
token and clears the `refreshToken` cookie.

---

### Quick Reference

| Method | Path | Body | Description |
|--------|------|------|--------------|
| `POST` | `/api/admin/auth/login` | `{ email, password }` | [Admin login](#admin--authentication) |
| `GET` | `/api/admin/dashboard` | — | [Platform KPI totals](#platform-overview) |
| `GET` | `/api/admin/dashboard/revenue-overview?range=` | — | [Revenue chart points](#revenue-overview) |
| `GET` | `/api/admin/reports/top-stores?limit=` | — | [Top stores by revenue](#top-stores) |
| `GET` | `/api/admin/reports/top-delivery-partners?limit=` | — | [Top delivery partners by deliveries](#top-delivery-partners) |
| `GET` | `/api/admin/stores?status=&plan=&search=&page=&limit=` | — | [List stores + tab counts](#list-stores) |
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
    "stores": [ { "_id": "664abc...", "name": "Spice Garden", "approvalStatus": "pending", "plan": "trial", "ownerId": { "_id": "664u...", "name": "Amir", "email": "amir@x.com", "phone": "+91..." } } ],
    "total": 42,
    "page": 1,
    "pages": 3,
    "statusCounts": { "pending": 5, "active": 30, "suspended": 2, "rejected": 3, "expired": 2 }
  }
}
```

`statusCounts` powers the All / Pending / Active / Suspended / Expired / Rejected tab counts and is computed over the full collection, independent of `status`/`plan`/`search` filters.

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
| `page` | number | Default 1 |
| `limit` | number | Default 20 |

**Response `200`**

```json
{
  "status": "success",
  "message": "Customers",
  "data": {
    "customers": [ { "_id": "664u...", "name": "Priya S", "email": "priya@x.com", "phone": "+91...", "isActive": true } ],
    "total": 500,
    "page": 1,
    "pages": 25
  }
}
```

`passwordHash` is explicitly excluded via `.select('-passwordHash')` (results are `.lean()`, which bypasses the schema's `toJSON` stripping).

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

Hard delete — no other collection references `DeliveryPartner` yet. Logs `DELIVERY_PARTNER_REMOVED` before deleting.

**Response `200`** — `data: null`

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
| `category` | `"billing"` \| `"technical"` \| `"account"` \| `"delivery"` \| `"other"` |
| `page` / `limit` | number |

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
  "pin": "1234"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `restaurantId` | string | Yes | ObjectId |
| `pin` | string | Yes | 4–8 digits |

**Response `200`**

```json
{
  "status": "success",
  "message": "Staff login successful",
  "data": {
    "staff": {
      "_id": "664staff...",
      "name": "Ravi Kumar",
      "role": "waiter",
      "restaurantId": "664abc..."
    },
    "staffToken": "eyJ..."
  }
}
```

The PIN is verified with argon2id. The same generic error (`401 UNAUTHORIZED`) is returned whether the restaurant doesn't exist or the PIN is wrong — no user enumeration.

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

All waiter routes require `Authorization: Bearer <staffToken>` with role `waiter`.

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

| Field | Type | Required |
|-------|------|----------|
| `tableSessionId` | string | Yes |
| `items` | array | Yes, min 1 |
| `items[].menuItemId` | string | Yes |
| `items[].quantity` | number | Yes, min 1 |
| `specialInstructions` | string | No |

**Response `201`** (or `200` if idempotency key matched)

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
          "subtotal": 700
        }
      ],
      "subtotal": 820,
      "specialInstructions": "No onions please",
      "createdAt": "2026-06-17T13:15:00.000Z"
    }
  }
}
```

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
      "tableSessionId": "664sess...",
      "restaurantId": "664abc...",
      "items": [
        {
          "name": "Butter Chicken",
          "quantity": 2,
          "unitPrice": 350,
          "subtotal": 700
        }
      ],
      "subtotal": 1200,
      "taxRate": 0.18,
      "taxAmount": 216,
      "discountAmount": 0,
      "grandTotal": 1416,
      "status": "open"
    }
  }
}
```

A `bill_updated` Socket.IO event is emitted to the table room when the bill is assembled.

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
      "status": "paid",
      "paymentMethod": "upi",
      "paidAt": "2026-06-17T14:00:00.000Z",
      "grandTotal": 1416
    }
  }
}
```

A `table_status_changed` Socket.IO event is emitted to the restaurant room.

---

## Kitchen — KDS

All kitchen routes require `Authorization: Bearer <staffToken>` with role `chef`.

Base path: `/api/staff/:restaurantId/kitchen`

### Get Order Queue

```
GET /api/staff/:restaurantId/kitchen/queue
```

Returns active orders (status: `placed` or `confirmed`) sorted by creation time ascending.

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

Returns orders grouped by status for the Kanban board view.

**Response `200`**

```json
{
  "status": "success",
  "message": "Kitchen board",
  "data": {
    "placed": [ { ... } ],
    "confirmed": [ { ... } ],
    "preparing": [ { ... } ],
    "ready": [ { ... } ]
  }
}
```

---

### Update Order Status

```
PATCH /api/staff/:restaurantId/kitchen/orders/:orderId/status
```

Uses optimistic concurrency control — you must send the status you currently see to prevent conflicts.

**Body**

```json
{
  "currentStatus": "placed",
  "newStatus": "confirmed"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `currentStatus` | string | Yes | The status the client currently sees |
| `newStatus` | string | Yes | The desired next status |

**Allowed transitions**

| From | To (allowed values) |
|------|---------------------|
| `placed` | `confirmed`, `cancelled` |
| `confirmed` | `preparing`, `cancelled` |
| `preparing` | `ready`, `cancelled` |
| `ready` | `out_for_delivery`, `delivered`, `cancelled` |

**Response `200`**

```json
{
  "status": "success",
  "message": "Order status updated",
  "data": {
    "order": {
      "_id": "664ord...",
      "status": "confirmed",
      "updatedAt": "2026-06-17T13:12:00.000Z"
    }
  }
}
```

**Response `409`** — if `currentStatus` no longer matches (another client updated it first)

```json
{
  "status": "error",
  "code": "CONCURRENT_UPDATE",
  "message": "Order status was modified by another request. Refresh and retry."
}
```

An `order_status_updated` Socket.IO event is emitted to kitchen, waiter, restaurant, and order rooms on success.

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

## Partner — Authentication

Delivery partner phone/OTP login. This section covers only the OTP endpoints — the rest of the
delivery-partner backend (onboarding, duty, orders, earnings, etc.) is not yet documented here.

### Request OTP

```
POST /partner/auth/request-otp
```

**No auth required.**

**Body**

```json
{
  "phone": "9876543210"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | 10-digit phone number |

**Response `200`**

```json
{
  "status": "success",
  "message": "OTP sent",
  "data": {
    "phone": "9876543210"
  }
}
```

Outside production, `data` also includes a `devOtp` field (no real SMS in that mode) — same
convention as `POST /api/auth/customer/otp/send`.

---

### Verify OTP

```
POST /partner/auth/verify-otp
```

**No auth required.**

**Body**

```json
{
  "phone": "9876543210",
  "otp": "123456"
}
```

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `phone` | string | Yes | 10-digit phone number |
| `otp` | string | Yes | 6-digit OTP |

**Response `200`**

```json
{
  "status": "success",
  "message": "Login successful",
  "data": {
    "partner": {
      "_id": "664abc...",
      "phone": "9876543210",
      "verificationStatus": "pending_documents",
      "status": "inactive"
    },
    "accessToken": "eyJ...",
    "refreshToken": "eyJ..."
  }
}
```

A brand-new phone number auto-creates a partner record (`verificationStatus: "pending_documents"`,
`status: "inactive"`) — full onboarding (name, vehicle, bank, documents) happens in later, separate
steps. `401 ACCOUNT_SUSPENDED` if the partner's `status` is `"suspended"`.

---

## WebSocket Events

Connect using Socket.IO client:

```js
import { io } from 'socket.io-client';

const socket = io('http://localhost:3000', {
  auth: { token: 'eyJ...' }   // access token or staff token
});
```

### Rooms

After connecting, the client must emit `join` events to receive targeted updates.

---

### Client → Server Events

#### join_restaurant

Subscribe to all events for a restaurant (owner dashboard, live monitor).

```js
socket.emit('join_restaurant', { restaurantId: '664abc...' });
```

| Field | Type |
|-------|------|
| `restaurantId` | string |

---

#### join_kitchen

Subscribe to kitchen display events for a restaurant.

```js
socket.emit('join_kitchen', { restaurantId: '664abc...' });
```

---

#### join_waiter

Subscribe to events for a specific waiter at a restaurant.

```js
socket.emit('join_waiter', {
  restaurantId: '664abc...',
  staffId: '664staff...'
});
```

---

#### join_order

Subscribe to real-time updates for a specific order (useful for customer tracking).

```js
socket.emit('join_order', { orderId: '664ord...' });
```

---

#### join_table

Subscribe to table-level events (bill updates, status changes).

```js
socket.emit('join_table', { tableId: '664tbl...' });
```

---

#### track_visitor

Register the current user as an active visitor for a restaurant (used by customer app for live monitor).

```js
socket.emit('track_visitor', {
  restaurantId: '664abc...',
  userId: '664u...',
  tableId: '664tbl...'    // optional
});
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

#### bill_updated

Emitted to: `table:<tableId>`

Triggered when a bill is assembled or updated.

```json
{
  "bill": {
    "_id": "664bill...",
    "subtotal": 1200,
    "taxAmount": 216,
    "discountAmount": 0,
    "grandTotal": 1416,
    "status": "open"
  }
}
```

---

#### table_status_changed

Emitted to: `restaurant:<restaurantId>`

Triggered when a table session opens or closes (payment received).

```json
{
  "tableId": "664tbl...",
  "identifier": "T3",
  "status": "available"
}
```

---

#### live_stats

Emitted to: `restaurant:<restaurantId>` every 30 seconds automatically.

```json
{
  "activeVisitors": 23,
  "openSessions": 7,
  "pendingOrders": 12,
  "todayGMV": 18450.50
}
```

---

#### targeted_offer

Emitted to: `restaurant:<restaurantId>`

Triggered when the owner creates a targeted offer via live monitor.

```json
{
  "discount": {
    "_id": "664disc...",
    "offerName": "Flash 10% Off — Next 30 mins",
    "type": "percentage",
    "percentage": 10,
    "endDate": "2026-06-17T14:30:00.000Z"
  }
}
```

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

### Kitchen OCC retry

```js
async function updateOrderStatus(orderId, currentStatus, newStatus) {
  try {
    await staffApi.patch(
      `/staff/${restaurantId}/kitchen/orders/${orderId}/status`,
      { currentStatus, newStatus }
    );
  } catch (err) {
    if (err.response?.data?.code === 'CONCURRENT_UPDATE') {
      // Refresh order, get the new currentStatus, retry once
      const { data } = await staffApi.get(
        `/staff/${restaurantId}/kitchen/orders/${orderId}`
      );
      await staffApi.patch(
        `/staff/${restaurantId}/kitchen/orders/${orderId}/status`,
        { currentStatus: data.data.order.status, newStatus }
      );
    } else throw err;
  }
}
```
