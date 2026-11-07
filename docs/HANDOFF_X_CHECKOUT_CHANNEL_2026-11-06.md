# Handoff: PhonePe checkout channel (SDK vs hosted web)

**Date:** 2026-11-06  

This note summarizes the change for **optional checkout routing**: native **SDK** order (`createSdkOrder` + token) vs **hosted** browser checkout (`createPayment` + `paymentUrl`), controlled mainly by **`X-Checkout-Channel`** and **`X-Platform`**.

---

## Production deploys (Vercel)

| App | Production URL |
|-----|----------------|
| **Backend API** | https://swarnagrow-backend.vercel.app |
| **Web portals** (Tenant Admin / customer app shell) | https://swarnagrow-tenant-admin.vercel.app |

API base for clients: **`https://swarnagrow-backend.vercel.app/api/v1`**.

Inspect links (Vercel dashboard): backend deployment `dpl_3PF1garWd6BkYYGo8nWBG5nZyaUN`, frontend `dpl_AnJmH6dpKsMakMRB2vTbVje6kqBH` (see CLI output at deploy time).

---

## What changed

### Request header: `X-Checkout-Channel`

Optional on **payment-intent style** routes (scheme flexible `payment-intents`, shop order payment-intents, Digital Gold buy/redemption payment-intents, ecommerce checkout initiation, etc.).

| Value | Behaviour |
|--------|------------|
| *(omit)* or `auto` | `X-Platform: android` \| `ios` → **SDK** (`SDK_ORDER` + token). No / other platform → **hosted** (`HOSTED_REDIRECT` + `paymentUrl`). |
| `sdk` | Always SDK path. |
| `hosted` | Always hosted browser checkout (`paymentUrl`), even if `X-Platform` is mobile. |

Invalid values → **`400`** `VALIDATION_FAILED`, field **`x-checkout-channel`**.

**Dedicated SDK endpoints** (e.g. `POST …/pay/sdk-order`, internal `createSdkPaymentIntent` / fixed-link SDK flows) **always** use SDK; this header does not override them.

### Web customer portal (frontend)

The browser app sets **`X-Checkout-Channel: hosted`** on all live API requests (`SwarnaGrow-Tenant-Admin` → `src/store/api/customer-api.ts` → `liveBaseQuery` `prepareHeaders`) so checkout stays **redirect / `paymentUrl`** in the browser even if `X-Platform` is ever set.

### Backend wiring (high level)

- `readCheckoutChannel()` — `src/lib/phonepe-customer-checkout-init.js`
- Unified initiation — `initiatePhonePeCustomerCheckout()` (same file)
- Call sites pass channel from `req.headers` where applicable: e.g. `payment.service.js`, `ecommerce-payment-intent.service.js`, `digital-metals-buy-payment.service.js`, `digital-metals-redemption-charge-payment.service.js`

---

## Docs to share with Flutter

Canonical copies live under **`swarnagrow-backend/docs/`**:

- **`FLUTTER_CHECKOUT_CHANNEL_INTEGRATION.md`** — **start here**: headers, JSON bodies, example responses, polling, Flutter pseudocode
- **`FLUTTER_CUSTOMER_API_GUIDE.md`** — §8 PhonePe, transport headers
- **`FLUTTER_PHONEPE_INTEGRATION.md`** — §1.1 `X-Checkout-Channel`

`SwarnaGrow-Tenant-Admin/docs/` may mirror the same files when synced from the backend.

---

## Tests

- `tests/phonepe-customer-checkout-init.test.js` — channel parsing and `hosted` / `sdk` / `auto` behaviour
- `tests/digital-metals-checkout-policy.unit.test.js` — digital metals checkout mode policy (env `DIGITAL_METALS_CHECKOUT_MODE`), extracted for fast runs without DB teardown issues
