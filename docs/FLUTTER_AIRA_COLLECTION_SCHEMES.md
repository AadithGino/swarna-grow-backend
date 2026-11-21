# Flutter: Aira collection schemes and one-time gold

**Source:** committed backend on `remediation/phase-1-isolation` (`782b984`). Uncommitted work (advance gold booking and later payment fixes) is not included.

**Prefix:** `/api/v1`  
**Auth:** customer bearer token from the jewellery OTP login in `FLUTTER_CUSTOMER_API_GUIDE.md`.  
**Money:** integer paise. **Weight:** milligrams on the wire; show `weightDisplay` when the API sends it. **Dates:** `YYYY-MM-DD`.  
**Gold rate:** the jeweller’s published 22K rate. Flutter displays server weight. It does not multiply rupees by a rate.

There are two new plan shapes in this commit. Aira’s seeded plans are only the first.

| Shape | How you recognise it | What the customer pays | What the bonus is |
|---|---|---|---|
| Collection gold | Plan has `collectionRules` | Many fixed collections (daily, weekly, or monthly) for the whole lock-in | One percentage of **net gold collected**, credited at maturity |
| One-time gold | Plan has `oneTimeRules` | **One** payment at enrolment. No later collections | Bonus gold credited on a schedule from that single payment |

Aira Gold (`AIRAGOLD`) seeds only collection plans:

| Code | Name | Lock-in | Bonus |
|---|---|---|---|
| `SWARNA` | Swarna | 3 months | 3% of net gold |
| `AKSHAYA` | Akshaya | 6 months | 7% of net gold |
| `TRITIYA` | Tritiya | 12 months | 15% of net gold |

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
      "paymentPatternLabel": "Fixed monthly",
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

`paymentPatternLabel` still says “Fixed monthly”. Ignore that label when `collectionRules` exists and use the frequency the customer picked.

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

## Part B — One-time gold

This plan is not in the Aira seed. A jeweller can still publish it. Flutter must branch on `oneTimeRules`, not on the plan name.

### What it does

The customer makes **one** gold purchase at enrolment. That payment buys the principal gold. There is no second, third, or daily collection. `installmentCount` is 1, partial and advance payments are off, and the first payment cannot be skipped.

The bonus is separate from the principal. The server credits it later, on the dates in `oneTimeProgress.periods`. The customer does not pay those dates. A background job credits them when the date arrives and, if needed, that day’s 22K rate exists.

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

Worked example from the server tests. Funding is ₹60,000 (`6000000` paise) at ₹6,000/g, so principal gold is 10,000 mg (10 g). Rules `{ "timing": "MONTHLY", "basis": "PRINCIPAL_PERCENT", "value": 7, "amountPeriod": "TERM_TOTAL" }` and `durationMonths: 3` mean 7% of 10 g = 700 mg total, split across 3 monthly credits. The dates for a 31 Jan 2028 funding day are 29 Feb, 31 Mar, and 30 Apr 2028. Maturity is 30 Apr 2028. The customer paid once, on 31 Jan.

`RUPEE_PAISE` does not credit until a 22K rate exists for that credit date. Until then the period stays `PENDING_RATE` and the scheme does not mature. `PRINCIPAL_PERCENT` and `FIXED_WEIGHT_MG` do not need a new rate to know the milligrams.

If the funding payment is reversed and nothing of the principal remains, pending credits are cancelled and the scheme closes with reason `ONE_TIME_FUNDING_REVERSED`. Early closure forfeits unpaid bonus.

After the funding payment succeeds, another pay attempt does not open. Do not show a pay button when `oneTimeProgress` exists and `payButton.enabled` is false.

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

### 1. Plan

```json
{
  "id": "spln_onetime",
  "code": "ONETIME",
  "displayName": "One-time Gold",
  "valueBasis": "GOLD_WEIGHT",
  "paymentPattern": "FIXED",
  "durationMonths": 3,
  "benefitType": "GOLD_BENEFIT",
  "oneTimeRules": {
    "timing": "MONTHLY",
    "basis": "PRINCIPAL_PERCENT",
    "value": 7,
    "amountPeriod": "TERM_TOTAL"
  },
  "enrol": {
    "amountMode": "JEWELLER_FIXED",
    "fixedAmount": { "amountPaise": 6000000, "amountRupees": 60000, "amountDisplay": "₹60,000" },
    "firstInstallmentModeDefault": "COLLECT_NOW",
    "firstInstallmentModeEditable": false,
    "firstInstallmentRequired": true
  },
  "canEnrol": true
}
```

Copy on screen:

