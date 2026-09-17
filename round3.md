# Cursor prompt — SwarnaGrow backend, round 3 remediation (N1–N36)

Paste this into Cursor with the `swarnagrow-backend` repo open. This covers the 36 findings
from the third-party audit (`SwarnaGrow_Backend_Production_Audit_2026-09-17.md`), on top of the
17 already fixed in the previous round. All 36 were independently re-verified against the actual
code before this prompt was written — file, line, and mechanism confirmed for every one, not
taken on the audit's word.

Work through phases in order. Do not start a phase until the previous one's tests pass.

---

## Ground rules (same as last round — repeating because they matter most here)

- **Match existing style exactly.** Dense one-liners where the file already uses them, ESM
  imports, `asyncHandler`, `errors.*`/`AppError`, `withTransaction`, `sendSuccess`, `guarded(...)`.
- **Never change the response envelope.** `{ success, data, meta }`, lists use `data: []` +
  `meta.nextCursor`/`hasMore`.
- **Every fix needs a regression test that fails on current code and passes after your fix.**
  If you can't write one that fails first, you haven't reproduced the bug.
- **Don't fix anything not on this list.** Leave a `// TODO(audit):` comment for anything else
  you notice and move on.
- **After every phase:** `npm run check && npm test` must pass.
- **This round touches the same permission system the last round hardened.** Before changing
  anything in `permissions.js`, `auth.middleware.js`, or any route file, re-read what the last
  round already did there so you don't undo it. If you find the previous round's fix for a
  related issue (e.g. the stale-JWT-permissions fix, or the admin route guards) is incomplete
  in a way this round's findings expose, extend it — don't replace it.
- **Some of these 36 interact with each other.** Where a phase note says "do this together with
  N-whatever," it's because fixing one without the other either doesn't close the hole or
  breaks something. Read the whole phase before starting it.

---

## PHASE 1 — Critical. Stop everything else until these three are done.

### 1.1 — N1: Staff routes have zero permission enforcement

**File:** `src/routes/staff.routes.js`, `scripts/check-route-coverage.js`

**Problem:** `/staff` is mounted with only `authenticate, requireSubject("TENANT_USER"),
tenantScope` — no permission gate. Every route in `staff.routes.js` is reachable by any
authenticated tenant user with a branch, including `COLLECTION_AGENT`, whose permission set in
`permissions.js` explicitly excludes `CUSTOMER_WRITE`, `CUSTOMER_KYC`,
`CUSTOMER_PASSWORD_WRITE`, `SCHEME_WRITE`, `GRIEVANCE_READ`, `GRIEVANCE_REPLY` — none of which is
checked anywhere in the route file.

**Fix:**
1. Add `guarded(Permission.X, ...)` to every route in `staff.routes.js`, using the permission
   each operation actually needs per `ROLE_PERMISSIONS` in `permissions.js`:
   - `POST /customers`, `PATCH /customers/:id` → `CUSTOMER_WRITE`
   - `GET /customers`, `GET /customers/check-mobile`, `GET /customers/:id` → `CUSTOMER_READ`
   - `POST /customers/:id/set-password` → `CUSTOMER_PASSWORD_WRITE`
   - `PUT /customers/:id/kyc` → `CUSTOMER_KYC`
   - `GET/PUT/DELETE /customers/:id/nominee` → `CUSTOMER_WRITE` (read variant can use
     `CUSTOMER_READ` if you want finer granularity — check whether the contract distinguishes
     nominee-read from nominee-write; if unclear, `CUSTOMER_WRITE` for all three is the safer
     default since nominee data is sensitive)
   - `GET /customers/:id/audit-events` → `AUDIT_READ` (see 1.1a below — this one also needs a
     branch-scope fix, not just a permission)
   - `GET /scheme-plans` → `PLAN_READ`
   - `POST /schemes/enrol/validate`, `POST /schemes/enrol` → `SCHEME_WRITE`
   - `GET /schemes/:id/payable-range`, `GET /schemes/:id/passbook`, `GET /schemes/:id` →
     `SCHEME_READ`
   - `POST /payments`, `POST /payment-links`, `POST /payments/:id/share-whatsapp` →
     `PAYMENT_RECORD`
   - `GET /payments`, `GET /payments/:id`, `GET /payments/:id/receipt` → `PAYMENT_READ`
   - `GET /collections/summary` → `PAYMENT_READ`
   - `GET /cash/summary`, `GET /cash/collections`, `GET /cash/handovers`,
     `GET /cash/handovers/:id` → `CASH_READ`
   - `POST /cash/handovers`, `POST /cash/handovers/:id/cancel` → `CASH_HANDOVER`
   - `GET /dues`, `GET /overdues` → `SCHEME_READ` (or `REPORT_READ` if that's the more
     appropriate existing permission — check how the equivalent `/admin` routes for the same
     data are guarded and match it)
   - `GET /grievances`, `GET /grievances/:id` → `GRIEVANCE_READ`
   - `POST /grievances/:id/messages` → `GRIEVANCE_REPLY`
   - `GET /gold-rate/current` → `GOLD_RATE_READ`
   - `GET /home`, `GET /dashboard/summary`, `GET /profile`, `POST/DELETE /devices/fcm-token`,
     `GET /notifications` — these are self-service/own-identity operations with no natural
     resource permission (a collection agent should be able to see their own home screen and
     manage their own device token). Leave these ungated on permission but confirm each one only
     ever reads/writes `req.auth.id`-scoped data — if any of them reads beyond that (see N27
     below for `/notifications` specifically), fix the query, not the permission.

