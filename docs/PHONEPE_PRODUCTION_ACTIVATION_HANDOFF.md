# PhonePe production configuration & controlled activation handoff

**Purpose:** Engineering and operations reference for going live with PhonePe across **scheme payments**, **ecommerce checkout**, and **Digital Metals buy / redemption charges**. This document does **not** authorize enabling public checkout or running live financial transactions.

**Related:** [ECOMMERCE_ACTIVATION_CHECKLIST.md](./ECOMMERCE_ACTIVATION_CHECKLIST.md), [ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md](./ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md), [DIGITAL_METALS_RELEASE_CHECKLIST.md](./DIGITAL_METALS_RELEASE_CHECKLIST.md), [DIGITAL_METALS_API_CONTRACT.md](./DIGITAL_METALS_API_CONTRACT.md).

---

## 1. Architecture summary

| Layer | Role |
|-------|------|
| **Platform env** (`src/config/env.js`) | `PROVIDER_MODE`, `PHONEPE_ENV`, rollout flags, Redis/webhook tuning. Production boot **refuses** mock provider and sandbox platform env. |
| **Tenant secrets** (`tenant.integrationSecrets.phonepe`) | Per-jeweller **client ID**, **client secret**, **client version**, optional **environment** (`SANDBOX` \| `PRODUCTION`), **webhook username/password**. Secrets sealed at rest (`INTEGRATION_ENCRYPTION_KEY`). |
| **Credential resolution** (`resolvePhonePeCredentials`) | Tenant `environment` **defaults to platform `PHONEPE_ENV`** when omitted. SDK client uses tenant environment for `Env.PRODUCTION` vs `Env.SANDBOX`. |
| **Webhook ingress** | `POST {API_PREFIX}/webhooks/phonepe/:tenantId` — rate limits, raw body, tenant guard, signature validation, persist + BullMQ `webhooks` queue. |
| **Webhook processing** (`processWebhook`) | Routes by merchant order id prefix to **ecommerce**, **digital metals buy**, **digital metals redemption charge**, or **scheme** (`PaymentIntent` / `PaymentLink`). Refunds similarly demuxed. |
| **Reconciliation** | Scheduler: `phonepe-reconcile` (schemes), `ecommerce-payment-reconcile`, `digital-metals-payment-reconcile` (every 120s); `webhook-reclaim`; payment/expiry maintenance jobs. |

**Callback URL to register in PhonePe (per tenant):**

```text
https://<production-api-host>/api/v1/webhooks/phonepe/<tenantId>
```

Use the deployed host that matches `PUBLIC_BASE_URL` (HTTPS, non-localhost). Customer **redirect URLs** are per checkout session (app/deep link); settlement is **webhook/reconcile**, not browser return alone.

---

## 2. Required production environment (platform)

Validated at process start via `parseEnv()` when `NODE_ENV=production` (see `tests/env-production-secrets.test.js`).

### 2.1 Payment-related (owner-supplied)

| Variable | Required value | Notes |
|----------|----------------|-------|
| `NODE_ENV` | `production` | |
| `PROVIDER_MODE` | `live` | Mock provider blocked in production parse. |
| `PHONEPE_ENV` | `PRODUCTION` | Platform default for tenants that omit `environment`. |
| `ECOMMERCE_PAYMENTS_TEST_HARNESS` | `false` or **unset** | Not enforced in Zod refine; **must** be false in prod (routes exist but return 404 without harness). |
| `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED` | **`false` until final GO** | Platform gate for ecommerce customer charges. |
| `DIGITAL_METALS_CHECKOUT_MODE` | **`live` recommended** in non-prod staging only | In **`NODE_ENV=production`**, `resolveDigitalMetalsCheckoutMode()` **always** returns `LIVE_REQUIRED` — env var is ignored. |
| `DIGITAL_METALS_DEMO_BANK_VERIFY` | **`false` or unset** | Demo bank auto-verify is **off** in production (`digitalMetalsDemoBankAutoVerifyOnCreate`). |

### 2.2 Other production gates (same boot parse)

| Area | Variables / rules |
|------|-------------------|
| Secrets | `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `INTEGRATION_ENCRYPTION_KEY`, `SEED_PLATFORM_PASSWORD` — non-empty, not published defaults |
| Infra | `REDIS_REQUIRED=true`, `RATE_LIMIT_ENABLED=true`, `MONGODB_URI` (ops choice) |
| OTP | `OTP_PROVIDER=msg91` + `MSG91_*` |
| Object storage | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| FCM (if shared push) | `FCM_SHARED_PROJECT_ENABLED=true` → valid `FCM_PROJECT_ID` + service account JSON |
| URLs | `PUBLIC_BASE_URL`, `EXPORT_BASE_URL` — **HTTPS**, not localhost |
| CORS | `CORS_ORIGINS` — not default localhost list |
| Uploads | `MALWARE_SCAN_URL` set |

**Pre-flight (read-only, no secrets in output):**

```bash
cd swarnagrow-backend
node --input-type=module -e "
  import { parseEnv } from './src/config/env.js';
  const r = parseEnv({ ...process.env, NODE_ENV: 'production' });
  console.log(r.success ? 'PRODUCTION_ENV_PARSE_OK' : r.error.issues.map(i => i.message).join('; '));
