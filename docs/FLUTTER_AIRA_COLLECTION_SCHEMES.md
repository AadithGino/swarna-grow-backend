# Flutter: Aira collection schemes and one-time gold

**Source:** SwarnaGrow backend with Aira upfront catalog (`AIRAUPFRONT`) and customer DTO presentation (`paymentPatternLabel`, `oneTimeProgress`).

**Prefix:** `/api/v1`  
**Auth:** customer bearer token from the jewellery OTP login in `FLUTTER_CUSTOMER_API_GUIDE.md`.  
**Money:** integer paise. **Weight:** milligrams on the wire; show `weightDisplay` when the API sends it. **Dates:** `YYYY-MM-DD`.  
**Gold rate:** the jeweller’s published 22K rate. Flutter displays server weight. It does not multiply rupees by a rate.

**Live tenant (Aira):** `AIRAGOLD` · tenant id `tnt_01M59TZGCJ5NTAV4ZVAG6PZZB0`. Customer slug `/customer/airagold`. Only **ACTIVE** plans with `availability.visibleInCustomerApp` appear in `GET /app/scheme-plans`. Enrolments already opened keep their **frozen `planSnapshot`**; do not assume every `AIRAUPFRONT` scheme matches the current catalog JSON.

---

## Flutter implementation plan

| Phase | Work | Done when |
|---|---|---|
| 1 — Routing | Branch plan list and enrol on `plan.oneTimeRules` vs `plan.collectionRules` vs other `paymentPattern` | Upfront flow never shows collection frequency; collection flow never shows upfront-only copy |
| 2 — Enrol UX | Amount step uses `enrol.minInstallment` / `maxInstallment` / `multipleOf`; validate before pay | Below min / above max / bad step returns server warnings; `installmentCount` in preview is **1** for upfront |
| 3 — Pay once | `payNow: true`, PhonePe link poll, no `collectionFrequency` on upfront | After success, scheme detail has `payButton.enabled: false` |
| 4 — Scheme detail | Bind bonus UI to `oneTimeProgress.periods` (not `installmentSchedule` for bonus dates) | Progress copy matches `progressLabel` / `nextActionLabel` from API; reload on push `SCHEME_GOLD_BONUS_CREDITED` |
| 5 — QA | Staging with real gateway + worker | See **Acceptance checks** below; maturity credits require **maintenance worker** (not API-only queue tick) |

---

## Plan shapes on Aira

| Shape | Detect | Customer pays | Bonus |
|---|---|---|---|
| Collection gold | `collectionRules` | Many collections (daily / weekly / monthly) for the lock-in | **One** % of net gold at maturity (`maturityGoldBonus`) |
| One-time gold | `oneTimeRules` | **One** payment at enrolment | Gold credited on **`oneTimeSchedule`** dates (server job) |

**Aira catalog (four active plans):**

| Code | Name | Lock-in | Bonus |
|---|---|---|---|
| `SWARNA` | Swarna | 3 months | 3% of net gold (at maturity) |
| `AKSHAYA` | Akshaya | 6 months | 7% of net gold (at maturity) |
| `TRITIYA` | Tritiya | 12 months | 15% of net gold (at maturity) |
| `AIRAUPFRONT` | Aira Upfront Gold Lock-in | 12 months | **2% of principal gold every month** (`PER_PERIOD`, no compounding) |

**`AIRAUPFRONT` limits (demo / staging ceiling):** min **₹1,00,000** (`10000000` paise), max **₹5,00,000** (`50000000` paise), step **₹1** (`multipleOfPaise: 100`). Match `maxInstallmentPaise` and `maxPaymentPerTransactionPaise` to the jeweller’s approved PhonePe ceiling before production.

**Catalog cutover note:** Older enrolments may still reference an inactive plan document (`AIRAUPFRONT_LEGACY`) whose snapshot used **12 instalments** and **manual `TEXT_ONLY` benefit**. Flutter must read **`scheme.planSnapshot` / `oneTimeProgress.rules`** on the scheme, not the current catalog plan, for those members.

---

## Part A — Collection gold (Swarna, Akshaya, Tritiya)

### What the scheme does

