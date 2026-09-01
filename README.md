# YuloStores — Backend Server

REST API + real-time WebSocket server for the YuloStores restaurant platform. Handles customer ordering, dine-in table sessions, kitchen display, owner dashboards, and live monitoring.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+ (ES Modules) |
| Framework | Express 5 |
| Database | MongoDB 7+ via Mongoose 8 |
| Cache / Pub-Sub | Redis 7+ via ioredis |
| Real-time | Socket.IO 4 |
| Auth | JWT (jsonwebtoken) + argon2 password/PIN hashing |
| Validation | Zod 4 |
| File uploads | Multer (memory storage) → Cloudinary |
| Logging | Pino + pino-http |
| QR codes | qrcode → Cloudinary |

---

## Prerequisites

Before cloning, make sure the following are installed and running:

- **Node.js** 20 or later — `node -v`
- **MongoDB** 7+ running locally on port 27017 — `mongod --version`
- **Redis** 7+ running locally on port 6379 — `redis-server --version`
- A **Cloudinary** account (free tier is fine) for image and QR uploads
- Optional: **Razorpay** account for online payment integration

---

## Local Setup

### 1. Clone and enter the server directory

```bash
git clone <repo-url>
cd YuloStores/server
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create the environment file

Copy the example and fill in your values:

```bash
cp .env.example .env   # or create .env manually (see below)
```

Edit `.env`:

```env
NODE_ENV=development
PORT=3000

# MongoDB — use your local instance or a MongoDB Atlas URI
MONGODB_URI=mongodb://127.0.0.1:27017/yuloStores

# Redis — use your local instance or a Redis Cloud URI
REDIS_URL=redis://127.0.0.1:6379

# JWT secrets — must each be at least 32 characters
JWT_ACCESS_SECRET=change_this_to_a_long_random_string_32chars
JWT_REFRESH_SECRET=change_this_to_another_long_random_string_32
JWT_STAFF_SECRET=change_this_to_yet_another_random_string_32ch

# JWT expiry windows
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
JWT_STAFF_EXPIRES=8h

# Cloudinary — required for image uploads and QR code generation
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret

# Google Maps — used for delivery geo queries (optional in dev)
GOOGLE_MAPS_API_KEY=

# Razorpay — optional; online payment returns clientSecret=null if not set
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=

# CORS — comma-separated list of allowed frontend origins
ALLOWED_ORIGINS=http://localhost:5173

# Customer app base URL — used for QR code deep links
CUSTOMER_APP_URL=http://localhost:5173
```

> **Tip:** Generate secrets with `node -e "console.log(require('crypto').randomBytes(40).toString('hex'))"`

### 4. Start the server

Development (auto-restarts on file changes):

```bash
npm run dev
```

Production:

```bash
npm start
```

### 5. Verify it's running

```bash
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}
```

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `NODE_ENV` | No | `development` / `production` / `test` |
| `PORT` | No | HTTP port (default `3000`) |
| `MONGODB_URI` | **Yes** | Full MongoDB connection string |
| `REDIS_URL` | **Yes** | Full Redis connection string |
| `JWT_ACCESS_SECRET` | **Yes** | Min 32 chars — signs customer access tokens |
| `JWT_REFRESH_SECRET` | **Yes** | Min 32 chars — signs customer refresh tokens |
| `JWT_STAFF_SECRET` | **Yes** | Min 32 chars — signs staff (waiter/chef) tokens |
| `JWT_ACCESS_EXPIRES` | No | Access token TTL (default `15m`) |
| `JWT_REFRESH_EXPIRES` | No | Refresh token TTL (default `7d`) |
| `JWT_STAFF_EXPIRES` | No | Staff token TTL (default `8h`) |
| `CLOUDINARY_CLOUD_NAME` | **Yes** | Cloudinary cloud name |
| `CLOUDINARY_API_KEY` | **Yes** | Cloudinary API key |
| `CLOUDINARY_API_SECRET` | **Yes** | Cloudinary API secret |
| `GOOGLE_MAPS_API_KEY` | No | Geocoding of restaurant addresses; falls back to OpenStreetMap Nominatim when unset |
| `RAZORPAY_KEY_ID` | No | Razorpay key (online payments optional) |
| `RAZORPAY_KEY_SECRET` | No | Razorpay secret |
| `RAZORPAY_WEBHOOK_SECRET` | No | For verifying payment webhooks |
| `ALLOWED_ORIGINS` | No | Comma-separated CORS origins |
| `CUSTOMER_APP_URL` | No | Base URL embedded in QR codes |

> **Startup validation:** Zod validates every required variable on boot. If any are missing or malformed, the server prints the exact field names and exits — no silent failures.

---

## API Overview

All JSON responses share a common envelope:

```json
// Success
{ "status": "success", "message": "...", "data": { ... } }