2. **N27 lives in this same file — fix it in the same pass.** `GET /notifications` currently
   queries `Message.find({ tenantId, branchId })` with no filter tying it to anything the caller
   should see — a collection agent gets every branch-wide message including grievance replies.
   Scope this query to messages that are actually relevant to a staff member (e.g. reminders/
   alerts they're meant to action), not the full `Message` collection. If there's no existing
   concept of "staff-relevant message type," add a `audience` or `type`-based filter rather than
   inventing a new field — check `MessageType` in `enums.js` for what's already there.

3. **Add branch-scope checks after permission checks, everywhere in this file that touches a
   specific resource by id** (`:customerId`, `:schemeId`, `:paymentId`, `:handoverId`,
   `:grievanceId`). `tenantScope` already puts `req.scope.branchId` on the request for
   branch-scoped roles — confirm every service function this file's controllers call actually
   applies `req.scope` to its query (most already do via `...req.scope` in the `findOne` filter —
   verify this holds for every route added in step 1, don't assume).

4. **Extend `scripts/check-route-coverage.js`** so it fails the build when *any* non-public
   route — staff included, not just admin — lacks a permission declaration. This is what stops
   this exact class of bug from coming back. If the script currently only walks admin route
   files, generalize it to walk `staff.routes.js` and `app.routes.js` too (customer app routes
   need the equivalent self-service exception logic from step 1's last bullet — a route that
   only ever touches `req.auth.id`-scoped data can be allow-listed explicitly by name in the
   script, everything else must have a permission).

**Test:** `tests/authorization.test.js` (extend) — add `COLLECTION_AGENT` to the role×route
matrix for every staff route. Assert 403 on everything the role's permission array excludes,
200/201/202 (or whatever's correct) on everything it includes. Add a specific test: a
`COLLECTION_AGENT` token hitting `POST /staff/customers`, `PUT /staff/customers/:id/kyc`,
`POST /staff/schemes/enrol`, and `POST /staff/grievances/:id/messages` all get 403.

---

### 1.2 — N2: Customer redemption can settle for ₹0

**File:** `src/services/redemption.service.js`

**Problem:** `requestCustomerRedemption` creates a `Redemption` row with
`principalPaise/benefitPaise/penaltyPaise/settlementPaise` all hardcoded to `0`, no maturity
check. `transitionRedemption`'s `complete` action debits the ledger using
`row.settlementPaise ?? 0` — whatever was stored at request time. There is no step anywhere that
recomputes real numbers between request and completion.

**Fix:**
1. There's already a real settlement calculator in this file — `settlementPreview` (the function
   used for the admin-initiated preview/redeem flow, referenced around the top of the file).
   `requestCustomerRedemption` must call the **same** calculator, not skip it. Read
   `settlementPreview`'s signature and what it needs (scheme, closureType, ledger totals, plan
   snapshot rules) before wiring it in.
2. `requestCustomerRedemption` must also require `scheme.status === SchemeStatus.MATURED` (or
   whatever the correct closure-type-appropriate check is — a premature closure request has
   different eligibility than a maturity redemption; check how the admin-side `close-premature`
   flow gates this and mirror it) before creating the row at all. If the scheme isn't eligible,
   throw the same blocker shape the settlement-preview endpoint already returns for
   `SCHEME_NOT_MATURED`/`LOCK_IN_NOT_MET` — don't invent a new error shape.
3. Persist the calculator's **inputs** (rate used, plan snapshot version, ledger totals at
   computation time) onto the `Redemption` row alongside the computed outputs, so a later audit
   can see exactly what produced the number — not just the number itself.
4. **Recompute again inside `transitionRedemption`'s `complete` transaction**, don't trust the
   stored value from request time even after step 1-3. Between request and completion, payments
   could have posted, the gold rate could have moved, or an admin edit could have happened. Fetch
   fresh ledger totals and fresh rate (already done for `GOLD_HANDOVER` mode — extend that pattern
   to always recompute, not just for gold), compare against what's stored, and reject with a clear
   "settlement changed, refresh and try again" error if they diverge beyond what the request-time
   snapshot allows — mirror how `expectedVersion`/`positionVersion` staleness is already handled
   elsewhere in this codebase (payment.service.js) for the same class of problem.
5. Apply the same fix to whatever admin-side redemption-initiation path might have the same gap
   — check `initiateRedemption` (the admin equivalent) for whether it already calls the real
   calculator; if it does, `requestCustomerRedemption` is the only one missing it and you're
   converging both paths onto one calculator. If neither does, both need step 1-4.

**Test:** `tests/redemption.test.js` (new or extend) — 
- Customer requests redemption on a non-`MATURED` scheme → rejected with the correct blocker.
- Customer requests redemption on a `MATURED` scheme → `Redemption` row has non-zero
  `settlementPaise` matching an independently-computed expected value (write the expected-value
  math directly in the test, don't just assert "not zero").
- Complete a redemption, then simulate a payment landing between request and completion (if the
  flow allows it) — assert completion either recomputes to the new correct value or rejects as
  stale, never silently uses the old number.
- Invariant test per the audit's own suggestion: after any completed redemption, ledger postings
  for that scheme sum exactly to the recorded settlement — assert this as a hard equality, not an
  approximation.

---

### 1.3 — N7: Customer password login accepts the customer's own mobile number as a password

**File:** `src/services/auth.service.js`, `src/validators/common.validators.js`,
`src/routes/public.routes.js`

**Problem:** `isDefaultCustomerPassword` treats the mobile number itself as valid when no
password hash exists yet; `loginCustomerPassword` accepts it and sets it as the permanent
password. Reachable only when a tenant has `customerLoginMode === "PASSWORD_ONLY"` (not the
default), but wherever that's on, anyone who knows the customer's mobile number can take the
account. Also: no rate limiter on `/auth/login-password`, and the advertised password policy
(`/auth/password-policy` claims uppercase/lowercase/number/symbol) doesn't match the actual
validator (`min(8)` only).

**Fix:**
1. Delete `isDefaultCustomerPassword` and its call site entirely. A customer with no password
   hash attempting `PASSWORD_ONLY` login must be told to set a password first (via the existing
   OTP-based `verifyPasswordResetOtp` → `setPassword` flow, or an equivalent
   forced-first-password-set step) — never authenticated on the strength of their own public
   mobile number.
2. Add `loginRateLimit` (already defined in `security.middleware.js`, used elsewhere) to
   `POST /auth/login-password` in `public.routes.js`. Use the OTP-keyed variant
   (`otpRateLimitKey`-style, per-IP+mobile) if that fits better than the plain login limiter —
   match whatever `/auth/login`'s tenant-user equivalent already does.
3. Make the `customerPasswordLoginBody`/`customerSetPasswordBody`/`publicSetPasswordBody`
   validators actually enforce what `/auth/password-policy` advertises: add a regex requiring at
   least one uppercase, one lowercase, one digit, one symbol, on top of the existing
   `.min(8).max(128)`. Update the advertised policy endpoint only if you change the actual rule —
   they must match exactly, in either direction.

**Test:** `tests/auth-security.test.js` (extend) —
- A customer with no password hash, on a `PASSWORD_ONLY` tenant, submitting their own mobile
  number as the password → rejected, not authenticated.
- `POST /auth/login-password` is rate-limited after N attempts (assert the same limit shape as
  the tenant-user login route).
- A password missing uppercase/digit/symbol is rejected by the validator with a clear field
  error, matching what `/auth/password-policy` advertises.

---

## PHASE 2 — High. Financial and lifecycle correctness. Fix before real money moves through this.

### 2.1 — N3 + N4: Fixed schemes never reach DEFAULTED; flexible free→capped transition is manual-only

**Files:** `src/workers/processors.js`, `src/schedulers/index.js`

Do these together — they're the same shape of bug (a lifecycle transition that reports/rules
depend on, with no automated trigger) and touch the same two files.