1. The customer picks a frequency and an amount **per collection**.
2. The server builds every due date from today until the lock-in ends.
3. The first row is due immediately. Enrolment stays `PENDING_PAYMENT` until that PhonePe payment succeeds.
4. The lock-in clock starts on the day that first payment is verified (`FIRST_PAYMENT_ANNIVERSARY`). If PhonePe succeeds on a later calendar day, start and maturity move to that day. Amounts do not change.
5. Each later success credits 22K gold for that rupee amount and marks that due row paid. Partial payment is not allowed.
6. When every row is paid and the maturity date is reached, the server credits `bonusPercent` of net accumulated gold once. Early closure forfeits that bonus.
7. Redemption is `GOLD_HANDOVER` or `PURCHASE_ADJUSTMENT` only.

Amount limits on the Aira plans: ₹50–₹1,00,000 per collection, steps of ₹1 (`5000`–`10000000` paise, multiple `100`).

Frequency changes the number of rows, not the lock-in length. ₹1,000 weekly for 3 months is about 13 payments of ₹1,000. ₹1,000 monthly for 3 months is 3 payments of ₹1,000. Daily is one row per day. `amountBasis` is `PER_COLLECTION`, so the chosen amount is repeated. It is not split across the term.

`schedulePreview` on validate returns **at most 12 rows**. Use `preview.installmentCount` and `preview.totalPayable` for the full picture.

### Flow

```text
GET  /app/scheme-plans
        show frequency picker only when collectionRules is present

POST /app/schemes/enrol/validate
        show preview.schedulePreview, totalPayable, maturityDate
        if maturityDateProvisional is true, say the lock-in starts when the first payment succeeds

POST /app/schemes/enrol          Idempotency-Key: new uuid
        data.paymentType = FIXED_PAYMENT_LINK
        open PhonePe with paymentLink, then poll

GET  /app/payments/{linkId}/status
        until paid is true

GET  /app/schemes/{schemeId}
        installmentSchedule, goldAccumulated, collectionBonus, payButton

later collections:
POST /app/schemes/{schemeId}/pay     body includes redirectUrl
        poll statusPollUrl
```

Do not call `/payment-intents` for these plans. They are `paymentPattern: FIXED`.

### 1. Plan

```http
GET /api/v1/app/scheme-plans
```

```json
{
  "success": true,
  "data": [
    {
      "id": "spln_swarna",
      "code": "SWARNA",
      "displayName": "Swarna",
      "valueBasis": "GOLD_WEIGHT",
      "valueBasisLabel": "Gold savings",
      "paymentPattern": "FIXED",
      "paymentPatternLabel": "Scheduled collections",
      "durationMonths": 3,
      "benefitType": "GOLD_BENEFIT",
      "benefitLabel": "3% additional gold at maturity",
      "collectionRules": {
        "frequencies": ["DAILY", "WEEKLY", "MONTHLY"],
        "amountBasis": "PER_COLLECTION",
        "maturityRule": "FIRST_PAYMENT_ANNIVERSARY"
      },
      "maturityGoldBonus": {
        "bonusBasis": "NET_GOLD_WEIGHT",
        "bonusPercent": 3,
        "requireAllCollections": true
      },
      "amountRules": {
        "amountMode": "CUSTOMER_CHOSEN",
        "minInstallmentPaise": 5000,
        "maxInstallmentPaise": 10000000,
        "multipleOfPaise": 100
      },
      "enrol": {
        "amountMode": "CUSTOMER_CHOSEN",
        "minInstallment": { "amountPaise": 5000, "amountRupees": 50, "amountDisplay": "₹50" },
        "maxInstallment": { "amountPaise": 10000000, "amountRupees": 100000, "amountDisplay": "₹1,00,000" },
        "multipleOf": { "amountPaise": 100, "amountRupees": 1, "amountDisplay": "₹1" },
        "firstInstallmentModeDefault": "COLLECT_NOW",
        "firstInstallmentModeEditable": false,
        "firstInstallmentRequired": true
      },
      "highlights": [
        "Choose daily, weekly, monthly collection",
        "3% additional gold at maturity"
      ],
      "canEnrol": true,
      "blockedReason": null
    }
  ]
}
```