- `MONTHLY` + `PRINCIPAL_PERCENT` + `TERM_TOTAL`: “Pay once. 7% of the gold you buy is added across the term, one credit a month.”
- `AT_MATURITY` + `PRINCIPAL_PERCENT`: “Pay once. 7% extra gold is added on the maturity date.”
- `FIXED_WEIGHT_MG`: “Pay once. A fixed gold bonus of {value} mg is added.” Show grams as `value / 1000`.
- `RUPEE_PAISE`: “Pay once. A rupee bonus of {value paise} is converted to gold on each credit date at that day’s rate.”

There is no frequency control. Do not send `collectionFrequency`.

### 2. Validate

```http
POST /api/v1/app/schemes/enrol/validate
```

```json
{
  "planId": "spln_onetime",
  "installmentAmountPaise": 6000000,
  "payNow": true
}
```

For `JEWELLER_FIXED`, send `enrol.fixedAmount.amountPaise`. For `CUSTOMER_CHOSEN`, send the amount the customer entered, inside min, max, and multiple.

```json
{
  "success": true,
  "data": {
    "canEnrol": true,
    "valid": true,
    "installmentAmountPaise": 6000000,
    "firstInstallmentRequired": true,
    "preview": {
      "installmentAmount": { "amountPaise": 6000000, "amountRupees": 60000, "amountDisplay": "₹60,000" },
      "installmentCount": 1,
      "totalPayable": { "amountPaise": 6000000, "amountRupees": 60000, "amountDisplay": "₹60,000" },
      "maturityDateProvisional": true,
      "firstDueDate": "2026-11-20",
      "maturityDate": "2027-02-20",
      "oneTimeSchedule": [
        { "period": 1, "dueDate": "2026-12-20", "status": "PENDING", "weightMg": 0 },
        { "period": 2, "dueDate": "2027-01-20", "status": "PENDING", "weightMg": 0 },
        { "period": 3, "dueDate": "2027-02-20", "status": "PENDING", "weightMg": 0 }
      ],
      "schedulePreview": [
        { "installmentNumber": 1, "dueDate": "2026-11-20", "amount": { "amountPaise": 6000000, "amountDisplay": "₹60,000" }, "note": "Collected at enrolment" }
      ]
    }
  }
}
```

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
  "planId": "spln_onetime",
  "installmentAmountPaise": 6000000,
  "payNow": true,
  "redirectUrl": "https://app.example/payment-return"
}
```

Response shape is the same `FIXED_PAYMENT_LINK` as Swarna. The scheme is `PENDING_PAYMENT` until that one payment is paid, then `ACTIVE`.

### 4. After payment

```http
GET /api/v1/app/schemes/sch_onetime
```

```json
{
  "success": true,
  "data": {
    "id": "sch_onetime",
    "schemeNumber": "ENR-0000010",
    "status": "ACTIVE",
    "valueBasis": "GOLD_WEIGHT",
    "displayMode": "FIXED",
    "maturityDate": "2027-02-20",
    "goldAccumulated": { "weightMg": 10000, "weightGrams": 10, "weightDisplay": "10 g" },
    "oneTimeProgress": {
      "rules": { "timing": "MONTHLY", "basis": "PRINCIPAL_PERCENT", "value": 7, "amountPeriod": "TERM_TOTAL" },
      "fundedOn": "2026-11-20",
      "maturityDate": "2027-02-20",
      "principalWeightMg": 10000,
      "fundingRatePerGramPaise": 600000,
      "originalPaidPaise": 6000000,
      "creditedWeightMg": 0,
      "redeemableBonusWeightMg": 0,
      "nextCreditDate": "2026-12-20",
      "periods": [
        { "period": 1, "dueDate": "2026-12-20", "status": "PENDING", "weightMg": 0 },
        { "period": 2, "dueDate": "2027-01-20", "status": "PENDING", "weightMg": 0 },
        { "period": 3, "dueDate": "2027-02-20", "status": "PENDING", "weightMg": 0 }
      ]
    },
    "payButton": { "visible": true, "enabled": false, "label": "Payments unavailable" },
    "maturityBenefit": { "type": "GOLD_BENEFIT", "title": "Scheduled gold bonus", "summary": "Bonus gold is held until maturity." },
    "redemption": { "eligible": false, "blocker": "Available after contractual maturity" }
  }
}
```

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

Same settlement-preview and redemption-request endpoints as other schemes. The bonus weight is included in the settlement quote only after the scheme is `MATURED` and every period that needs a rate is `CREDITED`. Offer only `redemption.preferredModes` from the plan. One-time plans reject a cash settlement that pays back only the rupees paid. Cash settlement uses gold value.

---

## How Flutter chooses a screen

```text
if plan.oneTimeRules        → one-time screen (one pay, then a bonus calendar)
else if plan.collectionRules → Aira screen (frequency + per-collection amount + many dues)
else if paymentPattern FIXED → existing monthly instalment screen
else                         → existing flexible contribution screen
```

On a scheme, the same test uses `oneTimeProgress` and `collectionFrequency`.