**N3 fix:**
1. Add default-evaluation logic to `processMaintenance` (or a new job name if that fits the
   existing pattern better — check how `"overdue"` and `"maturity"` are structured as separate
   `job.name` branches in the same function and follow that shape).
2. Read the plan snapshot's default-threshold rule (`maxAllowedDefaults` — check exactly where
   this lives in the plan schema, likely under `benefit.eligibility` per what N12 already
   surfaced, or a dedicated `defaultRules` block — grep for its actual location before assuming).
3. Transition a scheme `ACTIVE → DEFAULTED` when its overdue-installment count meets/exceeds
   that threshold. Make it idempotent (a scheme already `DEFAULTED` shouldn't be re-processed;
   use a status-guarded `updateMany` like the sibling jobs already do).
4. Define recovery: if arrears are paid off on a `DEFAULTED` scheme, does it go back to `ACTIVE`?
   Check whether `recordPayment` already has any status-recovery logic for `DEFAULTED` schemes
   (it may already flip status on payment — verify before adding duplicate logic). If it doesn't,
   add it there, not in the maintenance job.
5. Register this as a new scheduled job in `schedulers/index.js`, same `upsertJobScheduler`
   pattern as `maturity-daily`/`overdue-daily`.
6. Write an audit event for every transition, same pattern as other lifecycle jobs.

**N4 fix:**
1. Add a job that finds flexible schemes whose free-window phase has ended (check
   `flexiblePhaseCycles` / whatever field marks the phase boundary — likely comparable to how
   `expire-flexible-capacity` already identifies cycle boundaries) and calls the existing
   `applyFlexibleLock` function on each, inside its own transaction per scheme (the function
   already is transactional internally per what was confirmed in round 2 — confirm this still
   holds and reuse it rather than reimplementing the cap calculation).