The plan label is “Scheduled collections”. The enrolled scheme shows the selected `collectionFrequency`.

### 2. Validate (preview before pay)

```http
POST /api/v1/app/schemes/enrol/validate
Content-Type: application/json
```

```json
{
  "planId": "spln_swarna",
  "collectionFrequency": "WEEKLY",
  "installmentAmountPaise": 100000,
  "payNow": true
}
```

`installmentAmountPaise` is each collection, here ₹1,000.

```json
{
  "success": true,
  "data": {
    "canEnrol": true,
    "valid": true,
    "blockers": [],
    "warnings": [],
    "installmentAmountPaise": 100000,
    "firstInstallmentRequired": true,
    "preview": {
      "installmentAmount": { "amountPaise": 100000, "amountRupees": 1000, "amountDisplay": "₹1,000" },
      "installmentCount": 13,
      "totalPayable": { "amountPaise": 1300000, "amountRupees": 13000, "amountDisplay": "₹13,000" },
      "collectionFrequency": "WEEKLY",
      "amountBasis": "PER_COLLECTION",
      "maturityDateProvisional": true,
      "firstDueDate": "2026-11-20",
      "maturityDate": "2027-02-20",
      "benefit": { "type": "MATURITY_GOLD_CREDIT", "displayLabel": "3% additional gold at maturity" },
      "schedulePreview": [
        { "installmentNumber": 1, "dueDate": "2026-11-20", "amount": { "amountPaise": 100000, "amountDisplay": "₹1,000" }, "note": "Collected at enrolment" },
        { "installmentNumber": 2, "dueDate": "2026-11-27", "amount": { "amountPaise": 100000, "amountDisplay": "₹1,000" }, "note": null }
      ]
    }
  }
}
```

`installmentCount` in this example is illustrative. Trust the number the server returns. The preview list stops at 12 rows even when `installmentCount` is larger.

If the amount is missing:

```json
{
  "success": true,
  "data": {
    "canEnrol": true,
    "valid": false,
    "warnings": [{ "code": "INSTALLMENT_AMOUNT_REQUIRED", "message": "Choose an installment amount for this plan.", "resolvable": true }],
    "preview": null
  }
}
```

If enrol is impossible, HTTP is still 200 and `canEnrol` is false:

```json
{
  "success": true,
  "data": {
    "canEnrol": false,
    "valid": false,
    "blockers": [{ "code": "GOLD_RATE_NOT_SET", "message": "Set the applicable 22K gold rate before accepting this collection.", "resolvable": true }],
    "preview": null
  }
}
```

### 3. Enrol and pay the first collection

```http
POST /api/v1/app/schemes/enrol
X-Idempotency-Key: 7c1a0b2e-4f3d-4a1e-9c2b-6d5e4f3a2b10
```

Send the same frequency and amount the customer just confirmed. Optionally echo the preview so a changed schedule is rejected instead of charging the wrong dates:

```json
{
  "planId": "spln_swarna",
  "collectionFrequency": "WEEKLY",
  "installmentAmountPaise": 100000,
  "payNow": true,
  "redirectUrl": "https://app.example/payment-return",
  "expectedFirstCollectionPaise": 100000,
  "expectedMaturityDate": "2027-02-20"
}
```

`payNow` must be true. A new idempotency key is required for each new attempt. Reusing a key with a different body returns 409 `IDEMPOTENCY_KEY_REUSED`.

```json
{
  "success": true,
  "data": {
    "scheme": { "id": "sch_01EXAMPLE", "schemeNumber": "ENR-0000007" },
    "paymentType": "FIXED_PAYMENT_LINK",
    "paymentLink": {
      "id": "plk_01EXAMPLE",
      "paymentLinkId": "plk_01EXAMPLE",
      "token": "link-token",
      "gatewayUrl": "https://phonepe.example/pay/...",
      "amount": { "amountPaise": 100000, "amountRupees": 1000, "amountDisplay": "₹1,000" },
      "status": "CREATED",
      "expiresAt": "2026-11-20T10:30:00.000Z",
      "transactionId": "pay_01EXAMPLE"
    }
  }
}
```

