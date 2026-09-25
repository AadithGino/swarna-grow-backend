# Customer API — full response matrix

Companion to [API_CONTRACT_CUSTOMER.md](./API_CONTRACT_CUSTOMER.md). Covers **all 67 customer-panel routes**, **scheme display modes**, **value basis**, and **tenant/plan operational settings**. Shapes match `customer-app-dto.js`, `customer-scheme-detail-dto.js`, `customer-app.service.js`, `scheme.service.js` (`payableRange`), and `redemption.service.js` (`settlementPreview`).

**Wrapper:** `{ "success": true, "data": … }` unless noted. Route `#` matches [Appendix C](./API_CONTRACT_CUSTOMER.md#appendix-c--route-inventory-customer-panel).

---

## 1. Scheme & product dimensions

| Dimension | Values | Drives |
|-----------|--------|--------|
| **displayMode** | `FIXED` · `FLEXIBLE_FREE_WINDOW` · `FLEXIBLE_LOCK_WINDOW` | Home card, scheme list/detail, passbook labels, pay UX |
| **paymentPattern** | `FIXED` · `FLEXIBLE` | Pay route: `#45` link vs `#46`/`#47` intent |
| **flexiblePhase** (storage) | `FLEXIBLE` → free window · else capped | `payableRange.phase`: `FLEXIBLE` \| `CAPPED` |
| **valueBasis** | `CASH` (default) · `GOLD_WEIGHT` | `goldAccumulated`, stat cards, settlement `modePreviews` |
| **scheme.status** | `PENDING_PAYMENT`, `ACTIVE`, `LOCKED`, `DEFAULTED`, `MATURED`, `REDEEMED`, `CLOSED_PREMATURE` | `canPay`, `#40` errors, redemption UI |
| **Plan payment rules (FIXED)** | `partialPaymentAllowed`, `advancePaymentAllowed`, `maxAdvanceInstallments` | `#40` `allowedAmountsPaise`, helper text |
| **Plan capped rules** | `allowFutureCyclePayment`, `maxAdvanceCycles`, `allowFinalRemainderBelowMinimum` | `#40` `targetCycleOptions`, errors `FUTURE_CYCLE_*` |

**Display mode resolution** (`resolveDisplayMode`): explicit `displayMode` on scheme → else `FIXED` if `paymentPattern === FIXED` → else `FLEXIBLE` phase → `FLEXIBLE_FREE_WINDOW` → else `FLEXIBLE_LOCK_WINDOW`.

---

## 2. Tenant operational settings

Stored on `tenant.operations` and `tenant.settings`. Exposed on **`tenant` / `tenantCapabilities`** after login (`tenantPortalCapabilitiesDto`) and on **`GET /public/tenants/resolve`** rows (`tenantResolveRow` merges branding + capabilities).

| Setting (storage) | Capability field | Default | Customer impact |
|-------------------|------------------|---------|-----------------|
| `operations.customerSelfRegistrationEnabled` | `customerSelfRegistration` | `true` | `#6` OTP `SIGNUP` when mobile unknown → `403 SELF_REGISTRATION_DISABLED` |
| `operations.customerSelfEnrolEnabled` | `customerSelfEnrol` | `true` | `#44` enrol, `#37`/`#38` plans → `403` / `canEnrol: false` |
| `settings.requireKycForEnrolment` | `kycMandatory` | `false` | `#28`/`#24` include `kyc` block; `#31` allowed when `true` |
| `settings.oneActiveSchemePerCustomer` or `operations.multiSchemePerCustomer === false` | `multiScheme: false` | `true` multi | Second enrol blocked server-side |
| `operations.customerLoginMode` | `customerLoginMode` | `OTP_ONLY` | `PASSWORD_ONLY` → `#7` only; OTP login may be rejected |
| `operations.customerAppWriteEnabled` | `customerAppWriteEnabled` | `true` | `false` → mutating `#29`–`#67` → `403 CUSTOMER_APP_VIEW_ONLY` |
| `operations.customerAppPaymentsEnabled` | `customerAppPaymentsEnabled` | `true` | `false` (or write off) → `#45`–`#47`, `#46`, public `#19` → `403 CUSTOMER_PAYMENTS_DISABLED`; detail `payButton.enabled: false` |
| Plan `availability.customerSelfEnrolAllowed` | (per plan) | varies | `#37` `canEnrol: false`, `enrolBlockReason` |
| Plan `availability.visibleInCustomerApp` | — | — | Plan omitted from `#37` |
| Gold rate missing (GOLD_WEIGHT) | — | — | `#43` `paymentBlock`: `{ code: "GOLD_RATE_NOT_SET", message: "…" }`, pay button label *Gold rate not published* |

### 2.1 Capability payload variants (session / resolve)

**Default (all enabled):**

```json
{
  "customerSelfEnrol": true,
  "customerSelfRegistration": true,
  "kycMandatory": false,
  "multiScheme": true,
  "customerLoginMode": "OTP_ONLY",
  "customerAppWriteEnabled": true,
  "customerAppPaymentsEnabled": true
}
```

**View-only app (no writes, no online pay):**

```json
{
  "customerSelfEnrol": true,
  "customerSelfRegistration": true,
  "kycMandatory": false,
  "multiScheme": true,
  "customerLoginMode": "OTP_ONLY",
  "customerAppWriteEnabled": false,
  "customerAppPaymentsEnabled": false
}
```

**KYC required for enrolment:**

```json
{
  "customerSelfEnrol": true,
  "customerSelfRegistration": true,
  "kycMandatory": true,
  "multiScheme": true,
  "customerLoginMode": "OTP_ONLY",
  "customerAppWriteEnabled": true,
  "customerAppPaymentsEnabled": true
}
```

**Password-only login jeweller:**

```json
{
  "customerLoginMode": "PASSWORD_ONLY",
  "customerSelfEnrol": true,
  "customerSelfRegistration": false,
  "kycMandatory": false,
  "multiScheme": true,
  "customerAppWriteEnabled": true,
  "customerAppPaymentsEnabled": true
}
```

---

## 3. Route index — response shape & variants

| # | Method | Path | Primary `data` shape | Scheme / settings variants |
|---|--------|------|----------------------|----------------------------|
| 1 | GET | `/health` | `{ status, timestamp }` | — |
| 2 | GET | `/health/ready` | `{ database, queue }` | — |
| 3 | GET | `/public/app-config` | platform versions, maintenance | `forceUpdate` → client 426 |
| 4 | GET | `/public/auth/password-policy` | PIN rules | — |
| 5 | POST | `/public/auth/otp/request` | `otpRequestDto` | `isRegistered` |
| 6 | POST | `/public/auth/otp/verify` | session + customer + capabilities | §2, `profileComplete` |
| 7 | POST | `/public/auth/login-password` | same as #6 | `PASSWORD_ONLY`, `CUSTOMER_PASSWORD_NOT_SET` |
| 8 | POST | `/public/auth/set-password` | `{ passwordSet }` | — |
| 9 | GET | `/public/tenants/resolve` | `{ resolvedBy, tenantCode, tenants[] }` | §2.1 on each tenant |
| 10 | GET | `/public/tenants/:id/branches` | `Branch[]` | — |
| 11–17 | * | `/public/signup/*` | jeweller SaaS signup | §8 (not end-customer scheme modes) |
| 18 | GET | `/public/pay/:token` | `publicPayPageDto` | §4.1 installment vs flexible label |
| 19 | POST | `/public/pay/:token/initiate` | gateway fields | `CUSTOMER_PAYMENTS_DISABLED` |
| 20 | GET | `/public/pay/:token/status` | poll DTO | terminal §4.2 |
| 21 | GET | `/public/uploads/:id` | binary | — |
| 22 | POST | `/app/auth/refresh` | tokens | — |
| 23 | POST | `/app/auth/logout` | `{ loggedOut }` | — |
| 24 | GET | `/app/auth/me` | profile DTO | §2 KYC block |
| 25 | GET | `/app/auth/devices` | device rows | — |
| 26 | DELETE | `/app/auth/devices/:id` | `{ revoked }` | — |
| 27 | GET | `/app/home` | `buildHome` | §5.1 `activeSchemes[]` × displayMode |
| 28 | GET | `/app/profile` | profile DTO | §2 KYC |
| 29 | PATCH | `/app/profile` | profile | `expectedVersion` |
| 30 | POST | `/app/profile/complete` | profile | post-signup |
| 31 | PUT | `/app/profile/kyc` | profile + kyc | 403 if not `kycMandatory` |
| 32 | PUT | `/app/profile/nominee` | profile | — |
| 33 | DELETE | `/app/profile/nominee` | profile | — |
| 34–36 | * | `/app/uploads/*` | presign / binary | — |
| 37 | GET | `/app/scheme-plans` | `mapCustomerPlanListItem[]` | §5.2 FIXED vs FLEXIBLE |
| 38 | GET | `/app/scheme-plans/:id` | plan card | `canEnrol`, `flexibleSummary` |
| 39 | GET | `/app/schemes` | `SchemeCard[]` or past rows | `?group=PAST` §5.3 |
| 40 | GET | `/app/schemes/:id/payable-range` | `enrichPayableRange` | §5.4 all modes |
| 41 | GET | `/app/schemes/:id/passbook` | ledger UI | same displayMode labels |
| 42 | GET | `/app/schemes/:id/settlement-preview` | redemption preview | §5.5 CASH vs GOLD_WEIGHT |
| 43 | GET | `/app/schemes/:id` | `CustomerSchemeDetail` | §5.6 × displayMode |
| 44 | POST | `/app/schemes/enrol` | scheme + payment | §5.7 FIXED link vs FLEX intent |
| 45 | POST | `/app/schemes/:id/pay` | `paymentLinkDto` | **FIXED only** |
| 46 | POST | `/app/schemes/:id/payment-intents` | `paymentIntentAppDto` | **FLEXIBLE** + position version |
| 47 | POST | `/app/schemes/:id/pay/sdk-order` | intent + `providerOrderId` | same as #46 |
| 48 | GET | `/app/payment-intents/:id` | intent poll | — |
| 49 | POST | `/app/payment-intents/:id/cancel` | cancel DTO | — |
| 50 | GET | `/app/payments` | list + meta summary | §5.8 `targetCycle` on FLEX |
| 51 | GET | `/app/payments/:id/receipt` | PDF | — |
| 52 | GET | `/app/payments/:id` | list item | — |
| 53 | GET | `/app/payments/:linkId/status` | link poll | — |
| 54–56 | * | `/app/notifications/*` | notification DTOs | deep links to schemes |
| 57–58 | * | `/app/devices/fcm-token` | register/remove | — |
| 59 | GET | `/app/branches` | branches | — |
| 60–61 | * | `/app/gold-rate/*` | rate DTOs | shown on home when GOLD_WEIGHT |
| 62–66 | * | `/app/grievances/*` | grievance DTOs | — |
| 67 | POST | `/app/schemes/:id/redemption-request` | `{ id, status: REQUESTED, … }` | `expectedVersion`, allowed modes from plan |

Baseline request/response JSON for routes **without** scheme branching: [Appendix F](./API_CONTRACT_CUSTOMER.md#appendix-f--example-requests--responses) (F.1–F.36, F.48–F.66).

---

## 4. Public pay & poll variants

### 4.1 `GET /public/pay/:linkToken` — `installmentLabel`

**FIXED scheme link:**

```json
{
  "success": true,
  "data": {
    "linkId": "plink_01EXAMPLE",
    "status": "OPEN",
    "installmentLabel": "Fixed instalment",
    "schemeLabel": "ENR-0000001",
    "amount": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "canPay": true
  }
}
```

**FLEXIBLE scheme link:**

```json
{
  "success": true,
  "data": {
    "installmentLabel": "Flexible contribution",
    "schemeLabel": "ENR-0000002",
    "amount": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "canPay": true
  }
}
```

### 4.2 Poll status enum (routes #20, #48, #53)

`status`: `PROCESSING` | `PAID` | `FAILED` | `EXPIRED` | `CANCELLED` — see `derivePaymentUiState` / `derivePaymentIntentUiState` in `customer-app-dto.js`.

---

## 5. Scheme-mode response catalog

### 5.1 `GET /app/home` — `activeSchemes[]` (`mapHomeSchemeCard`)

**FIXED (`displayMode: "FIXED"`):**

```json
{
  "id": "sch_fixed_01",
  "schemeNumber": "ENR-0000001",
  "planName": "Akshaya 11+1",
  "subtitle": "Fixed monthly gold savings",
  "displayMode": "FIXED",
  "valueBasis": "CASH",
  "status": "ACTIVE",
  "progressPhase": "FIXED",
  "progressPercent": 18,
  "progressLabel": "2 of 11 instalments paid",
  "progressDetail": "11-month fixed plan",
  "totalPaid": { "amountPaise": 1000000, "amountDisplay": "₹10,000" },
  "nextActionLabel": "Next payment · 2026-10-01",
  "nextActionAmount": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
  "canPay": true,
  "benefitLabel": "One free instalment on completion"
}
```

**FLEXIBLE free window:**

```json
{
  "id": "sch_free_01",
  "schemeNumber": "ENR-0000002",
  "displayMode": "FLEXIBLE_FREE_WINDOW",
  "progressPhase": "FREE_WINDOW",
  "progressPercent": 33,
  "progressLabel": "Free window · month 3 of 6",
  "progressDetail": "Optional contributions now · 6-month capped phase follows",
  "totalPaid": { "amountPaise": 3760000, "amountDisplay": "₹37,600" },
  "nextActionLabel": "Contribute any time",
  "canPay": true
}
```

**FLEXIBLE capped phase (cycle progress on card):**

```json
{
  "id": "sch_cap_01",
  "schemeNumber": "ENR-0000003",
  "displayMode": "FLEXIBLE_LOCK_WINDOW",
  "progressPhase": "CAPPED",
  "progressPercent": 80,
  "progressLabel": "₹1,600 of ₹2,000 this cycle",
  "progressDetail": "₹400 remaining · cap from free-window average",
  "totalPaid": { "amountPaise": 9000000, "amountDisplay": "₹90,000" },
  "nextActionLabel": "₹400 room this month",
  "nextActionAmount": { "amountPaise": 40000, "amountDisplay": "₹400" },
  "cycleCap": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
  "remainingThisCycle": { "amountPaise": 40000, "amountDisplay": "₹400" },
  "canPay": true
}
```

**GOLD_WEIGHT** adds on the same card: `"goldAccumulated": { "weightMg": 1250, "weightDisplay": "1.250 g" }`, `"goldAccrued": { … }`. Home `summary.goldAccumulated` / `goldRate` appear when any scheme has `valueBasis: GOLD_WEIGHT`.

---

### 5.2 `GET /app/scheme-plans` — plan list item

**FIXED plan:**

```json
{
  "id": "plan_fixed",
  "paymentPattern": "FIXED",
  "paymentPatternLabel": "Fixed monthly",
  "valueBasis": "CASH",
  "durationMonths": 11,
  "highlights": ["11 monthly payments", "One free instalment on completion"],
  "enrol": {
    "firstInstallmentRequired": true,
    "firstInstallmentModeDefault": "COLLECT_NOW"
  },
  "canEnrol": true,
  "enrolBlockReason": null
}
```

**FLEXIBLE plan:**

```json
{
  "id": "plan_flex",
  "paymentPattern": "FLEXIBLE",
  "paymentPatternLabel": "Pay as you like, then monthly",
  "flexibleSummary": {
    "freeWindowMonths": 6,
    "lockWindowMonths": 6,
    "minPerPayment": { "amountPaise": 10000, "amountDisplay": "₹100" },
    "maxPerPayment": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "explainer": "Contribute any amount for the first 6 cycles…"
  },
  "canEnrol": true
}
```

**Self-enrol disabled** (`customerSelfEnrolEnabled: false` or plan `customerSelfEnrolAllowed: false`):

```json
{
  "canEnrol": false,
  "enrolBlockReason": "This plan requires branch-assisted enrolment."
}
```

---

### 5.3 `GET /app/schemes?group=PAST` — `mapPastSchemeRow`

```json
{
  "success": true,
  "data": [
    {
      "id": "sch_closed",
      "schemeNumber": "ENR-0000090",
      "planName": "Flex then capped",
      "displayMode": "FLEXIBLE_LOCK_WINDOW",
      "closureType": "MATURITY",
      "closedAt": "2027-03-15T10:00:00.000Z",
      "finalValue": { "amountPaise": 12000000, "amountDisplay": "₹1,20,000" },
      "benefitReceived": { "amountPaise": 1000000, "amountDisplay": "₹10,000" },
      "redemptionMode": "CASH",
      "passbookAvailable": true
    }
  ]
}
```

---

### 5.4 `GET /app/schemes/:schemeId/payable-range` (`enrichPayableRange`)

**FIXED — single due instalment:**

```json
{
  "success": true,
  "data": {
    "model": "FIXED",
    "phase": null,
    "payable": true,
    "minPayable": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "maxPayable": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "suggested": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "cycleCap": null,
    "paidThisCycle": null,
    "remainingThisCycle": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "partialPaymentAllowed": false,
    "advancePaymentAllowed": false,
    "currentInstallmentNumber": 3,
    "positionVersion": 4,
    "expectedPositionVersion": 4,
    "paidMoneyNeverExpires": true,
    "unusedAllowanceCarriesForward": false
  }
}
```

**FIXED — partial + advance (max 2 instalments):**

```json
{
  "data": {
    "model": "FIXED",
    "payable": true,
    "minPayable": { "amountPaise": 100000, "amountDisplay": "₹1,000" },
    "maxPayable": { "amountPaise": 1000000, "amountDisplay": "₹10,000" },
    "allowedAmountsPaise": [500000, 1000000],
    "partialPaymentAllowed": true,
    "advancePaymentAllowed": true,
    "maxAdvanceInstallments": 2,
    "helperText": "Partial instalment payments are allowed. You can pay the current due instalment plus up to 2 future instalment(s) in one online payment."
  }
}
```

**FLEXIBLE free window (`phase: "FLEXIBLE"`):**

```json
{
  "data": {
    "model": "FLEXIBLE",
    "phase": "FLEXIBLE",
    "contributionIsOptional": true,
    "targetCycle": "2026-09",
    "payable": true,
    "minPayable": { "amountPaise": 10000, "amountDisplay": "₹100" },
    "maxPayable": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "cycleCap": null,
    "paidThisCycle": null,
    "remainingThisCycle": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
    "positionVersion": 3,
    "helperText": "Contributions are optional in this phase. Unused monthly allowance does not carry forward. Paid amounts remain in your scheme permanently."
  }
}
```

**FLEXIBLE capped — room remaining (NAKSHATHRA-style):**

```json
{
  "data": {
    "model": "FLEXIBLE",
    "phase": "CAPPED",
    "targetCycle": "2026-09",
    "payable": true,
    "minPayable": { "amountPaise": 10000, "amountDisplay": "₹100" },
    "maxPayable": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "cycleCap": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
    "paidThisCycle": { "amountPaise": 160000, "amountDisplay": "₹1,600" },
    "remainingThisCycle": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "nextCycleAction": "PAY_CURRENT_CYCLE",
    "positionVersion": 21,
    "expectedPositionVersion": 21,
    "allowFutureCycleSelection": false,
    "targetCycleOptions": []
  }
}
```

**FLEXIBLE capped — cycle cap reached:**

```json
{
  "data": {
    "model": "FLEXIBLE",
    "phase": "CAPPED",
    "payable": false,
    "maxPayable": { "amountPaise": 0, "amountDisplay": "₹0" },
    "remainingThisCycle": { "amountPaise": 0, "amountDisplay": "₹0" },
    "maxReason": "CYCLE_CAP_REACHED",
    "nextCycleAction": "WAIT_NEXT_CYCLE"
  }
}
```

**FLEXIBLE capped — future cycle allowed** (when plan enables): adds `"allowFutureCycleSelection": true`, `"targetCycleOptions": [{ "cycle": "2026-10", "label": "Oct 2026", "remaining": { … }, "isCurrentCycle": false }]`.

**Errors (409/422):** `SCHEME_NOT_ACTIVE`, `CYCLE_CLOSED`, `FUTURE_CYCLE_PAYMENT_NOT_ALLOWED`, `CURRENT_CYCLE_INCOMPLETE`, `CYCLE_SEQUENCE_VIOLATION`, `ADVANCE_CYCLE_LIMIT_EXCEEDED`.

---

### 5.5 `GET /app/schemes/:schemeId/settlement-preview`

Query: `?type=MATURITY_REDEMPTION|PREMATURE_CLOSURE`, optional `mode=CASH|GOLD_HANDOVER|PURCHASE_ADJUSTMENT`.

**Rupee (CASH) scheme — eligible at maturity:**

```json
{
  "success": true,
  "data": {
    "eligible": true,
    "blockers": [],
    "closureType": "MATURITY_REDEMPTION",
    "scheme": {
      "id": "sch_fixed_01",
      "schemeNumber": "ENR-0000001",
      "valueBasis": "CASH",
      "status": "MATURED",
      "maturityDate": "2027-03-01",
      "lockInMet": true
    },
    "computation": {
      "finalValue": { "amountPaise": 5500000, "amountDisplay": "₹55,000" }
    },
    "benefit": {
      "type": "ONE_FREE_INSTALLMENT",
      "applied": true,
      "value": { "amountPaise": 500000, "amountDisplay": "₹5,000" }
    },
    "allowedModes": ["CASH", "PURCHASE_ADJUSTMENT"],
    "modePreviews": undefined,
    "settlementPaise": 5500000,
    "valuationNote": "Gold rate not used for rupee-denominated plans."
  }
}
```

**GOLD_WEIGHT — `modePreviews` populated:**

```json
{
  "data": {
    "eligible": true,
    "scheme": { "valueBasis": "GOLD_WEIGHT", "status": "MATURED" },
    "computation": {
      "finalValue": { "amountPaise": 6200000, "amountDisplay": "₹62,000" },
      "goldWeight": { "weightMg": 8200, "weightDisplay": "8.200 g" }
    },
    "allowedModes": ["GOLD_HANDOVER", "CASH"],
    "modePreviews": {
      "GOLD_HANDOVER": {
        "rateApplied": { "ratePerGramPaise": 620000, "ratePerGramDisplay": "₹6,200/g" },
        "weight": { "weightMg": 8200, "weightDisplay": "8.200 g" },
        "note": "At today's rate of ₹6,200/g per gram"
      },
      "CASH": {
        "rateApplied": { "ratePerGramPaise": 620000, "ratePerGramDisplay": "₹6,200/g" },
        "weight": { "weightMg": 8200, "weightDisplay": "8.200 g" },
        "note": "Cash equivalent at ₹6,200/g per gram (2026-09-22)."
      }
    }
  }
}
```

**Not eligible (example blocker):**

```json
{
  "data": {
    "eligible": false,
    "blockers": [{ "code": "NOT_MATURED", "message": "Scheme matures on 2027-03-01." }],
    "scheme": { "status": "ACTIVE" }
  }
}
```

---

### 5.6 `GET /app/schemes/:schemeId` — `progressCard` by displayMode

Common envelope: `header`, `statCards[]`, `payButton`, `payableRange` (embedded when loaded), `planRules.sections[]`, `redemption`, `payments[]`, `version`, `positionVersion`.

**FIXED — `progressCard`:**

```json
{
  "displayMode": "FIXED",
  "progressCard": {
    "type": "FIXED",
    "installmentsPaid": 2,
    "installmentsTotal": 11
  },
  "payButton": {
    "visible": true,
    "enabled": true,
    "label": "Pay ₹5,000 with PhonePe"
  },
  "helperText": "Your plan matures on the contractual date even if all instalments are paid early."
}
```

**FLEXIBLE free window:**

```json
{
  "displayMode": "FLEXIBLE_FREE_WINDOW",
  "progressCard": {
    "type": "FLEXIBLE_FREE_WINDOW",
    "freeWindowMonth": 3,
    "freeWindowMonths": 6,
    "freeWindowMonthsCompleted": 2
  },
  "payButton": { "visible": true, "enabled": true, "label": "Contribute with PhonePe" },
  "helperText": "Flexible contributions are optional. Paid amounts never expire."
}
```

**FLEXIBLE capped:**

```json
{
  "displayMode": "FLEXIBLE_LOCK_WINDOW",
  "progressCard": {
    "type": "FLEXIBLE_LOCK_WINDOW",
    "cycleCap": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
    "paidThisCycle": { "amountPaise": 160000, "amountDisplay": "₹1,600" },
    "remainingThisCycle": { "amountPaise": 40000, "amountDisplay": "₹400" },
    "lockedAverage": { "amountPaise": 200000, "amountDisplay": "₹2,000" },
    "currentCycle": "2026-09"
  },
  "statCards": [
    { "label": "Total paid", "value": "₹90,000", "caption": "Permanent ledger balance" },
    { "label": "Monthly cap", "value": "₹2,000", "caption": "Snapshotted average" }
  ],
  "helperText": "Unused monthly allowance does not carry forward. Paid money never expires."
}
```

**Payments disabled** (`customerAppPaymentsEnabled: false`):

```json
{
  "payButton": {
    "visible": true,
    "enabled": false,
    "label": "Payments unavailable",
    "reason": "CUSTOMER_PAYMENTS_DISABLED",
    "helperText": "Online customer payments are currently unavailable. Contact your branch to continue."
  }
}
```

**MATURED — redemption UI:**

```json
{
  "status": "MATURED",
  "redemption": {
    "eligible": true,
    "status": "NOT_ELIGIBLE",
    "preferredModes": [
      { "mode": "GOLD_HANDOVER", "label": "Gold handover" },
      { "mode": "CASH", "label": "Cash" }
    ],
    "blocker": undefined
  },
  "payButton": { "visible": false, "enabled": false }
}
```

---

### 5.7 `POST /app/schemes/enrol`

**FIXED plan with first instalment (`payNow: true`):**

```json
{
  "success": true,
  "data": {
    "scheme": { "id": "sch_new", "schemeNumber": "ENR-0000100", "status": "PENDING_PAYMENT" },
    "paymentType": "FIXED_PAYMENT_LINK",
    "paymentLink": {
      "id": "plink_…",
      "gatewayUrl": "https://…",
      "amount": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
      "status": "OPEN"
    }
  }
}
```

**FLEXIBLE plan:**

```json
{
  "data": {
    "scheme": { "id": "sch_new", "displayMode": "FLEXIBLE_FREE_WINDOW", "status": "ACTIVE" },
    "paymentType": "FLEXIBLE_PAYMENT_INTENT",
    "paymentIntent": {
      "id": "pint_…",
      "amount": { "amountPaise": 10000, "amountDisplay": "₹100" },
      "status": "PENDING",
      "statusPollUrl": "/app/payment-intents/pint_…"
    }
  }
}
```

---

### 5.8 `GET /app/payments` — list item

**FIXED payment:**

```json
{
  "id": "pay_01",
  "amount": { "amountPaise": 500000, "amountDisplay": "₹5,000" },
  "status": "SUCCESS",
  "paymentPattern": "FIXED",
  "schemeNumber": "ENR-0000001",
  "targetCycle": null,
  "receiptDownloadPath": "/app/payments/pay_01/receipt"
}
```

**FLEXIBLE capped payment:**

```json
{
  "paymentPattern": "FLEXIBLE",
  "targetCycle": "2026-09",
  "channel": "ONLINE",
  "channelLabel": "Online"
}
```

---

## 6. Profile & auth by settings

### 6.1 `GET /app/profile` / `#24` — KYC

**`kycMandatory: false`:** `kyc` field **omitted** from profile.

**`kycMandatory: true`:**

```json
{
  "kyc": {
    "status": "NOT_SUBMITTED",
    "statusLabel": "Not submitted",
    "canUpdate": true,
    "verifiedAt": null
  }
}
```

### 6.2 Mutations when view-only

Any `POST`/`PUT`/`PATCH`/`DELETE` under `/app/*` (except auth refresh/logout): **`403`** `{ "code": "CUSTOMER_APP_VIEW_ONLY", … }`.

### 6.3 Pay mutations when payments off

`POST …/pay`, `…/payment-intents`, `…/pay/sdk-order`, public pay initiate: **`403`** `{ "code": "CUSTOMER_PAYMENTS_DISABLED", … }`.

---

## 8. Public signup routes (#11–#17)

Jeweller **platform onboarding** (creates a tenant), not customer scheme enrolment. All under `/api/v1/public/signup`.

### 8.1 `#11 POST /signup/start`

**Request:**

```json
{
  "businessName": "Nakshathra Jewellers",
  "ownerName": "Rajesh Kumar",
  "mobile": "+919876543210",
  "email": "owner@nakshathra.example",
  "city": "Thrissur"
}
```

**Response (201):**

```json
{
  "success": true,
  "data": {
    "signupId": "sgn_01EXAMPLE",
    "otpSent": true,
    "otpChannel": "WHATSAPP",
    "maskedMobile": "9876XXXX10",
    "expiresInSeconds": 300,
    "resendAvailableInSeconds": 30
  }
}
```

### 8.2 `#12 POST /signup/verify-otp`

**Request:** `{ "signupId": "sgn_01EXAMPLE", "otp": "123456" }`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "signupId": "sgn_01EXAMPLE",
    "verified": true,
    "signupToken": "sgnTok_…",
    "nextStep": "SELECT_PLAN"
  }
}
```

### 8.3 `#13 GET /signup/plans`