2. Make it idempotent — `applyFlexibleLock` already throws `LOCK_ALREADY_APPLIED` for a scheme
   past the flexible phase, so a status-guarded query (`flexiblePhase: "FLEXIBLE"` and phase
   boundary passed) prevents reprocessing; catch and log (don't crash the batch) if an individual
   scheme's lock application fails, so one bad scheme doesn't block the rest.
3. Register the job in `schedulers/index.js`.
4. Keep the manual `POST /admin/flexible-locks/:schemeId/apply` route working as a safe retry
   path — don't remove it, the audit explicitly asked for manual retry to remain available for
   when the automated job fails on a specific scheme.

**Test:** `tests/scheme-lifecycle.test.js` (new) — 
- A fixed scheme with overdue installments exceeding `maxAllowedDefaults` transitions to
  `DEFAULTED` after the job runs; a payment against it afterward recovers it (assert whatever
  recovery behavior you implemented).
- Running the default job twice doesn't double-process or duplicate audit events.
- A flexible scheme past its free-window boundary gets its cap applied automatically without
  calling the admin route; a scheme already capped is skipped without error.
- Timezone/grace-period boundary test: a scheme whose grace period ends exactly at the IST day
  boundary the job runs at is neither prematurely nor belatedly defaulted (check how the existing
  `overdue` job handles this same boundary and mirror it).

---

### 2.2 — N5 + N24: Subscription enforcement and the downgrade-usage counting bug

**Files:** `src/middlewares/auth.middleware.js`, `src/services/platform.service.js`,
`src/services/tenant.service.js`, `src/services/tenant-settings.service.js`

Do these together — N24 is a bug inside the same subsystem N5 says is largely missing, and
fixing N5 without fixing N24 means the newly-added enforcement would be checking the wrong count.

**N24 fix first (it's small and other work depends on it being correct):**
1. In `currentUsageForLimits` (`platform.service.js`), change
   `schemePlans: Scheme.countDocuments({ tenantId })` to count `SchemePlan` documents, not
   `Scheme` enrolments: `SchemePlan.countDocuments({ tenantId, status: { $ne: "INACTIVE" } })` or
   whatever the correct "active plan template" filter is — check how `plan.service.js` itself
   counts active plans for its own limit check (`ACTIVE_SCHEME_STATUSES`-adjacent logic) and use
   the same definition of "counts against the limit."
2. Add a boundary test: create N plan templates and M scheme enrolments where M > N by a wide
   margin; assert the downgrade-usage check reports N (plan templates), not M (enrolments).

**N5 fix:**
1. `authenticate` in `auth.middleware.js` currently checks `tenant.status` only. Add a check on
   `tenant.subscription.status` — if it's `CANCELLED` (or past `graceEndsAt`, if that field
   exists and is meant to allow a grace period), either reject with a clear
   `SUBSCRIPTION_CANCELLED` error or, if a documented grace/read-only mode is wanted instead of a
   hard block, allow GET requests through and reject mutations — pick one behavior and make it
   explicit in a comment; don't leave it ambiguous. Check whether `tenant.subscription.graceEndsAt`
   already exists in the model before assuming you need to add it.
2. Also fix the actual bug that makes this currently silent: `platform.service.js`'s `cancel`
   action sets `tenant.subscription.status = CANCELLED` but never touches `tenant.status` (the
   field `authenticate` was already checking). Either make `authenticate` check both fields (as
   in step 1), or make the cancel action also flip `tenant.status` to something that blocks
   access — pick whichever is more consistent with how `PENDING_SETUP`/`ACTIVE`/`SUSPENDED`
   already model tenant-level access blocking, and don't introduce a third, overlapping state
   system if you can avoid it.
3. Add the same limit-check pattern `createStaff` already has (read-count-compare-throw
   `LIMIT_STAFF`) to `createBranch` (`LIMIT_BRANCHES`), customer creation paths (`LIMIT_CUSTOMERS`
   or `LIMIT_ACTIVE_CUSTOMERS` — check the exact limit key name already used in
   `tenant-settings.service.js`'s usage-meter display code and reuse it), and plan creation
   (`LIMIT_SCHEME_PLANS`, using the corrected count from N24 above). Each check goes inside the
   same transaction as the creation, not as a separate pre-check call (to avoid a race where two
   concurrent creates both pass a non-transactional check).
4. For feature entitlements (flexible schemes, gold, premature redemption, customer self-enrol,
   WhatsApp) — add a shared helper, e.g. `assertFeatureEntitled(tenant, featureKey)`, and call it
   at the specific operation boundary for each (plan creation for flexible/gold, redemption
   initiation for premature, enrolment for self-enrol, message queueing for WhatsApp). Check
   `plan-features.js`/`platform-feature-flags.js` (already exist per the file inventory) for
   whether this helper already exists in some form before writing a new one.

**Test:** extend `tests/env-production-secrets.test.js`-adjacent or new
`tests/subscription-enforcement.test.js` —
- A tenant with a cancelled subscription is blocked (or degraded per whatever behavior you
  picked) on the next authenticated request.
- Creating a branch beyond the plan's `limits.branches` is rejected with `LIMIT_BRANCHES`.
- Two concurrent branch-creation requests at exactly the limit boundary — only one succeeds.
- Enrolling into a flexible-average plan on a tenant without the flexible-scheme feature flag is
  rejected.

---

### 2.3 — N9 + N10: Payment-link initiation concurrency and PhonePe callback configuration

**File:** `src/services/payment.service.js` (`initiatePublicPayment`),
`src/integrations/phonepe.provider.js`, `src/validators/common.validators.js`,
`src/routes/public.routes.js`, `src/config/env.js`

**N9 fix:**
1. `initiatePublicPayment` currently reads the link, calls the external provider, then writes
   `Payment`/`link.paymentId`. Add an atomic claim before the external call: a
   `PaymentLink.findOneAndUpdate({ _id: link._id, paymentId: null (or whatever "no attempt yet"
   looks like) }, { $set: { paymentId: <a placeholder/reserved marker> } })` that only one
   concurrent caller can win. Only the winner proceeds to call the provider and create the real
   `Payment`; a loser gets back the existing (now-set) payment's status, same as the existing
   `if (link.paymentId)` branch already handles for the "someone already has a pending attempt"
   case — you're just closing the race between the read and that branch, not changing the branch
   itself.
2. If the provider call then fails, release the claim (reset `paymentId` back to null, or mark
   the placeholder `FAILED`) so a genuine retry isn't permanently blocked by a dead claim.

**N10 fix:**
1. Add a required `PUBLIC_BASE_URL` (or reuse `EXPORT_BASE_URL` if it's meant to serve this
   purpose too — check its current usages first; if it's export-specific, add a new env var
   rather than overloading it) to `env.js`, validated as a URL, required in production via the
   same `superRefine` pattern already used for secrets.
2. Build `callbackUrl` in `initiatePublicPayment` as `${env.PUBLIC_BASE_URL}/api/v1/webhooks/phonepe/${link.tenantId}` instead of the current relative path.
3. Add an allow-list check on `req.body.redirectUrl` — validate it's an absolute URL whose origin
   matches a configured allow-list (per-tenant, if the contract supports tenant-specific frontend
   domains, or a single platform-wide list if not — check whether tenant branding/domain config
   already exists anywhere before assuming single-list is correct).
4. Add a dedicated Zod validator for `POST /pay/:linkToken/initiate`'s body (`redirectUrl` per
   step 3, `mobile` with the same shape other mobile fields use elsewhere in
   `common.validators.js`) and wire it onto the route in `public.routes.js`.

**Test:** `tests/payments.test.js` (extend) —
- Two concurrent `initiatePublicPayment` calls on the same link resolve to exactly one
  `Payment`/one provider order, not two.
- The callback URL sent to the provider (mock the provider call, assert on what it was called
  with) is an absolute URL built from `PUBLIC_BASE_URL`.
- A `redirectUrl` outside the allow-list is rejected before any provider call happens.

---

### 2.4 — N12 + N13 + N15: Redemption rule engine gaps and gold-conversion rule gaps

**File:** `src/services/redemption.service.js`, `src/services/scheme.service.js`,
`src/services/payment.service.js`, `src/lib/money.js`

**N12 fix (four sub-fixes, same function area):**
1. `installmentsPaidCount` currently reads `scheme.installments` unconditionally, which is empty
   for flexible schemes, permanently breaking `lockInMet` for them. Branch on
   `scheme.paymentPattern`: for `FIXED`, keep the existing installment count; for `FLEXIBLE`, count
   completed cycles instead (reuse whatever cycle-completion logic already exists — check the
   `requiredPaid` calculation a few lines below in the same file, which already does this
   correctly for the benefit-eligibility check, and share that logic rather than duplicating it).
2. Add `eligibility?.minMonthsCompleted` to the `benefitEligible` calculation — compare against
   the same paid-count value from step 1 (now correct for both scheme types).
3. Add a check in the redemption initiation/completion path that `req.body.mode` (or
   `row.mode`) is a member of `rules.allowedModes` — reject with a clear error, not just display
   the allowed list without enforcing it.
4. Add a check for `redeemAtAnyBranch` — if `false`, the redemption must be initiated at (or
   validated against) the scheme's enrolling branch; if the acting user's scope doesn't match and
   `redeemAtAnyBranch` is false, reject.

**N13 fix:**
1. `moneyToWeightMg(req.body.amountPaise, rate.ratePerGramPaise)` in `payment.service.js` is
   called with the function's default rounding. Read `scheme.planSnapshot.goldRules` (already
   defined in the schema per `weightRoundingMode`/`weightPrecisionMg`/`rateSource`) and pass the
   configured rounding mode through as the third argument. Check `moneyToWeightMg`'s signature in
   `money.js` (already accepts a `rounding` param per what was confirmed) — you likely don't need
   to change the money-lib function itself, just stop dropping the plan's configured value on the
   floor at the call site.