Poll:

```http
GET /api/v1/app/payments/plk_01EXAMPLE/status
```

```json
{
  "success": true,
  "data": {
    "linkId": "plk_01EXAMPLE",
    "status": "PAID",
    "processing": false,
    "paid": true,
    "failed": false,
    "receipt": { "paymentId": "pay_01EXAMPLE", "receiptNumber": "RCP-2026-0000042", "paidAt": "2026-11-20T10:05:00.000Z" },
    "retryAfterSeconds": null
  }
}
```

While `processing` is true, wait `retryAfterSeconds` and poll again. After `paid: true`, load the scheme. Status moves from `PENDING_PAYMENT` to `ACTIVE`. If the payment day is after the enrolment day, `startDate` and `maturityDate` follow the payment day.

### 4. Scheme detail

```http
GET /api/v1/app/schemes/sch_01EXAMPLE
```

```json
{
  "success": true,
  "data": {
    "id": "sch_01EXAMPLE",
    "schemeNumber": "ENR-0000007",
    "planName": "Swarna",
    "status": "ACTIVE",
    "valueBasis": "GOLD_WEIGHT",
    "displayMode": "FIXED",
    "collectionFrequency": "WEEKLY",
    "maturityDate": "2027-02-20",
    "goldAccumulated": { "weightMg": 1389, "weightGrams": 1.389, "weightDisplay": "1.389 g" },
    "collectionBonus": { "status": "PENDING", "weightMg": 0, "estimatedWeightMg": 42 },
    "maturityBenefit": {
      "type": "GOLD_BENEFIT",
      "title": "3% additional gold at maturity",
      "summary": "Based on net gold accumulated."
    },
    "progressCard": { "installmentsPaid": 1, "installmentsTotal": 13 },
    "installmentSchedule": [
      { "number": 1, "dueDate": "2026-11-20", "status": "PAID", "amount": { "amountPaise": 100000, "amountDisplay": "₹1,000" }, "remaining": { "amountPaise": 0, "amountDisplay": "₹0" } },
      { "number": 2, "dueDate": "2026-11-27", "status": "PENDING", "amount": { "amountPaise": 100000, "amountDisplay": "₹1,000" }, "remaining": { "amountPaise": 100000, "amountDisplay": "₹1,000" } }
    ],
    "payButton": { "visible": true, "enabled": true, "label": "Pay ₹1,000 with PhonePe" },
    "redemption": { "eligible": false, "blocker": "Available after contractual maturity" }
  }
}
```

`collectionBonus.status`:

| Status | Meaning |
|---|---|
| `PENDING` | Not matured. `estimatedWeightMg` is a preview of the percentage, not gold already owned |
| `PENDING_RATE` | Matured, but that day’s 22K rate is missing. Redemption stays blocked |
| `CREDITED` | Bonus is on the ledger (`weightMg`, `ledgerEntryId`) |
| `INELIGIBLE` | Closed early or the schedule was not completed. Weight is 0 |

### 5. Later collections

```http
POST /api/v1/app/schemes/sch_01EXAMPLE/pay
X-Idempotency-Key: <new uuid>
```

```json
{ "redirectUrl": "https://app.example/payment-return" }
```

The server prices the next unpaid row. Do not send a custom amount. With `redirectUrl`, the response adds PhonePe fields:

```json
{
  "success": true,
  "data": {
    "id": "plk_02EXAMPLE",
    "paymentLinkId": "plk_02EXAMPLE",
    "amount": { "amountPaise": 100000, "amountDisplay": "₹1,000" },
    "checkoutKind": "SDK_ORDER",
    "provider": "PHONEPE",
    "token": "sdk-token",
    "sdkToken": "sdk-token",
    "statusPollUrl": "/app/payments/plk_02EXAMPLE/status",
    "retryAfterSeconds": 3
  }
}
```

Open the SDK with `sdkToken` when `checkoutKind` is `SDK_ORDER`, or open `paymentUrl` when it is `HOSTED_REDIRECT`. Poll `statusPollUrl` the same way as the first payment.

