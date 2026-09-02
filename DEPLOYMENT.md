# Deployment & Environment Configuration

## Why your `.env` files keep disappearing

They are not being deleted by Git, and nothing in this repo removes them.

`.env` is gitignored in both repos and has never been committed, so it never
travels to the server in the first place. The disappearance is a property of
both hosting platforms:

| Platform | What happens on every `git push` |
|---|---|
| DigitalOcean **App Platform** (backend) | Builds a **brand-new container** from the GitHub repo and replaces the running one. Anything you created by hand inside the old container — including a `.env` you wrote via the console — is destroyed with it. Containers are ephemeral; there is no persistent filesystem. |
| **Vercel** (frontend) | Builds from a **fresh checkout** of the repo in a throwaway build container. A `.env` file only exists if it is committed, and it must not be. |

**A `.env` file can never persist on either platform.** The fix is not to
restore the file after each deploy — it is to stop using a file in production
and set the variables in each platform's dashboard, where they are stored by
the platform and re-injected into every new build automatically.

`.env` remains the correct mechanism for **local development only**.

---

## Backend — DigitalOcean App Platform

Set these under **Your App → Settings → App-Level Environment Variables**
(or on the specific component). Anything holding a credential must be saved
with type **`SECRET`** so it is encrypted at rest and hidden in the UI.

### Required — the app exits with code 1 on boot if any is missing

`config/env.js` validates the environment with Zod before the server starts, so
a missing value fails the deploy loudly rather than starting a broken app.

| Variable | Type | Notes |
|---|---|---|
| `MONGODB_URI` | SECRET | Must be a valid URL. Use the connection string from your Managed Mongo cluster. |
| `JWT_ACCESS_SECRET` | SECRET | Minimum 32 characters. |
| `JWT_REFRESH_SECRET` | SECRET | Minimum 32 characters. |
| `JWT_STAFF_SECRET` | SECRET | Minimum 32 characters. |
| `JWT_PARTNER_SECRET` | SECRET | Minimum 32 characters. |

Generate each secret separately — never reuse one across two variables:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

### Required in practice (defaults are dev-only and will break production)

| Variable | Set to | Why |
|---|---|---|
| `NODE_ENV` | `production` | Enables the production Razorpay warning and framework prod paths. |
| `ALLOWED_ORIGINS` | `https://<your-app>.vercel.app,https://<your-domain>` | Comma-separated. Defaults to `http://localhost:5173`, which blocks all browser calls from the deployed frontend (CORS + Socket.IO both read this). |
| `CUSTOMER_APP_URL` | `https://<your-domain>` | Base URL baked into table QR deep links. Left unset, generated QR codes point at `localhost:5173` and are useless in the real world. |
| `REDIS_URL` | Managed Redis URL (SECRET) | Optional in schema, but needed for sessions/queues in production. |

### Do NOT set

- **`PORT`** — App Platform injects it (`8080`). Setting it yourself makes the
  health check fail. `index.js` already binds `env.PORT` on all interfaces.

### Optional — set only if the feature is in use

`CLOUDINARY_URL` *or* (`CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_API_KEY` +
`CLOUDINARY_API_SECRET`), `GOOGLE_MAPS_API_KEY`, `RAZORPAY_KEY_ID`,
`RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `SMS_PROVIDER`,
`MESSAGECENTRAL_*`, `RATE_LIMIT_MAX`, and the pricing/delivery knobs
(`PLATFORM_COMMISSION_PERCENT`, `CART_TAX_PERCENT`, …).

> Razorpay keys are optional by design so local dev works without a gateway.
> If they are missing while `NODE_ENV=production`, the server logs a warning and
> **silently falls back to simulated payments** — check your logs after deploy.

See `server/.env.example` for the complete, authoritative list.

---

## Frontend — Vercel

Set under **Project → Settings → Environment Variables**, scoped to
**Production** (and Preview, if you use preview deploys).

| Variable | Set to |
|---|---|
| `VITE_API_BASE` | `https://<your-backend>.ondigitalocean.app` |
| `VITE_SOCKET_URL` | Only if the Socket.IO origin differs from `VITE_API_BASE`; it defaults to it. |

### The Vite gotcha

`VITE_*` variables are **inlined into the bundle at build time**, not read at
runtime. Two consequences:

1. Changing a variable in the Vercel dashboard does **not** affect the live site
   until you **trigger a redeploy**.
2. Whatever value is present at build time is embedded in the public JavaScript
   bundle. **Never put a secret in a `VITE_*` variable** — API keys, tokens and
   database URLs belong on the backend only.

---

## Local development

```bash
cd server
cp .env.example .env   # then fill in MONGODB_URI and the four JWT secrets
npm install
npm run dev
```

`.env` stays on your machine. It is gitignored at both the repo root and in
`server/`, so it cannot be committed by accident.