2. `weightPrecisionMg` — if the plan configures a precision coarser than 1mg (e.g. round to
   nearest 10mg), apply that after the base conversion. Check if `money.js` has a precision helper
   already or needs one added.
3. Fix the `blockPaymentIfRateNotSet` inconsistency: `payment.service.js` throws
   `GOLD_RATE_NOT_SET` unconditionally; `customer-app.service.js` checks the setting for display.
   Make `payment.service.js` respect the same setting — if `blockPaymentIfRateNotSet === false`,
   decide what actually happens instead of blocking (does the payment queue as pending-valuation?
   does it use the last-known rate? check if there's an existing pattern for "no rate yet" handling
   elsewhere before inventing one) — and make the customer-app enrichment and the actual payment
   enforcement agree with each other either way.

**N15 fix:**
1. In `payableRange`'s `FIXED` branch (`scheme.service.js`), read
   `plan.paymentRules?.maxPaymentPerTransactionPaise` and clamp `maxPayablePaise` to it (in
   addition to the existing remaining/advance-installment calculation — take the minimum of the
   two, not one or the other).
2. Also re-check this cap in `checkAmount` at final posting time (`payment.service.js`), not just
   in the quote — the same defense-in-depth pattern already used for the cycle-cap checks on
   flexible schemes.

**Test:** extend `tests/flexible-cycles.test.js` for the lock-in fix, `tests/redemption.test.js`
for `allowedModes`/`redeemAtAnyBranch`/`minMonthsCompleted`, and a new gold-conversion test
asserting a plan configured for `ROUND_DOWN` at 10mg precision actually produces a rounded-down,
10mg-multiple weight credit — not the default half-up-to-1mg result.

---

### 2.5 — N18: Refresh token rotation race

**File:** `src/services/token.service.js`

**Fix:** replace the read-then-check-then-write in `rotateSession` with a single atomic claim:
`Session.findOneAndUpdate({ refreshTokenHash: hash, consumedAt: null, revokedAt: null,
expiresAt: { $gt: new Date() } }, { $set: { consumedAt: new Date() } }, { new: false })` (or
`{ new: true }`, whichever you need — capture the *previous* state to confirm you were the one
who claimed it). Only the caller whose `findOneAndUpdate` actually matched and updated a document
proceeds to mint a successor token. If it returns null, treat it as reuse (existing document was
already consumed or doesn't exist/is expired) and run the existing family-revocation-on-reuse
logic — but only trigger reuse revocation if a *separate* lookup confirms the token exists and is
already consumed (to distinguish "genuine reuse" from "token never existed" cleanly, matching
whatever distinction the current code already makes between those two error paths).

**Test:** two concurrent `rotateSession` calls with the same refresh token — assert exactly one
succeeds and mints a child, the other gets `TOKEN_REUSE_DETECTED` (or the correct equivalent), and
the family is revoked. This needs real concurrency (`Promise.all` of two calls against the same
DB), not sequential calls with an artificial delay.

---

### 2.6 — N21: Discrepancy resolution can erase a shortfall

**File:** `src/services/cash.service.js` (`settleHandover`)

**Fix:** when `resolve-discrepancy` (or the initial `accept` action) transitions a handover to
`ACCEPTED` with an `acceptedAmountPaise` less than `amountPaise`, create a `CashAdjustment` inside
the same transaction — direction `DEBIT` (the staff member is short by the difference; check
`CashAdjustmentDirection`'s existing semantics from the round-2 fix to get the direction right,
since it needs to reduce, not increase, their standing balance) for the shortfall amount, same
pattern as the round-2 fix for reversal-after-handover. Do this **regardless of which action path**
(`accept` with a mismatch, or `resolve-discrepancy` with `accepted: true`) produces the status
change — both currently skip it. An overage (`acceptedAmountPaise > amountPaise`) should similarly
get a `CREDIT` adjustment, not just a status change with no accounting trail.

Also fix N20 while you're in this file: `adminCashReport`'s `cashBalance()` call is unscoped by
date while `handoverCount`/`discrepancies` in the same response are date-filtered. Either compute
a date-scoped version of the collected/handed-over/in-hand figures for the report specifically
(don't change `cashBalance()`'s general lifetime-balance behavior used elsewhere — add a
date-range parameter to it, defaulting to no filter so existing callers are unaffected), or
relabel the report's fields explicitly as lifetime figures if a period-scoped version isn't
feasible without deeper changes — pick the first option unless it turns out to be substantially
more invasive than expected.

**Test:** extend `tests/cash.test.js` — resolve a discrepancy with a shortfall, assert a
`CashAdjustment` exists with the correct direction and amount, and that `cashBalance()` afterward
correctly reflects the shortfall rather than silently absorbing it. Add a report test confirming
`adminCashReport`'s displayed totals for a bounded date range only include activity in that range
(or, if you took the relabeling path, that the field names now say "lifetime" and don't imply
period-scoping).

---

## PHASE 3 — Medium. Fix before onboarding real tenant data.

### 3.1 — N6: Upload lifecycle, ownership, and verification

**Files:** `src/services/upload.service.js`, `src/integrations/storage.provider.js`,
`src/services/customer.service.js`, `src/services/grievance.service.js`,
`src/lib/customer-app-dto.js`

1. Add a real `PENDING → UPLOADED → VERIFIED/REJECTED → ATTACHED` flow (the `UploadStatus` enum
   already has `PENDING/UPLOADED/ATTACHED/EXPIRED` — extend it with `VERIFIED`/`REJECTED` if
   missing, check first). For live mode (not mock), add a completion step — either a client-called
   "I finished uploading" endpoint that does a server-side S3 HEAD request to confirm the object
   exists and matches the declared size/content-type before flipping status, or an S3 event
   notification handler if that infrastructure is feasible in this pass (the HEAD-check endpoint
   is simpler and doesn't require new infra — prefer it unless told otherwise).
2. At every attachment site (`customer.service.js`'s KYC submission, `grievance.service.js`'s
   attachment handling in both `createGrievance` and `addGrievanceMessage`), before accepting an
   `uploadId` reference: load the `Upload` row, verify `tenantId` matches the caller's tenant,
   `ownerId` matches the caller (or is otherwise a legitimate owner for staff-assisted uploads —
   check whether staff can upload on a customer's behalf and adjust the ownership check
   accordingly), `purpose` matches what's being attached (`KYC_DOCUMENT` for KYC,
   `GRIEVANCE_ATTACHMENT` for grievances), and `status` is at least `UPLOADED` (or `VERIFIED` once
   step 1 exists). Do all of this inside the same transaction as the attachment write.
3. Fix the broken link: `customer-app-dto.js:55` emits `/uploads/:id`. Either add a real
   authenticated download route (`GET /admin/uploads/:id` and/or `GET /app/uploads/:id`,
   permission-gated to the resource's owner/tenant, returning a signed `storageProvider`
   download URL rather than proxying bytes) or change the DTO to emit the actual presigned/signed
   URL directly rather than a path with no backing route. Prefer the real route — it lets you
   re-verify tenant/ownership on every access rather than baking a long-lived signed URL into a
   response that might be cached or logged.

**Test:** `tests/uploads.test.js` (new) — attaching an upload from a different tenant to a KYC
record is rejected; attaching an upload whose `purpose` doesn't match is rejected; attaching an
upload still in `PENDING` (never confirmed uploaded) is rejected once the completion step exists;
the emitted logo/document URL actually resolves via a real route.

### 3.2 — N8: Platform mutations are unaudited

**File:** `src/services/platform.service.js`

Add `writeAudit` calls (same helper used everywhere else — `audit.service.js`) to every mutation
in this file: tenant creation, suspend/reactivate, subscription change/cancel/extend, integration
credential updates, feature-flag changes, invoice operations. Each call needs actor, target
tenant, a before/after diff, and — critically — **must never include decrypted secrets**. For the
integration-credential mutations specifically, redact `saltKey`/`accessToken`/`appSecret` from the
audit payload the same way they're already masked when returned in API responses (check how
`platform.controller.js` or wherever masks these on read, and reuse that masking function for the
audit `before`/`after` rather than writing a second one).