**Headers:** none (public list of **subscription** tiers for jewellers).

**Response (200):** `{ "success": true, "data": [ { "id", "tier", "name", "monthlyPrice", "features", … } ] }`

### 8.4 `#14 POST /signup/:signupId/select-plan`

**Headers:** `Authorization: Bearer <signupToken>`

**Request:** `{ "subscriptionPlanId": "subplan_starter", "billingCycle": "MONTHLY" }`

**Response (200):**

```json
{
  "success": true,
  "data": {
    "selectedPlan": { "tier": "STARTER", "name": "Starter" },
    "amount": { "amountPaise": 99900, "amountDisplay": "₹999" },
    "tax": { "amountPaise": 17982, "amountDisplay": "₹179.82" },
    "total": { "amountPaise": 117882, "amountDisplay": "₹1,178.82" },
    "trialDays": 14,
    "nextStep": "PAYMENT"
  }
}
```

### 8.5 `#15 POST /signup/:signupId/payment/initiate`

**Request:** `{ "redirectUrl": "https://admin.example.com/signup/complete" }`

**Response (200):** `{ "paymentSessionId", "checkoutUrl", "expiresAt" }` (gateway-specific).

### 8.6 `#16 GET /signup/:signupId/status`

**Headers:** signup token (status poll).