Each success adds a payment row with `valueBasis: "GOLD_WEIGHT"` and a server `goldAccrual`. Show that. Do not recompute it.

### 6. Maturity

```http
GET /api/v1/app/schemes/sch_01EXAMPLE/settlement-preview?type=MATURITY_REDEMPTION&mode=GOLD_HANDOVER
```

Call this only with a mode from `redemption.preferredModes`. If `collectionBonus.status` is `PENDING_RATE`, the scheme screen blocker is “Available once the maturity gold bonus is resolved”. Wait for the rate, then reload.

```http
POST /api/v1/app/schemes/sch_01EXAMPLE/redemption-request
X-Idempotency-Key: <new uuid>
```

```json
{ "preferredMode": "GOLD_HANDOVER", "expectedVersion": 4 }
```

Handover OTP after staff release is in `FLUTTER_CUSTOMER_HANDOVER_OTP_AND_SUPPORT.md`.

### Collection errors

| HTTP | `error.code` | Flutter |
|---|---|---|
| 422 | `INVALID_COLLECTION_FREQUENCY` | Frequency missing or not in `collectionRules.frequencies` |
| 422 | `GOLD_RATE_NOT_SET` | Block enrol and pay until the jeweller publishes today’s 22K rate |
| 422 | `GOLD_WEIGHT_ROUNDS_TO_ZERO` | Amount is too small to credit gold. Raise it or pick a less frequent schedule |
| 422 | `FIRST_INSTALLMENT_MODE_LOCKED` | Customer tried to skip the first payment |
| 409 | `COLLECTION_SCHEDULE_CHANGED` | `expectedFirstCollectionPaise` or `expectedMaturityDate` no longer matches. Validate again and show the new dates |
| 409 | `IDEMPOTENCY_KEY_REUSED` | Same key, different body. New key, same confirmed body |

---

## Part B — Aira upfront gold (`AIRAUPFRONT`)

Use this part for the **live Aira** product. Generic one-time shapes for other jewellers or unit tests are in **Part C** at the end of this file.

### What it does

The customer makes **one** gold purchase at enrolment (amount between plan min and max). That payment buys **principal gold** (`goldAccumulated`). There are **no** collection frequencies and **no** further customer payments: `installmentCount` is **1**, partial/advance payments are off, first payment is **COLLECT_NOW** and required.

**Bonus gold** is separate. The server posts it on each date in `oneTimeProgress.periods` (12 rows for Aira). The customer never pays those dates. Credits run from the **maintenance worker** (daily batch, Asia/Kolkata — align with ops; Vercel queue-tick alone is **not** sufficient for maturity / one-time credits).

For Aira, `oneTimeRules` is:

```json
{
  "timing": "MONTHLY",
  "basis": "PRINCIPAL_PERCENT",
  "value": 2,
  "amountPeriod": "PER_PERIOD"
}
```

**Worked example:** Funding **₹1,00,000** at **₹6,000/g** → principal **10,000 mg** (10 g). Each month credits **2%** of principal → **200 mg** per period, **2,400 mg** total over 12 months (HALF_UP rounding per server rules). First credit date is **one calendar month after** `oneTimeGold.fundedOn`; last credit date is **maturity**.

`oneTimeRules`:

| Field | Values | Meaning |
|---|---|---|
| `timing` | `MONTHLY` | One bonus credit per month of `durationMonths`. First credit is one month after the funding day. The last credit date is maturity |
| `timing` | `AT_MATURITY` | A single credit on the maturity date (`durationMonths` after funding) |
| `basis` | `PRINCIPAL_PERCENT` | `value` is a percent of the principal gold weight. `7` means 7% |
| `basis` | `FIXED_WEIGHT_MG` | `value` is a fixed milligram bonus, scaled down if the funding payment is later reduced |
| `basis` | `RUPEE_PAISE` | `value` is a rupee bonus in paise, converted to gold at the **credit day’s** 22K rate |
| `amountPeriod` | `TERM_TOTAL` | `value` is the total bonus, split across the credit dates |
| `amountPeriod` | `PER_PERIOD` | `value` is credited again on every date |

`AT_MATURITY` is only valid with `amountPeriod: TERM_TOTAL`.