**Test:** for each mutation function in this file, assert a `writeAudit` call happened with the
correct action name and that the payload contains no raw secret value (grep the audit event's
serialized form for the plaintext secret you set up in the test fixture — same style as the
existing `tests/auth-security.test.js` secret-leak assertions).

### 3.3 — N11: Webhook processor omits tenant scope on lookups

**File:** `src/workers/processors.js`

Add `tenantId: event.tenantId` to the `PaymentIntent.findOne` and `PaymentLink.findOne` filters
in `processWebhook`'s PhonePe branch (both the success path and the `FAILED`/`PAYMENT_ERROR`
path a few lines below it). This is a structural fix, not a response to a live exploit — do it
because tenant isolation should never depend on an identifier being unguessable. While you're in
here, check whether `PaymentIntent`/`PaymentLink`'s indexes already include `tenantId` in a
compound unique index on the fields being looked up (`_id`/`providerOrderId`) — if not, and if
this is cheap to add without a migration headache, add it; if it requires a real migration, leave
it and just fix the query-level scoping.

**Test:** construct two tenants with colliding-by-design reference values (force it in the test
rather than relying on real ULID uniqueness) and confirm a webhook for tenant A's reference never
touches tenant B's `PaymentIntent`/`Payment` even if the bare id matches.

### 3.4 — N16: Placeholder endpoints, export type mapping, CSV injection

**File:** `src/routes/admin-customers.routes.js`, `src/routes/admin-operations.routes.js`,
`src/workers/processors.js`

1. For every placeholder identified (`statement/share-whatsapp`, `dead-letter/:id/requeue`,
   `payments/:id/poll-status`, `payments/:id/reconcile`, `messaging/inbound`): either implement
   the real behavior if it's in scope for this pass, or make the route return
   `501` with a clear `FEATURE_NOT_AVAILABLE` code instead of a fake `200`/`202` success. Do not
   ship a route that claims success while doing nothing — that's strictly worse than an honest
   501. Pick per-endpoint based on how much work implementing the real thing is:
   - `statement/share-whatsapp` — implement for real (call `queueMessage` with the statement,
     same pattern as other WhatsApp sends in this codebase).
   - `dead-letter/:id/requeue` — implement for real (reset the `WebhookEvent`'s status to
     `QUEUED` and re-enqueue via `getQueue("webhooks")`, mirroring how the dispatcher already
     enqueues fresh events).
   - `payments/:id/poll-status` — implement for real if `phonepe.provider.js` has (or can
     cheaply get) a status-check call; otherwise 501.
   - `payments/:id/reconcile` — implement for real using the existing reconciliation logic
     `processWebhook` already has for late-success detection, exposed as an on-demand trigger;
     otherwise 501.
   - `messaging/inbound` — 501 unless inbound message storage already exists somewhere
     unconnected to this route (check before assuming it needs building from scratch).
2. Fix the export type mapping in `processExport`: replace the `AUDIT`/`CUSTOMER`/`SCHEME` ternary
   with `Payment` fallback with an explicit mapping to the actual report builders in
   `src/services/report-builders/*` for every `record.type` the contract defines
   (`COLLECTION`, `OUTSTANDING`, `GOLD_ACCRUAL`, `STAFF_PERFORMANCE`, and whatever else exists —
   check the full list in `report-builders/`). If a type has no builder yet, 501 rather than
   silently dumping raw `Payment` rows under its name.
3. Fix CSV formula injection in `csvCell`: prefix any cell whose string value starts with
   `=`, `+`, `-`, `@`, tab, or CR with a single quote `'` before the existing quote-escaping, the
   standard mitigation. Apply this regardless of which report builder produces the row.
4. Make the export actually honor a requested `format` if the job model has one — check
   `ExportJob`'s schema for a `format` field; if it exists and is currently ignored, either
   support it (CSV is likely sufficient for a first pass — XLSX can be a documented follow-up) or
   validate at job-creation time that only `CSV` is accepted for now, rather than silently
   producing CSV regardless of what was requested.

