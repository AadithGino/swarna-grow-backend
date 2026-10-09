# Ecommerce PhonePe staging checklist

Use this **after** accountant tax sign-off, tenant gateway credentials, and explicit rollout approval. Do **not** enable `ECOMMERCE_PAYMENTS_ROLLOUT_ENABLED` or tenant `ecommercePaymentsRolloutEnabled` until every row below is signed off.

## Preconditions

- [ ] Staging tenant has complete checkout tax config (HSN/SAC, component rules, supported destination states).
- [ ] PhonePe **sandbox** credentials stored on tenant (`integrationSecrets.phonepe`).
- [ ] Webhook URL registered with PhonePe for `/api/v1/webhooks/phonepe/:tenantId`.
- [ ] Platform env: rollout flags remain **false** until product owner approval.

## Initiation

- [ ] Customer quote → order → payment-intent returns **201** with `INITIATED` attempt and mock/live token.
- [ ] Second payment-intent with a **different** idempotency key returns **422** `PAYMENT_ATTEMPT_IN_PROGRESS`.
- [ ] Retry with the **same** idempotency key returns the same attempt (no duplicate provider orders).

## Signed webhook

- [ ] Complete payment in PhonePe sandbox; **signed** `CHECKOUT_ORDER_COMPLETED` webhook arrives.
- [ ] Order becomes **PAID** only via webhook/reconcile (never via browser redirect alone).
- [ ] Duplicate webhook is idempotent (`ALREADY_SUCCESS`).
- [ ] Forged/invalid signature returns **401** and does not change order state.

## Reconciliation

- [ ] Stop webhook delivery; complete payment; run `ecommerce-payment-reconcile` job — order becomes **PAID**.
- [ ] Webhook and reconcile racing still yields **one** PAID transition and **one** stock consumption.

## Expiry and late success

- [ ] Let order payment window expire with **no** in-flight attempt — stock released once.
- [ ] With **INITIATED** attempt near expiry, expiry job respects reconcile grace (stock held).
- [ ] Verified success **after** expiry → order stays non-PAID, `LATE_SUCCESS_REFUND_REQUIRED`, refund case **ASSIGNED**.

## Failure and stuck attempts

- [ ] Terminal provider failure marks attempt **FAILED** without releasing paid stock incorrectly.
- [ ] Unknown/pending provider state does **not** terminal-fail the attempt; operational status shows **AWAITING_PROVIDER** or **STUCK_RECONCILE** in admin.

## Refund (late success)

- [ ] Admin initiates exception refund — provider refund **PENDING** (not `REFUNDED` until confirmed).
- [ ] Manual record path sets **MANUAL_RECORDED** with audit event and outbox `ecommerce.refund.completed`.

## Fulfilment

- [ ] Staff transition **PAID → PROCESSING** with `expectedVersion` succeeds.
- [ ] Fulfilment blocked for `PENDING_PAYMENT`, `PAYMENT_EXPIRED`, and payment-exception orders.

## Sign-off

- [ ] Engineering
- [ ] Operations / accountant
- [ ] Product (rollout approval)