// Error
{ "status": "error", "code": "ERROR_CODE", "message": "Human-readable message" }
```

### Authentication — `/api/auth`

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/auth/signup` | Register a new customer or restaurant owner |
| `POST` | `/api/auth/login` | Login; returns access token + sets `refreshToken` cookie |
| `POST` | `/api/auth/refresh` | Issue a new access token from the refresh cookie |
| `POST` | `/api/auth/logout` | Blacklist the access token in Redis, clear cookie |

**Signup / Login body:**
```json
{ "name": "Jane", "email": "jane@example.com", "password": "min8chars", "role": "customer" }
```
Role can be `customer` or `restaurant_owner`.

**Auth header for protected routes:**
```
Authorization: Bearer <accessToken>
```

### Public Restaurant Routes — `/api/restaurants`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/restaurants?lat=&lng=&radius=5&page=1` | Nearby restaurants (geo query, cached 60 s) |
| `GET` | `/api/restaurants?q=burger` | Full-text search |
| `GET` | `/api/restaurants/:id` | Restaurant detail |
| `GET` | `/api/restaurants/:id/menu` | Full menu grouped by category (cached 5 min) |
| `GET` | `/api/restaurants/:id/reviews` | Paginated reviews |

### Customer Routes — `/api`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/users/me` | Customer | Get profile |
| `PATCH` | `/api/users/me` | Customer | Update name / phone / avatar |
| `POST` | `/api/users/me/addresses` | Customer | Add a saved address |
| `DELETE` | `/api/users/me/addresses/:addrId` | Customer | Remove an address |
| `POST` | `/api/orders` | Customer | Place delivery or takeaway order |
| `GET` | `/api/orders` | Customer | Order history (paginated) |
| `GET` | `/api/orders/:id` | Customer | Single order detail |
| `POST` | `/api/orders/:orderId/review` | Customer | Submit a review (delivered orders only) |

### Owner Routes — `/api/owner/:restaurantId/...`

All owner routes require `Authorization: Bearer <ownerToken>` and validate that the token holder owns the restaurant in the URL.

| Prefix | Description |
|---|---|
| `/dashboard` | KPIs, sales chart, top items, recent orders |
| `/restaurant` | Restaurant profile CRUD |
| `/settings` | GST, service charge, logo, banner, operating hours, delivery config |
| `/categories` | Menu categories and sub-categories |
| `/menu-items` | Menu items with image upload, ingredient management, availability toggle |
| `/tables` | Table management, QR code generation and voiding |
| `/orders` | View and manage orders |
| `/bills` | Assemble bills, apply discounts, mark paid |
| `/discounts` | Create/publish/draft/delete discount offers |
| `/loyalty` | Loyalty program config and milestone rewards |
| `/live-monitor` | Active visitors, repeat customers, GMV, targeted offers |

### Staff Routes — `/api/staff`

Staff authenticate with a PIN-based token, not a password.

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/staff/auth/login` | Login with `{ restaurantId, pin }` → returns `staffToken` |
| `POST` | `/api/staff/auth/logout` | Blacklist staff token |

**Waiter routes** (`Authorization: Bearer <staffToken>`, role `waiter`):

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/staff/:restaurantId/waiter/tables/scan` | Scan QR token → open/get table session |
| `GET` | `/api/staff/:restaurantId/waiter/tables` | All tables with open session status |
| `GET` | `/api/staff/:restaurantId/waiter/menu` | Menu (from cache) |
| `POST` | `/api/staff/:restaurantId/waiter/orders` | Place dine-in order batch |
| `GET` | `/api/staff/:restaurantId/waiter/sessions` | Active sessions with running totals |
| `GET` | `/api/staff/:restaurantId/waiter/sessions/:id/bill` | Assemble and return bill |
| `POST` | `/api/staff/:restaurantId/waiter/sessions/:id/bill/mark-paid` | Close session, mark paid |