"
```

Run on the **deployment host** with the real env file loaded (`node --env-file=.env …`), not in chat logs.

---

## 3. Tenant PhonePe configuration (platform console)

**API:** `PUT /api/v1/platform/tenants/:tenantId/integrations/payment-gateway`  
**Verify:** `POST /api/v1/platform/tenants/:tenantId/integrations/payment-gateway/verify`

### 3.1 Required fields

| Field | Validation | Purpose |
|-------|------------|---------|
| `clientId` | min 4 chars | PhonePe merchant client id |
| `clientSecret` | min 8 (on save) | Sealed; used for checkout/refund/status SDK |
| `clientVersion` | int 1–99 (default 1) | SDK `StandardCheckoutClient` version |
| `webhookUsername` | min 2 | Must match PhonePe webhook auth config |
| `webhookPassword` | min 4 (on save) | Sealed; used in `validateCallback` (live) or Basic compare (mock provider mode) |
| `environment` | `SANDBOX` or `PRODUCTION` | **Overrides platform `PHONEPE_ENV` for SDK** |

After credential rotation, `credentialVersion` increments and PhonePe client cache is invalidated for that tenant.

### 3.2 Sandbox-on-production guard (critical)

**Behavior today:**

- `resolvePhonePeCredentials()` uses `config.environment ?? env.PHONEPE_ENV`.
- A tenant with **`environment: SANDBOX`** on a production API will talk to **PhonePe sandbox**, even when platform `PHONEPE_ENV=PRODUCTION`.
- **`assertProductionTenantPhonePe()`** (runs at API boot in `server.js`) blocks startup only for **active tenants with `goLiveAt` set** and sandbox PhonePe.

**Implication:** A tenant with PhonePe credentials but **no `goLiveAt`** could still initiate checkout against sandbox if misconfigured. **Before go-live:** set tenant `environment: PRODUCTION`, run **verify**, then set `goLiveAt` only when ready.

**Inherited environment:** If tenant omits `environment`, platform `PHONEPE_ENV` applies (must be `PRODUCTION` in prod).

---

## 4. Product-specific activation switches

Enable **one product at a time** after sandbox/staging evidence. All require **live** `PROVIDER_MODE` and production PhonePe credentials on the pilot tenant.

### 4.1 Scheme / savings payments (PhonePe)

| Switch | Where |
|--------|--------|
| Platform capability | Tenant `featureFlags` / plan entitlements — **`onlinePayments`** (`assertPlatformCapability` in `payment.service.js`) |
| Customer app | `operations.customerAppPaymentsEnabled !== false` |
| Gateway | Tenant PhonePe credentials + **`environment: PRODUCTION`** |
| Go-live | Tenant **`goLiveAt`** (boot sandbox check) |

**Paths:** Payment links and SDK intents via `phonePeProvider.createPayment` / `createSdkOrder`; webhooks fall through to `PaymentIntent` / `PaymentLink` when merchant id is not ecommerce/DM-prefixed.

**Recovery jobs:** `phonepe-reconcile`, `expire-payments`, scheme refund reconcile services.

### 4.2 Ecommerce online checkout

| Switch | Where |
|--------|--------|
| Plan | `ecommerce` + **`ecommercePayments`** on subscription snapshot |
| Store | `operations.ecommerceEnabled` |
| Customer app | `customerAppPaymentsEnabled` |
| Gateway | Tenant PhonePe configured |
| **Platform rollout** | `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED=true` (env) — **last** |
| **Tenant rollout** | `operations.ecommercePaymentsRolloutEnabled=true` |
| Tax / policies | Checkout tax readiness + store policies (blockers on quote) |

**Diagnose (read-only):** `node --env-file=.env scripts/diagnose-ecommerce-payment-capability.js <TENANT_CODE>` — prints gates and blockers **without secrets**.

**Recovery:** `ecommerce-payment-reconcile`, `ecommerce-order-payment-expiry`, admin reconcile-retry / payment-exceptions queue; exception refunds via `ecommerce-payment-exception-refund.service.js`.

### 4.3 Digital Metals (buy + paid redemption charges)

| Switch | Where |
|--------|--------|
| Plan / ops | `digitalMetals` feature, `operations.digitalMetalsEnabled` |
| Compliance | Platform tax profile approve + terms publish; published rates |
| Trading | Not `digitalMetalsPaused` / `digitalMetalsPlatformPaused` |
| Checkout | Production **always** `LIVE_REQUIRED` — live PhonePe credentials mandatory |
| Demo / harness | No demo checkout in prod; test-harness routes **404** unless `NODE_ENV=test` + harness flag |

**Paths:** Buy and redemption charge payment intents → `initiateDigitalMetalsPhonePeCheckout`; webhooks → `digital-metals-buy-finalize.service.js` / `digital-metals-redemption-charge-finalize.service.js`.

**Recovery:** `digital-metals-payment-reconcile`, payment exception + refund flows; wallet credit is post-payment finalize (idempotent webhook handling).

---

## 5. Test harness & mock guards (must stay off in production)

| Surface | Guard |
|---------|--------|
| Ecommerce `…/shop/orders/:id/test-harness/complete-payment` | `isEcommercePaymentsTestHarnessEnabled()` → **404** if not `NODE_ENV=test` + harness true |
| DM buy / redemption test-harness routes | Same pattern via `assertBuyPaymentTestHarness()` |
| `PROVIDER_MODE=mock` | Blocked by production env parse; `phonePeProvider` short-circuits in mock mode |
| DM demo checkout | `DIGITAL_METALS_DEMO` / `MOCK_PROVIDER` **not used** when `NODE_ENV=production` |

Routes are registered in `app.routes.js` but handlers reject production traffic.

---

## 6. Webhook authentication (live)

1. HTTP `Authorization` header (Basic or as required by PhonePe SDK).
2. `phonePeProvider.verifyCallback(rawBody, authorization, credentials, tenantId)`:
   - Live: `StandardCheckoutClient.validateCallback(webhookUsername, webhookPassword, header, raw)`.
   - Missing webhook credentials → **422** `WEBHOOK_CREDENTIALS_MISSING` (not silently accepted).
3. Invalid signature → **401**, `persistWebhookSignatureFailure` (no order mutation).
4. Valid → `WebhookEvent` queued; worker processes with lease + idempotency.

**Owner check:** PhonePe dashboard callback URL and credentials **exactly** match tenant `webhookUsername` / `webhookPassword` and deployed URL path.

---

## 7. Processes that must be running (production)

| Process | Responsibility |
|---------|----------------|
| **API** | Checkout creation, webhook ingress, admin ops |
| **Worker** | `webhooks` queue, payment finalization side effects |
| **Scheduler** | Repeatable jobs in `src/schedulers/repeatable-jobs.js` (reconcile, expiry, webhook-reclaim, DM outbox dispatch) |
| **Redis** | Queues + rate limits (`REDIS_REQUIRED=true`) |

Confirm scheduler logs show registrations for `phonepe-reconcile`, `ecommerce-payment-reconcile`, `digital-metals-payment-reconcile`, `webhook-reclaim`.

---

## 8. Controlled live verification checklist (owner — pilot tenant only)

Use **minimum amount** SKUs/schemes; **one product line at a time**; keep rollout flags **off** for products not under test. Record tenant id, order/payment ids, and timestamps in your ops log (no secrets).

### 8.1 Successful payment

| Product | Steps | Expected DB / state | Recovery if stuck |
|---------|--------|---------------------|-------------------|
| **Ecommerce** | Quote → order → payment-intent → complete in PhonePe app | Order **`PAID`**, single stock consumption, one `EcommercePaymentAttempt` **SUCCEEDED** | Wait webhook; run worker; **`ecommerce-payment-reconcile`**; admin payment-intent status / reconcile-retry with reason |
| **Digital Metals buy** | Buy order → payment-intent → pay | Buy order **payment verified → credited**, **one** wallet/passbook credit, attempt terminal success | **`digital-metals-payment-reconcile`**; admin buy order view; duplicate webhook must not double-credit |
| **DM redemption charge** | Redemption order with charge → pay | Charge case **paid**, redemption proceeds per workflow | Same reconcile job family; charge refund path if late success |
| **Scheme** | Create intent/link → pay | `PaymentIntent` / link **completed**, ledger payment posted once | **`phonepe-reconcile`**; admin gateway ops |

### 8.2 Failure / user cancellation at provider

| Expected | Recovery |
|----------|----------|
| Attempt **FAILED** or order remains **PENDING_PAYMENT** / not credited | Customer may retry new intent where policy allows; no wallet credit / no PAID without success webhook |
| Ecommerce stock | Still reserved until payment expiry or cancel path; expiry job releases once |

### 8.3 Browser does not return to app

| Expected | Recovery |
|----------|----------|
| Order/intent stays **INITIATED** until webhook or reconcile | Do **not** mark paid manually; rely on webhook + **`ecommerce-payment-reconcile`** / DM reconcile; customer order history shows in-flight attempt |

### 8.4 Duplicate callback (same success event twice)

| Expected | Recovery |
|----------|----------|
| Second processing **idempotent** — still one PAID / one credit | Inspect `WebhookEvent` + attempt status; no duplicate stock/wallet lines |

### 8.5 Delayed confirmation (webhook late, payment actually succeeded)

| Expected | Recovery |
|----------|----------|
| Reconcile job transitions to paid/credited after provider shows success | If order already **PAYMENT_EXPIRED** with success → ecommerce **late success / exception refund** path; DM buy uses exception refund services — admin payment-exceptions queue |

### 8.6 Refund (provider-initiated or exception path)

| Expected | Recovery |
|----------|----------|
| Refund webhook demuxed to correct service (ecommerce / DM buy / scheme) | Case moves **PENDING → SUCCEEDED** once; customer DTO shows **REFUND_PENDING** until confirmed; admin initiates exception refund where applicable |

---

## 9. Go / no-go checklist

### No-go (do not enable rollout) if any are true

- [ ] Production env parse fails on deploy host
- [ ] `PROVIDER_MODE` not `live` or `PHONEPE_ENV` not `PRODUCTION`
- [ ] `ECOMMERCE_PAYMENTS_TEST_HARNESS=true` in production env
- [ ] Pilot tenant PhonePe **`environment` is SANDBOX** or verify integration **not** run
- [ ] Webhook URL in PhonePe dashboard ≠ deployed `/api/v1/webhooks/phonepe/:tenantId`
- [ ] Worker or scheduler not running; Redis unavailable
- [ ] Ecommerce: checkout tax / store policies / accountant sign-off incomplete
- [ ] Digital Metals: tax profile / terms / rates / platform pause not cleared
- [ ] Automated release suite not green on release commit (`npm run test:release`)
- [ ] Staging checklist ([ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md](./ECOMMERCE_PHONEPE_STAGING_CHECKLIST.md)) unsigned for the product line

### Go (controlled pilot — still not “public marketing”)

- [ ] All no-go items cleared for **one** product line
- [ ] Platform + tenant rollout flags enabled **only** for that line (see §4)
- [ ] `goLiveAt` set only when tenant PhonePe is **PRODUCTION** and verified
- [ ] Monitoring: webhook backlog, payment-exceptions queue, DM work queue, reconcile job metrics
- [ ] Owner sign-off row in staging checklist + dated ops log

---

## 10. Rollback / disable procedure (no deploy required)

Execute in order; **does not reverse already-credited metal or settled scheme ledger** — use ops/refund tools for financial correction.

1. **Stop new checkout**
   - Ecommerce: `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED=false`; tenant `ecommercePaymentsRolloutEnabled=false`
   - Digital Metals: platform or tenant **pause** (`digital-metals/pause`) — preserves holdings/settlement access
   - Schemes: disable **`onlinePayments`** capability / customer app payments for tenant
2. **Leave worker + scheduler running** so in-flight webhooks and reconciles complete
3. **Optional:** Rotate webhook password in PhonePe + tenant integration if credentials may be exposed
4. **Communicate:** Customer app shows payment blockers / paused trading messages from capability APIs

---

## 11. Remaining merchant / activation requirements (non-engineering)

- PhonePe **production** merchant KYC and live keys issued to jeweller
- Webhook URL whitelisted on PhonePe for production host
- Accountant-approved ecommerce tax/HSN and invoice rules
- Digital Metals terms, tax profile, and rate publication sign-off
- Bank payout / settlement SOP for DM sell and scheme refunds (manual steps outside PhonePe checkout)
- Customer support scripts for “payment done but order pending” (webhook delay)
- Legal/store policies published in fulfilment settings (ecommerce)

---

## 12. Code references (for engineers)

| Topic | Location |
|-------|----------|
| Production env parse | `src/config/env.js` |
| Tenant credential resolution | `src/integrations/phonepe.provider.js` — `resolvePhonePeCredentials`, `getClientFor`, `verifyCallback` |
| Boot sandbox guard | `src/lib/production-boot-checks.js`, `src/server.js` |
| DM checkout policy | `src/lib/digital-metals-demo-policy.js` |
| Ecommerce payment gates | `src/lib/ecommerce-checkout-capability.js` |
| Webhook route | `src/routes/webhook.routes.js`, `src/controllers/webhook.controller.js` |
| Webhook demux | `src/workers/processors.js` — `processWebhook` |
| Scheduler jobs | `src/schedulers/repeatable-jobs.js` |

**Document status:** Prepared from codebase inspection **2026-10-24**. No live transactions, env changes, or rollout flags were applied in this pass.