**Response (200):** `{ "status": "PLAN_SELECTED"|"PAYMENT_PENDING"|"PROVISIONED", "stage", "tenantCode?", "nextStep?" }`

### 8.7 `#17 GET /signup/check-availability`

**Query:** `?mobile=+919876543210` or `?tenantCode=NAKSHATHRAJE`

**Response (200):**

```json
{
  "success": true,
  "data": { "available": false, "reason": "MOBILE_ALREADY_REGISTERED" }
}
```

---

## 7. Per-route minimum examples (all 67)

Use **§5** when the “Variant” column applies; otherwise copy from [Appendix F](./API_CONTRACT_CUSTOMER.md#appendix-f--example-requests--responses).

| # | Request | Response highlight |
|---|---------|-------------------|
| 1–2 | — | F.1–F.2 |
| 3 | — | F.3 |
| 4 | — | F.4 |
| 5 | `{ tenantCode, mobile, purpose, deviceId }` | F.5 |
| 6 | `{ …, otp, otpId }` | F.6 + §2.1 capabilities |
| 7 | `{ tenantCode, mobile, password, deviceId }` | F.7 · errors: `CUSTOMER_PASSWORD_NOT_SET`, `INVALID_CREDENTIALS` |
| 8 | `{ resetToken, password, confirmPassword }` | F.8 |
| 9 | `?tenantCode=` \| `?mobile=` \| `?deepLinkToken=` | F.9 · §2.1 per tenant |
| 10 | — | F.10 |
| 11–17 | see §8 | jeweller SaaS signup |
| 18–20 | link token | §4 |
| 21 | — | binary |
| 22–26 | refresh/logout/devices | F.22–F.26 |
| 27 | `?includeTrends=&trendMonths=` | §5.1 full home shell + 3 card shapes |
| 28–33 | profile bodies | §6.1 + F.29–F.33 |
| 34–36 | presign/complete | F.34–F.36 |
| 37–38 | — | §5.2 |
| 39 | `?group=PAST` optional | §5.1 list / §5.3 past |
| 40 | `?targetCycle=` optional | §5.4 |
| 41 | — | `{ scheme, rows[], totals }` (ledger; labels follow displayMode) |
| 42 | `?type=&mode=` | §5.5 |
| 43 | — | §5.6 |
| 44 | `{ planId, payNow, redirectUrl, … }` | §5.7 |
| 45 | `{ amountPaise, redirectUrl }` | F.45 · **409** if not FIXED |
| 46 | `{ amountPaise, targetCycle?, expectedPositionVersion, redirectUrl }` | F.46 |
| 47 | same as 46 | F.47 + `providerOrderId` |
| 48–53 | — | F.48–F.53 · §4.2 |
| 54–66 | grievance/notification bodies | F.54–F.66 |
| 67 | `{ preferredMode, preferredDate?, remarks?, expectedVersion }` | F.67 |

---

*Generated from backend DTOs/services. When behaviour changes, update this file and Appendix F together.*