**Kitchen routes** (`Authorization: Bearer <staffToken>`, role `chef`):

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/staff/:restaurantId/kitchen/queue` | Today's `placed` orders, FIFO |
| `GET` | `/api/staff/:restaurantId/kitchen/board` | Live board: confirmed / preparing / ready |
| `PATCH` | `/api/staff/:restaurantId/kitchen/orders/:id/status` | Advance order status |
| `GET` | `/api/staff/:restaurantId/kitchen/orders/:id` | Order detail |

**Status transition rules:**

```
placed → confirmed → preparing → ready → out_for_delivery | delivered
any status → cancelled
```

---

## WebSocket Events

Connect to the server with Socket.IO. After connecting, emit a join event to subscribe to a room.

### Client → Server (join events)

| Event | Payload | Room joined |
|---|---|---|
| `join_restaurant` | `{ restaurantId, token }` | `restaurant:<id>` (owner dashboard) |
| `join_kitchen` | `{ restaurantId, staffToken }` | `kitchen:<id>` (chef KDS) |
| `join_waiter` | `{ restaurantId, staffToken }` | `restaurant:<id>` + `waiter:<id>:<staffId>` |
| `join_order` | `{ orderId, token }` | `order:<id>` (customer order tracking) |

### Server → Client (emitted events)

| Event | Emitted to | Payload |
|---|---|---|
| `new_order` | restaurant + kitchen | `{ orderId, type, tableNumber, batchNumber, items, subtotal }` |
| `order_status_updated` | restaurant + kitchen + order + waiter | `{ orderId, status, updatedAt }` |
| `bill_updated` | `table:<id>` | `{ billId, grandTotal, discountsApplied, lastBatch }` |
| `table_status_changed` | restaurant | `{ tableId, identifier, sessionStatus }` |
| `live_visitor_update` | restaurant | `{ openSessions, pendingOrders, activeVisitors, gmv }` (every 30 s) |
| `targeted_offer` | restaurant | `{ discountId, code, offerName }` |

---

## Project Structure

```
server/
├── index.js          # Entry point — connects DB/Redis, starts HTTP + Socket.IO
├── app.js            # Express app — middleware stack and route mounts
├── socket.js         # Socket.IO init, room join handlers, 30 s live stats interval
│
├── config/
│   ├── env.js        # Zod-validated process.env — exits on invalid config
│   ├── db.js         # Mongoose connect with exponential-backoff retry
│   └── redis.js      # ioredis client — non-critical, degrades to DB on failure
│
├── models/           # Mongoose schemas
│   ├── User.js       # toJSON strips passwordHash automatically
│   ├── StaffMember.js
│   ├── Restaurant.js # 2dsphere index for geo queries, text index for search
│   ├── Category.js / SubCategory.js / MenuItem.js  # Menu hierarchy
│   ├── Table.js / TableSession.js  # Dine-in session lifecycle
│   ├── Order.js      # Snapshot-based items (price never changes after placement)
│   ├── Bill.js       # Assembled from session batches, discount-aware
│   ├── Discount.js   # draft → active → expired lifecycle
│   ├── LoyaltyProgram.js / LoyaltyMilestone.js
│   └── Review.js     # post-save hook auto-updates Restaurant.avgRating
│
├── routes/
│   ├── auth.routes.js
│   ├── user.routes.js
│   ├── restaurant.routes.js
│   ├── order.routes.js
│   ├── review.routes.js
│   ├── owner/        # All protected by authenticate + authorizeRole + authorizeRestaurant
│   │   ├── index.js  # Mounts all owner sub-routes under /:restaurantId
│   │   └── *.routes.js
│   └── staff/        # Login is public; waiter/kitchen require staffToken
│       ├── index.js
│       └── *.routes.js
│
├── controllers/      # Request/response only — delegates to services
├── services/         # Business logic
│   ├── auth.service.js      # Hash, verify, token generation, blacklist
│   ├── order.service.js     # Idempotency, item snapshots, Mongo transaction for dine-in
│   ├── kitchen.service.js   # KDS queue, board, status transitions with OCC
│   ├── billing.service.js   # Bill assembly, discount application, mark-paid
│   ├── menu.service.js      # Structured menu with 5-min Redis cache
│   ├── cache.service.js     # Redis get/set/invalidate — never throws
│   ├── dashboard.service.js # KPI aggregations (parallel queries)
│   ├── liveMonitor.service.js # Visitor tracking, GMV, repeat customers
│   ├── waiter.service.js    # QR scan, session open/find
│   ├── upload.service.js    # Cloudinary streaming upload from Buffer
│   ├── qr.service.js        # QR code generation → Cloudinary
│   └── notify.service.js    # Socket.IO emit helpers (never throws)
│
├── middleware/
│   ├── authenticate.js         # Verifies customer JWT, checks Redis blacklist
│   ├── authenticateStaff.js    # Verifies staff JWT, checks Redis blacklist
│   ├── authorizeRole.js        # Checks req.user.role
│   ├── authorizeStaffRole.js   # Checks req.staff.role
│   ├── authorizeRestaurant.js  # Confirms owner.ownerId === req.user._id
│   ├── authorizeStaffRestaurant.js  # Confirms staff.restaurantId matches URL param
│   ├── validate.js             # Zod schema → 400 on failure
│   ├── rateLimiter.js          # authLimiter (10/min) + apiLimiter (100/min)
│   ├── upload.js               # Multer memory storage factory
│   └── errorHandler.js         # Unified error → JSON response
│
└── utils/
    ├── logger.js       # Pino with pino-pretty in development
    ├── ApiError.js     # Typed error class (statusCode, code, details)
    ├── ApiResponse.js  # sendSuccess helper
    └── asyncHandler.js # Wraps async controllers — forwards rejections to errorHandler