Field reference (all one-time plans, including non-Aira):

`RUPEE_PAISE` does not credit until a 22K rate exists for that credit date. Until then the period stays `PENDING_RATE` and the scheme may not mature. `PRINCIPAL_PERCENT` and `FIXED_WEIGHT_MG` do not need a new rate to know the milligrams.

If the funding payment is reversed and nothing of the principal remains, pending credits are cancelled and the scheme closes with reason `ONE_TIME_FUNDING_REVERSED`. Early closure forfeits unpaid bonus.

After the funding payment succeeds, another pay attempt does not open. Use `payButton.visible` and `payButton.enabled`. Both are false after the upfront payment succeeds.

### Flow

```text
GET  /app/scheme-plans
        branch when oneTimeRules is present
        hide the frequency picker
        amount comes from enrol.fixedAmount or the customer-chosen limits

POST /app/schemes/enrol/validate
        preview.oneTimeSchedule is the bonus calendar, not payment dates
        preview.installmentCount is 1
        preview.maturityDateProvisional is true

POST /app/schemes/enrol     payNow true, no collectionFrequency
        same FIXED_PAYMENT_LINK response as collection gold
        poll until paid

GET  /app/schemes/{id}
        oneTimeProgress.periods
        do not ask the customer to pay a period
        goldAccumulated is principal gold
        credited bonus is oneTimeProgress.creditedWeightMg
```

### 1. Plan list item (`AIRAUPFRONT`)

```http
GET /api/v1/app/scheme-plans
```

```json
{
  "id": "spl_01M837Q9Q7R4CYGEC6DVFF8XD6",
  "code": "AIRAUPFRONT",
  "displayName": "Aira Upfront Gold Lock-in",
  "valueBasis": "GOLD_WEIGHT",
  "valueBasisLabel": "Gold savings",
  "paymentPattern": "FIXED",
  "paymentPatternLabel": "One upfront payment",
  "durationMonths": 12,
  "installmentCount": 1,
  "benefitType": "GOLD_BENEFIT",
  "benefitLabel": "2% of principal gold credited monthly",
  "oneTimeRules": {
    "timing": "MONTHLY",
    "basis": "PRINCIPAL_PERCENT",
    "value": 2,
    "amountPeriod": "PER_PERIOD"
  },
  "amountRules": {
    "amountMode": "CUSTOMER_CHOSEN",
    "minInstallmentPaise": 10000000,
    "maxInstallmentPaise": 50000000,
    "multipleOfPaise": 100
  },
  "enrol": {
    "amountMode": "CUSTOMER_CHOSEN",
    "minInstallment": { "amountPaise": 10000000, "amountRupees": 100000, "amountDisplay": "₹1,00,000" },
    "maxInstallment": { "amountPaise": 50000000, "amountRupees": 500000, "amountDisplay": "₹5,00,000" },
    "multipleOf": { "amountPaise": 100, "amountRupees": 1, "amountDisplay": "₹1" },
    "firstInstallmentModeDefault": "COLLECT_NOW",
    "firstInstallmentModeEditable": false,
    "firstInstallmentRequired": true
  },
  "highlights": [
    "One full payment at enrolment",
    "2% of principal gold credited monthly"
  ],
  "canEnrol": true,
  "blockedReason": null
}
```

**Flutter copy (Aira):** Lead with **“One upfront payment”** (`paymentPatternLabel`). Amount step: **₹1,00,000 – ₹5,00,000** (or whatever the API returns). Benefit line: use `benefitLabel` / highlights — do not invent compounding text.

There is **no** frequency control. Do **not** send `collectionFrequency`.

### 2. Validate

```http
POST /api/v1/app/schemes/enrol/validate
```

```json
{
  "planId": "spl_01M837Q9Q7R4CYGEC6DVFF8XD6",
  "installmentAmountPaise": 10000000,
  "payNow": true
}
```

Reject amounts below `10000000`, above `maxInstallmentPaise`, or not divisible by `multipleOfPaise` using server `warnings` / `blockers`.