**Test:** each fixed placeholder has a test asserting real side effects (a message actually
queued, a webhook event actually re-marked `QUEUED`, etc.) or, where you chose 501, a test
asserting the honest failure. Export-type test: request a `COLLECTION` export, assert the output
rows match what `report-builders/collection.report.js` (or equivalent) would produce, not raw
`Payment` documents. CSV-injection test: a customer name of `=1+1` produces an escaped
`'=1+1` in the exported cell, not a bare `=1+1`.

### 3.5 — N17: Customer list due/overdue values are wrong

**File:** `src/services/customer.service.js`, `src/services/scheme.service.js`

The customer-list enrichment maps active schemes through `schemeAgentCollectPreview`, whose
returned DTO has no `installments` field, then a separate loop tries to iterate
`scheme.installments` on that same stripped object — always empty.

**Fix:** don't iterate installments on the preview DTO. Either (a) have the customer-list
enrichment compute `overduePaise`/`nextDue` directly from the raw scheme rows (available earlier
in the same function, before they're passed through `schemeAgentCollectPreview`) and attach those
computed values onto the DTO explicitly, or (b) add `installments`/`cycles` back onto
`schemeAgentCollectPreview`'s return value if nothing downstream is relying on their absence for
payload-size reasons — check whether this DTO is also used somewhere size-sensitive (e.g. a list
endpoint returning many customers) before choosing (b), since exposing full installment arrays on
every row of a paginated list could be wasteful; (a) is probably the better fix for that reason
alone.

**Test:** a customer with a genuinely overdue installment shows a non-zero `overduePaise` and a
`nextDue.date` matching the actual next installment's due date (not the scheme's maturity date)
in the customer list response.

### 3.6 — N19: Access tokens aren't bound to live session state

**File:** `src/middlewares/auth.middleware.js`, `src/services/token.service.js`

**Note:** this is related to but distinct from the round-2 fix for stale JWT
permissions/branch-scope (which addressed revoking the *refresh* session on role change). This
finding is about the *access* token itself never being checked against live session/device state
at all during `authenticate` — only account status is checked.

**Fix — the lighter-weight version, not a full deny-list (matching the round-2 prompt's own
stated preference for cheaper fixes over a deny-list unless asked):**
1. Add a `sessionId` (the `Session._id` created at login/refresh) and the tenant/user's current
   `securityVersion` (a new integer field, bumped on password change, role change, branch
   transfer, or explicit "log out everywhere") into the access token's claims at sign time
   (`signAccessToken` in `token.service.js`).
2. In `authenticate`, after the existing account-status check, compare the token's
   `securityVersion` claim against the current value on the `User`/`Customer` record. Mismatch →
   reject the same way an expired token is rejected. Do not add a database round-trip to check
   session/device revocation on every single request if it can be avoided — the version-number
   approach gets the same effect (any sensitive action bumps the version, instantly invalidating
   every outstanding access token) without a per-request session lookup, and doesn't need Redis.
3. Wire `securityVersion` bump into the same mutation sites the round-2 fix already added
   `logoutAll`-equivalent calls to (role change, branch transfer, password change) — this
   subsumes and strengthens that fix rather than duplicating it; if `logoutAll` is now redundant
   with this, you can leave it in place as a belt-and-suspenders refresh-token revocation, no need
   to remove it.
4. As defense in depth, shortening `JWT_MOBILE_TTL`/`JWT_WEB_TTL` further is still worth
   considering but isn't required by this fix.

**Test:** bump a user's `securityVersion` (simulating a password change or forced logout),
confirm their existing, still-time-valid access token is now rejected on the next request — not
just their refresh token.

### 3.7 — N22: WhatsApp quota bypassed by most send paths

**File:** `src/services/messaging.service.js`

**Fix:** move the quota check that currently only exists in `workboard-messaging.service.js` into
`queueMessage` itself (the single function every send path — payment success, grievance reply,
resend, share, and the workboard — ultimately goes through). Use an atomic
per-tenant-per-billing-period counter (a dedicated counter document, `findOneAndUpdate` with
`$inc` and a cap check via the same read-modify pattern already proven safe elsewhere in this
codebase — check `sequence.service.js`'s pattern for the shape, though this needs a cap check not
just an increment, so it'll look more like
`findOneAndUpdate({ _id, count: { $lt: limit } }, { $inc: { count: 1 } })`, returning null on
cap-exceeded). Do the increment-and-check inside the same transaction as the `Message.create`
call, not before or after it, so a message is never queued without also being counted, and never
counted without being queued.

**While in this file:** fix the duplicate `branchId` key ESLint already flags at line 168 — it's
currently harmless (both assignments resolve to the same value) but confusing; collapse it to one
assignment.

**Test:** queue messages via three different paths (a payment-success trigger, a grievance reply,
a direct `queueMessage` call) up to the tenant's quota limit, assert the next one from *any* path
is rejected with `QUOTA_EXCEEDED` — not just the workboard path.

### 3.8 — N23: Branch reassignment has no integrity checks

**File:** `src/services/customer.service.js` (`updateCustomer`)