```

---

## Key Design Decisions

**Idempotency on order placement** — Pass `Idempotency-Key: <uuid>` header with POST `/api/orders` or POST `/api/staff/.../waiter/orders`. The server stores the order ID in Redis for 24 hours keyed to `idem:<key>:<restaurantId>`. Duplicate requests within that window return the original order with HTTP 200 instead of 201.

**Dine-in ordering uses a Mongo transaction** — `batchCount` increment, `Order.create`, and `$push` to the session's orders array all commit atomically. If any step fails, the transaction aborts and the client gets an error with no partial state written.

**Optimistic concurrency on kitchen status** — `findOneAndUpdate({ _id, status: currentStatus }, ...)` acts as a compare-and-swap. If another chef already advanced the status, the filter won't match and the caller gets `409 CONCURRENT_UPDATE` with a prompt to refresh.

**Redis is non-critical** — If Redis is unavailable at startup, `connectRedis` logs a warning and continues. Cache misses fall back to MongoDB. Token blacklisting silently no-ops if Redis is down (acceptable trade-off for availability).

**Price snapshots** — When an order is created, each item's `name` and `price` are copied into the order document. Future menu price changes don't affect historical orders or bills.

---

## Quick Smoke Test

After starting the server, run these in order:

```bash
# 1. Health check
curl http://localhost:3000/health

# 2. Sign up
curl -s -c cookies.txt -X POST http://localhost:3000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{"name":"Test Owner","email":"owner@example.com","password":"password123","role":"restaurant_owner"}'

# 3. Login (copy the accessToken from the response)
curl -s -b cookies.txt -c cookies.txt -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@example.com","password":"password123"}'

# 4. Hit a protected owner route — should return NOT_OWNER (no restaurant yet)
curl http://localhost:3000/api/owner/000000000000000000000001/dashboard \
  -H "Authorization: Bearer <accessToken>"

# 5. Logout and verify blacklist
curl -X POST http://localhost:3000/api/auth/logout -H "Authorization: Bearer <accessToken>"
curl http://localhost:3000/api/users/me -H "Authorization: Bearer <accessToken>"
# → 401 INVALID_TOKEN: Token has been revoked
```
