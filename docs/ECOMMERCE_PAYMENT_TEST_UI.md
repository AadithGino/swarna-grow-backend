# Ecommerce payment test UI harness

Local-only walkthrough for customer checkout and admin fulfilment with **mock PhonePe** and **`paymentAllowed=true`** without touching Atlas rollout flags.

## One-command startup

From `swarnagrow-backend`:

```bash
npm run ecommerce:payment-test-ui
```

Optional API smoke (seed + full quote → order → harness → PAID, then exit):

```bash
npm run ecommerce:payment-test-ui:smoke
```

### What the runner does

1. Starts an **in-memory MongoDB replica set** (`swarnagrow_ecommerce_pay_ui`) — **not** Atlas.
2. Refuses any Atlas/SRV/staging/production-like `MONGODB_URI` if you override it.
3. Spawns the API with:
   - `NODE_ENV=test`
   - `ECOMMERCE_PAYMENTS_TEST_HARNESS=true`
   - `PROVIDER_MODE=mock`
   - `OTP_PROVIDER=mock`
   - Default port **4001**
4. Seeds tenant **`ECOPAYTEST`** (“Ecommerce Pay UI Test Jeweller”), owner, customer, demo catalog (published priced products, inventory, TEST checkout tax, pickup branch).

Session details are written to `scripts/.ecommerce-payment-test-ui-session.json`.

### Shutdown

Press **Ctrl+C** in the runner terminal. That stops the API child process and tears down the in-memory MongoDB.

Do **not** point the runner at your development `.env` `MONGODB_URI` on Atlas.

## Tenant Admin `.env.local`

```env
NEXT_PUBLIC_USE_MOCKS=false
NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4001/api/v1
NEXT_PUBLIC_ECOMMERCE_PAYMENT_TEST_UI=true
```

Then:

```bash
cd SwarnaGrow-Tenant-Admin && pnpm dev
```

## Login details

| Role | URL | Credentials |
|------|-----|-------------|
| **Admin** | `http://localhost:3000/login` | Tenant code `ECOPAYTEST`, mobile `9888877700`, password `1234` |
| **Customer** | `http://localhost:3000/customer/ecopaytest/login` | Mobile `9888877701`, OTP `123456` |

## Manual walkthrough

1. **Customer:** Shop → add item → cart → create quote → confirm **`paymentAllowed`** / no payment blockers.
2. Place order → **Pay now** (mock gateway) → use **Mock payment success** on the order page (test harness panel).
3. Confirm order **PAID** and inventory reduced once.
4. **Admin:** Ecommerce → orders → open order → fulfilment transition (e.g. processing → ready for pickup).

Failed payment: use **Mock payment failed**, then **Pay now** again and **Mock payment success**.

## Prove the browser is on the harness API (not Atlas)

1. `.env.local` must use `NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:4001/api/v1` (not port 4000 / not Atlas).
2. Customer requests send `X-Swarna-Client-Api-Base` — on **GET** `/app/shop/quotes/:id`, the API logs **Ecommerce quote capability debug** (non-production) with:
   - `clientApiBase`, `backend.mongo.host` / `dbName` (`swarnagrow_ecommerce_pay_ui` on `127.0.0.1`)
   - `backend.NODE_ENV=test`, `harness.active=true`, `capability.paymentAllowed=true` after a fresh quote
3. Compare with diagnose **only** against the same DB:  
   `MONGODB_URI='<runner uri>' NODE_ENV=test ECOMMERCE_PAYMENTS_TEST_HARNESS=true node scripts/diagnose-ecommerce-payment-capability.js ECOPAYTEST`

Never run the harness runner with your Atlas `.env` `MONGODB_URI`.

## KAIRALI / MEHER on development Atlas

If the quote page showed `STORE_NOT_OPERATIONAL` and `PLAN_ECOMMERCE_DISABLED` while `npm run diagnose:ecommerce-payments -- KAIRALI` did not, the customer route was recomputing capability on a tenant reload **without** the attached subscription catalog plan. KAIRALI has `planFeaturesSnapshot: null` and relies on the live **GROWTH** catalog plan for `ecommerce`. That is fixed in `tenantForEcommerceCheckout`; restart the API after pulling the fix.

## Test-only mock completion API

`POST /api/v1/app/shop/orders/:orderId/test-harness/complete-payment`

- Returns **404** unless `NODE_ENV=test` **and** `ECOMMERCE_PAYMENTS_TEST_HARNESS=true`.
- Body: `{ "outcome": "COMPLETED" | "FAILED", "paymentAttemptId"?: "..." }`.

## Focused tests

```bash
NODE_ENV=test node --test tests/ecommerce-test-harness-http.test.js
NODE_ENV=test node --test tests/ecommerce-commerce-phase-d2-hardening-http.test.js
```

Do not run the full `npm test` suite for this workflow unless you explicitly want the hour-long run.