**Fix:** when `req.body.branchId` is present and differs from the customer's current branch,
before assigning it: verify the target `Branch` exists, belongs to the same tenant, and is
active. Also verify the acting user is permitted to move a customer *into* that branch — a
branch-scoped `BRANCH_MANAGER`/`BRANCH_STAFF` should only be able to move a customer within their
own scope (i.e. this operation should probably be tenant-owner/admin-only, or at minimum require
the target branch to match the actor's own scope) — check `ROLE_SCOPE` for how this is modeled
elsewhere and apply the same rule here rather than leaving the field open to any caller who can
reach `updateCustomer` at all.

**Test:** a branch-scoped staff member attempting to reassign a customer to a different branch is
rejected; a tenant owner reassigning to a branch that doesn't belong to their tenant is rejected;
reassigning to an inactive branch is rejected.

### 3.9 — N34: Production environment validation is too permissive

**File:** `src/config/env.js`

**Fix:** extend the existing production `superRefine` block (the same one guarding the four
secrets) to also fail production startup when any of:
- `PROVIDER_MODE !== "live"` 
- `PHONEPE_BASE_URL` still equals its sandbox default
- `S3_BUCKET`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` are empty (once N6's real upload
  verification and the export-storage fix from the previous round both depend on live S3 working)
- `CORS_ORIGINS` still equals its literal localhost default
- `REDIS_REQUIRED` is not `true` (this may already be fixed if the previous round's prompt
  covered it — check before duplicating; the previous round's prompt did include this exact fix,
  so confirm it's actually landed rather than re-adding it)

Collect all offending keys into the same single error message shape the secrets check already
uses, so a misconfigured production deploy gets one clear list of everything wrong, not five
separate failures across five separate deploy attempts.

**Test:** extend `tests/env-production-secrets.test.js` with cases for each of the five new
checks, following the existing test's pattern exactly.

---

## PHASE 4 — Low priority / cleanup

Small, independent fixes. Commit each separately.

### 4.1 — N25: Overdue job doesn't increment scheme version
**File:** `src/workers/processors.js`

Add `$inc: { version: 1 }` to the `overdue` job's `Scheme.updateMany` call, matching the pattern
the `expire-flexible-capacity` job two lines below it already uses correctly.

### 4.2 — N26: FCM registration has no dedicated validator
**File:** `src/validators/common.validators.js`, `src/routes/staff.routes.js`,
`src/routes/app.routes.js`

Export a standalone `fcmTokenBody` schema (the `fcmToken: z.string().min(20)` field already
exists somewhere in the file — pull it into its own exported object alongside `platform`/
`deviceId` fields matching what the route handlers actually read from `req.body`) and wire
`validate({ body: fcmTokenBody })` onto both staff and app FCM registration routes.

(The "missing tenantId in mutation filter" half of this finding is lower-severity — `req.auth.id`
already scopes these writes correctly since it comes from a verified token bound to one document.
No fix needed there; just the validator.)

### 4.3 — N28: Payment reversal window is configured but unused
**File:** `src/services/payment.service.js` (`reversePayment`)

Read `tenant.settings?.paymentReversalWindowHours` (check the exact path — it's on the tenant
model per `identity.models.js:41`) and reject reversal with a clear error if
`Date.now() - payment.paidAt > windowHours * 3600_000`.

### 4.4 — N29: Public app config is a static literal
**File:** `src/routes/public.routes.js`

Move the hardcoded `android`/`ios`/`maintenance` object into a real config source — a
platform-level settings document (check if one already exists, e.g. alongside subscription plans
in `platform.models.js`) that a super-admin can actually update. If no such document exists yet,
add a minimal one rather than continuing to hardcode. This is the one item in this phase that
isn't a one-line fix — if it turns out to need a new model/route to configure it, that's fine, but
don't skip it just because it's "low priority": a maintenance-mode switch that can never be turned
on is a real operational gap the moment you need it.

### 4.5 — N30: Session response reports the wrong TTL for mobile clients
**File:** `src/services/auth.service.js` (`sessionPayload`)

`sessionPayload` hardcodes `expiresIn: ttlToSeconds(env.JWT_WEB_TTL)`. It needs to know whether
the token it's describing was signed with the mobile or web TTL — pass the `subject` (or just
`mobileClient`) into `sessionPayload` and mirror the same conditional `token.service.js`'s
`accessTtl` already uses.

### 4.6 — N31: Payment link expiry has no maximum
**File:** `src/validators/common.validators.js` (`paymentLinkBody`)

Add `.max(<some sane cap, e.g. 43200 for 30 days — check what the product actually needs before
picking a number>)` to `expiresInMinutes`.

### 4.7 — N32: Resend payment link reports the old link's identity
**File:** `src/services/payment.service.js` (`resendPaymentLink`)

The function creates a genuinely new `PaymentLink` via `createPaymentLink` (captured as
`created`), but then updates and returns the *original* `link`'s id/status. Update and return the
**new** link: `PaymentLink.updateOne({ _id: created.id }, { $set: { status: SENT } })` and
`return { id: created.id, queued: true }`. Decide what should happen to the *old* link — probably
mark it `CANCELLED`/superseded rather than leaving it in whatever status it was in, so there's
never ambiguity about which of the two documents is the live one.

### 4.8 — N33: Immutability hooks don't cover replaceOne/bulkWrite
**File:** `src/models/schema-helpers.js`

Add `"replaceOne"` and `"bulkWrite"` to the list of hooked operations in `immutablePlugin`. No
in-house code currently calls either against a protected model, so this should be a safe,
non-breaking addition — but run the full test suite after adding it in case something
unexpectedly does.

### 4.9 — N35 + N36: Deprecated packages and lint errors
**Files:** `package.json`, and the 19 ESLint errors across the files already named in the audit
(`messaging.service.js` duplicate key — already fixed in 3.7 above if you did that phase first;
`customer-scheme-detail-dto.js`, `admin-schemes.routes.js`, `report-builders/enrolment.report.js`,
`report-builders/report-envelope.js`, `reporting.service.js` unused-variable errors)

1. Remove the unused imports/variables ESLint flags — `npx eslint src tests scripts` will list
   the exact remaining ones after 3.7's duplicate-key fix lands. Delete truly-unused ones; if any
   are unused because a feature is half-wired (check before deleting — an unused import
   sometimes means a fix is incomplete elsewhere, not that the import is wrong), fix the real gap
   instead of just silencing the linter.
2. Replace `jpeg-exif`, `cron-parser@4`, `crypto-js` with maintained equivalents if a like-for-like
   replacement exists without touching call sites significantly; if the migration is nontrivial,
   leave a dated `// TODO(deps):` note instead of a rushed swap — these have no known CVEs per the
   audit, so this is genuinely lowest priority in the whole list.

**Test:** `npm run check` (which includes lint) passes with zero errors.

---

## Deliverable

After all four phases:
- `npm run check && npm test` green.
- Update `docs/REMEDIATION.md` with this round's findings (N1–N36) in the same finding → file →
  commit → test format as the last two rounds.
- Explicitly flag anywhere your fix diverged from what this prompt specified because the code
  didn't match an assumption here (e.g. if `paymentReversalWindowHours` turns out to live
  somewhere other than the tenant model, or if `ExportJob` has no `format` field at all).
- Flag anything you deliberately deferred (4.4's maintenance-config model is the most likely
  candidate — say so plainly rather than silently shipping the hardcoded version with a comment
  nobody will find).

Do not start Phase 2 until Phase 1's tests pass. Do not start Phase 3 until Phase 2's tests pass.
Do not start Phase 4 until Phase 3's tests pass.