```json
{
  "success": true,
  "data": {
    "canEnrol": true,
    "valid": true,
    "installmentAmountPaise": 10000000,
    "firstInstallmentRequired": true,
    "preview": {
      "installmentAmount": { "amountPaise": 10000000, "amountRupees": 100000, "amountDisplay": "₹1,00,000" },
      "installmentCount": 1,
      "totalPayable": { "amountPaise": 10000000, "amountRupees": 100000, "amountDisplay": "₹1,00,000" },
      "maturityDateProvisional": true,
      "firstDueDate": "2026-11-20",
      "maturityDate": "2027-11-20",
      "oneTimeSchedule": [
        { "period": 1, "dueDate": "2026-12-20", "status": "PENDING", "weightMg": 0 },
        { "period": 2, "dueDate": "2027-01-20", "status": "PENDING", "weightMg": 0 }
      ],
      "schedulePreview": [
        { "installmentNumber": 1, "dueDate": "2026-11-20", "amount": { "amountPaise": 10000000, "amountDisplay": "₹1,00,000" }, "note": "Collected at enrolment" }
      ]
    }
  }
}
```

(`oneTimeSchedule` has **12** periods in production; the JSON above is truncated.)

Read the two lists differently:

- `schedulePreview` is the money the customer pays. For this plan that is one row, due today.
- `oneTimeSchedule` is when bonus gold will be credited. Weight is 0 until the job runs. `AT_MATURITY` returns a single row whose `dueDate` equals `maturityDate`.

`maturityDateProvisional: true` means the dates shift to the day the PhonePe payment actually succeeds.

### 3. Enrol

```http
POST /api/v1/app/schemes/enrol
X-Idempotency-Key: <new uuid>
```

```json
{
  "planId": "spl_01M837Q9Q7R4CYGEC6DVFF8XD6",
  "installmentAmountPaise": 10000000,
  "payNow": true,
  "redirectUrl": "https://app.example/payment-return"
}
```

Response shape is the same `FIXED_PAYMENT_LINK` as Swarna. The scheme is `PENDING_PAYMENT` until that one payment is paid, then `ACTIVE`. Gateway max must be ≥ chosen upfront amount.

### 4. After payment

```http
GET /api/v1/app/schemes/{schemeId}
```

```json
{
  "success": true,
  "data": {
    "id": "sch_01EXAMPLE",
    "schemeNumber": "ENR-0000100",
    "planCode": "AIRAUPFRONT",
    "status": "ACTIVE",
    "valueBasis": "GOLD_WEIGHT",
    "displayMode": "FIXED",
    "maturityDate": "2027-11-20",
    "goldAccumulated": { "weightMg": 10000, "weightGrams": 10, "weightDisplay": "10 g" },
    "oneTimeProgress": {
      "rules": { "timing": "MONTHLY", "basis": "PRINCIPAL_PERCENT", "value": 2, "amountPeriod": "PER_PERIOD" },
      "fundedOn": "2026-11-20",
      "maturityDate": "2027-11-20",
      "principalWeightMg": 10000,
      "fundingRatePerGramPaise": 600000,
      "originalPaidPaise": 10000000,
      "creditedWeightMg": 0,
      "redeemableBonusWeightMg": 0,
      "nextCreditDate": "2026-12-20",
      "periods": [
        { "period": 1, "dueDate": "2026-12-20", "status": "PENDING", "weightMg": 0 }
      ]
    },
    "progressLabel": "0 of 12 gold credits posted",
    "nextActionLabel": "Next gold credit · 2026-12-20",
    "payButton": { "visible": false, "enabled": false, "label": "Payments unavailable" },
    "maturityBenefit": {
      "type": "GOLD_BENEFIT",
      "title": "2% of principal gold credited monthly",
      "summary": "Posted bonus gold becomes redeemable at maturity."
    },
    "redemption": { "eligible": false, "blocker": "Available after contractual maturity" }
  }
}
```

(`periods` length is **12**; after each maintenance credit, `creditedWeightMg` increases by ~200 mg for a 10 g principal until maturity.)

Period `status`:

| Status | UI |
|---|---|
| `PENDING` | Credit date has not arrived |
| `PENDING_RATE` | Date arrived and this bonus is `RUPEE_PAISE`, but that day’s 22K rate is missing |
| `CREDITED` | `weightMg` was added. A push of type `SCHEME_GOLD_BONUS_CREDITED` is sent |
| `FORFEITED` | Scheme closed early |
| `CANCELLED` | Funding was reversed, or the scheme reached a terminal state before the date |

`creditedWeightMg` is the sum of credited periods. `redeemableBonusWeightMg` stays 0 until status is `MATURED`, then it equals the credited bonus. Principal gold stays in `goldAccumulated`. The customer owns principal immediately. Bonus gold is added only as periods credit.

Reload the scheme when the app opens and when a `SCHEME_GOLD_BONUS_CREDITED` push arrives. There is no customer API to “claim” a period.

### 5. Redemption

Same settlement-preview and redemption-request endpoints as other schemes. The bonus weight is included in the settlement quote only after the scheme is `MATURED` and every period that needs a rate is `CREDITED`. Offer only `redemption.preferredModes` from the plan (`GOLD_HANDOVER`, `PURCHASE_ADJUSTMENT` for Aira). Premature closure is **not** allowed on the new catalog plan.

### Acceptance checks (Flutter + staging)

| Check | Expected |
|---|---|
| Plan catalog | Only one active `AIRAUPFRONT`; `paymentPatternLabel` = “One upfront payment”; no frequency picker |
| Validate | `schedulePreview.length === 1`, `oneTimeSchedule.length === 12`, `totalPayable` = chosen upfront |
| After funding | `payButton.enabled === false`; `oneTimeProgress.fundedOn` set; 12 `PENDING` periods |
| Credits | No bonus before `dueDate`; one ledger credit per period when worker runs; ~200 mg/month for 10 g principal |
| Maturity | Status `MATURED`; redemption quote includes principal + posted bonus gold |
| Legacy schemes | UI still works when `planSnapshot` lacks `oneTimeRules` (old TEXT_ONLY catalog) — show staff terms, do not treat as new upfront automation |

---

## Part C — Generic one-time gold (non-Aira / tests)

Other jewellers may publish different `oneTimeRules` (3-month `TERM_TOTAL` 7%, `AT_MATURITY`, `RUPEE_PAISE`, etc.). Flutter logic is the same: branch on `plan.oneTimeRules` / `scheme.oneTimeProgress`.

**Test fixture example** (not Aira catalog): ₹60,000 fixed, 3 months, 7% total split monthly:

```json
{
  "code": "ONETIME7",
  "durationMonths": 3,
  "installmentCount": 1,
  "oneTimeRules": {
    "timing": "MONTHLY",
    "basis": "PRINCIPAL_PERCENT",
    "value": 7,
    "amountPeriod": "TERM_TOTAL"
  },
  "amountRules": {
    "amountMode": "JEWELLER_FIXED",
    "fixedAmountPaise": 6000000
  }
}
```

Copy helpers for arbitrary rules:

- `MONTHLY` + `PRINCIPAL_PERCENT` + `TERM_TOTAL`: “Pay once. {value}% of the gold you buy is added across the term, one credit a month.”
- `MONTHLY` + `PRINCIPAL_PERCENT` + `PER_PERIOD` (Aira): “Pay once. {value}% of principal gold credited each month.”
- `AT_MATURITY` + `PRINCIPAL_PERCENT`: “Pay once. {value}% extra gold on the maturity date.”
- `FIXED_WEIGHT_MG`: fixed mg bonus per period or at maturity per `amountPeriod`.
- `RUPEE_PAISE`: rupee bonus converted at each credit day’s 22K rate.

---

## How Flutter chooses a screen

```text
if plan.oneTimeRules        → upfront screen (one pay + bonus calendar; Aira = AIRAUPFRONT)
else if plan.collectionRules → Aira collection (frequency + per-collection amount + many dues)
else if paymentPattern FIXED → existing monthly instalment screen
else                         → existing flexible contribution screen
```

On a **plan** card, use `oneTimeRules` or `collectionRules`. On **scheme** detail, use `oneTimeProgress.periods` for bonus dates and `installmentSchedule` (length 1) for the funding payment — never mix bonus due dates with collection dues.
