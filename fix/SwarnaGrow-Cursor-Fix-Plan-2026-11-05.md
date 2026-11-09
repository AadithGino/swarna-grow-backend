# SwarnaGrow: Cursor remediation and release plan

**Date:** 5 November 2026  
**Scope:** All 19 findings **AUD-02 through AUD-20** from `SwarnaGrow-Production-Audit-2026-11-05.md`.  
**Owner-managed exclusion:** AUD-01 credential revocation/replacement remains with Aadith. Cursor must not rotate, replace, print or commit credentials. Clean exports must still exclude secrets.  
**Execution:** Ten phases, **0–9**. Phases 1–8 implement the fixes; Phase 0 prepares the baseline; Phase 9 verifies and packages the candidate.  
**Independent review checkpoints:** After Phases **2, 4, 6 and 8**, then final review after Phase **9**. Review findings are repaired and rechecked before moving on.

Completing a phase count does not establish readiness. Release requires demonstrated closure of every applicable finding, working Mongo/Redis integration tests, provider verification and browser verification on one frozen source pair. No implementation or release approval is represented by this plan.

## 1. How to run this

1. Work from the audited backend and frontend source, or identify and record all changes made since those archives. Do not replace a newer working repository with the older audited ZIP.
2. Add the audit report and this plan to the Cursor workspace. Keep both repositories accessible in the workspace.
3. Paste the **master instruction** below once, followed by the prompt for **one phase**.
4. Use one writer for a repository at a time. Do not run several Cursor agents against the same files. Finish a phase, check the diff and record the resulting source pair before starting the next.
5. At each review checkpoint, send the updated backend source ZIP, frontend source ZIP and sanitized evidence bundle to ChatGPT. The source pair must match the evidence. Keep working copies intact; do not deploy checkpoint ZIPs.
6. Apply review corrections in the same checkpoint, then submit the corrected pair. Continue only after the checkpoint has no unresolved defects in completed scope and no new regression introduced by that work.

Findings scheduled for a later phase remain OPEN at earlier checkpoints. A checkpoint pass is not production approval.

### Audited inputs

| Input | SHA-256 |
|---|---|
| `swarnagrow-backend-20261105-000912.zip` | `c1f91f26a99eca3d52aab7e61532ac227b4cba5933e2d818ea444f4637d44a26` |
| `SwarnaGrow-Tenant-Admin-20261105-001050.zip` | `72917c22cb91c0531aacde75ff9e16023d2ab58552f8faed219f2e8e0fb4e8f4` |

The baseline had 226 passing frontend tests, but frontend lint/typecheck and backend lint failed. Mongo integration was blocked by a binary-download HTTP 403, and ten tests failed because Redis was unavailable. Those are baseline observations, not current completion targets or acceptable exclusions. Resolve the test infrastructure; do not turn off the failing gates.

## 2. Phase map and complete finding coverage

| Phase | Work | Findings owned | Completion evidence |
|---|---|---|---|
| **0** | Identify source, establish isolated test infrastructure, fix existing static-check failures | AUD-10 baseline; AUD-18 test environment template | Clean lint/typecheck, functioning Mongo replica-set/Redis/browser test setup, source manifest and open-finding ledger |
| **1** | Backend resource/branch authorization and frontend tenant/session binding | AUD-02, AUD-20 | HTTP authorization matrix, tenant-switch browser tests, no forbidden side effects |
| **2** | Canonical PhonePe merchant references and webhook event identity | AUD-03, AUD-06 | Fixed/flexible/public-link status/refund tests, duplicate/out-of-order event tests |
| **Review A** | Audit and correct Phases 0–2 | Covered findings; remaining findings explicitly open | Reviewed source pair and passing targeted reruns |
| **3** | Atomic OTP lifecycle, aggregate send limits, configured OTP UI | AUD-04, AUD-05, AUD-09 | Real-Redis races/quotas, 4/6/8-digit UI contract, provider adapter tests |
| **4** | Fail-closed production configuration and authenticated cron | AUD-11, AUD-12 | Negative startup/build/auth tests; correctly configured staging continues working |
| **Review B** | Audit and correct Phases 3–4; preserve Review A fixes | Completed scope | Authentication/abuse/runtime review with cumulative regression evidence |
| **5** | Dependency remediation, enforced build gates, clean source exports | AUD-07, AUD-10 final, AUD-18 final | Compatible frozen dependencies, enforced checks, clean-clone builds, export verification |
| **6** | Clock stability, context identity and quote countdown boundaries | AUD-08, AUD-14, AUD-15 | Stable snapshot/component tests, deadline behavior, browser render measurements |
| **Review C** | Audit and correct Phases 5–6; recheck affected earlier behavior after dependency changes | Completed scope | Dependency reachability/closure evidence and measured render correctness |
| **7** | Safe internal navigation, Back/Forward and view restoration | AUD-13, AUD-19 | Actual deployment-target browser history tests and persistent shell checks |
| **8** | Payment-versus-fulfilment polling and precise order-cache updates | AUD-16, AUD-17 | Browser/API freshness, cache deduplication and idle/background polling evidence |
| **Review D** | Audit all 19 fixes and correct remaining implementation gaps | AUD-02–AUD-20 | All findings verified or explicitly blocked; no false closures |
| **9** | Freeze, full financial/worker/provider/browser release gate and final packages | All 19, plus cross-module regressions and release evidence | Exact final source hashes, full gate results, provider/browser traces, rollout and rollback instructions |

AUD-01 is tracked as OWNER_MANAGED throughout. It is not assigned to Cursor. Before live release, Aadith confirms its containment separately without submitting secret values.

## 3. Master instruction for Cursor

Paste this once before Phase 0, and keep it as the governing instruction for every subsequent phase.

```text
You are remediating SwarnaGrow's backend and frontend for release.

Read SwarnaGrow-Production-Audit-2026-11-05.md and
SwarnaGrow-Cursor-Fix-Plan-2026-11-05.md. First locate the actual backend and
frontend roots and read applicable AGENTS.md files. Follow current repository
conventions. Audit line numbers are navigation hints; inspect current functions.

Implement only the phase I name. Complete it through working code, meaningful
regression tests, required checks and an evidence handoff. Do not stop at a plan.
Do not start later phases automatically. Use one writer per repository.

Scope: fix AUD-02 through AUD-20. AUD-01 is owner-managed: do not rotate,
replace, print, copy into evidence or commit credentials. Source packages must
still exclude credentials, runtime data and nested obsolete release archives.

Preserve the intended product behavior:
- Keep scheme fixed/flexible enrolment, mandatory first-payment behavior,
  capacities, ledger sequencing, reversals, maturity/premature closure,
  redemption and purchase-adjustment evidence.
- Keep ecommerce paid shipping/pickup, COD, courier collections/remittances,
  cancellations, returns and refunds. COD delivery can remain payment unconfirmed
  where existing policy permits it; do not equate delivery with money received.
- Keep digital-metal buy crediting, auto-accepted/executed sells with payment
  separately pending, payout evidence, physical redemption and Daily Hedge Book.
- Do not reintroduce maker/checker, mandatory separate approvers, removed
  WhatsApp functionality or extra confirmation screens. Keep permissions,
  branch/tenant isolation, audit history and one clear next action.
- Keep PhonePe and configured OTP integration. Preserve existing app/web API
  compatibility; additive identity fields are preferable to breaking contracts.
- Preserve branding, layout and normal workflows unless the named fix requires
  a specific change. Avoid a framework rewrite or blanket memoization.

Never use production data or a production Redis instance for tests. Some helpers
clear collections: prove isolation before they run. Do not load an existing
production .env into tests. Use synthetic fixtures, a disposable Mongo replica
set and dedicated test Redis. Do not run live seed/patch/migration commands.
Never use missing infrastructure as a reason to skip critical tests or replace
transaction behavior with mocks. Resolve the infrastructure or report BLOCKED.

The audit evidence includes probes that intentionally assert broken behavior.
Convert them to desired-behavior regressions. A passing defect-reproduction
assertion is not evidence that a defect was fixed. Keep model/component tests,
but add real HTTP/Mongo/Redis/browser tests where the invariant requires them.

Do not disable lint/typechecking, relax permissions, alter expected financial
results, remove tests or broadly change dependency policy to make checks green.
Do not use placeholders, frontend mocks or mock gateway success as release proof.

Record source changes and command results accurately. Fix related regression
failures before completing the phase. For unrelated pre-existing failures,
record evidence and assign them to the owning phase. Do not claim everything
passes when a required check failed or did not run.

At phase end update evidence/remediation/findings.json and phase-N.md with:
changed files, behavior before/after, tests added, exact commands and exit codes,
pass/fail/skip/cancel counts, source identity, migrations/config requirements,
remaining blockers and any newly found related defect. Use implementation status
IMPLEMENTED_AWAITING_REVIEW; independent review is needed for VERIFIED.

No live deployment, customer messaging, real-money payment/refund, credential
rotation or production data repair is authorized by this prompt. Prepare
reviewable staging evidence and release artifacts instead.
```

## 4. Phase 0 — Reproducible baseline and working test infrastructure

**Purpose:** Avoid fixing critical code on a baseline whose tests cannot run. Apply only small static-check/config-template fixes here; dependency upgrades belong to Phase 5.

**First places to inspect:** Both `package.json` files; backend `tests/helpers/db.js`, `tests/global-test-db-serial.js`, `scripts/run-test-release.sh`, `tests/phase-g1-env.test.js`; frontend `vitest.config.ts`, `scripts/run-framework.mjs`, `vite.config.ts`; existing browser fixtures.

```text
Execute Phase 0 of the SwarnaGrow remediation plan.

1. Identify the source pair, working tree changes and current HEADs if Git is
   available. Preserve existing user work. Create an isolated remediation branch
   or equivalent checkpoint without resetting files or rewriting history.
   Record baseline hashes, Node/package-manager versions and deployment targets.

2. Create the 19-finding ledger AUD-02..AUD-20, phase ownership and statuses.
   AUD-01 is OWNER_MANAGED, never counted as a Cursor fix.

3. Establish disposable MongoDB replica-set tests and dedicated Redis tests.
   The previous MongoMemoryServer binary download returned 403. Use a supported,
   verified binary/configuration for this machine or an explicit dedicated local
   test replica set. Preserve transaction/index semantics. Do not fall back to a
   production URI, remove global-test serialization or weaken cleanup safeguards.
   Record connectivity, replica-set capability and Redis isolation without secrets.

4. Establish the browser test path on this machine with a functioning Chromium
   or existing supported browser setup. Test against synthetic local/staging data.
   Do not disable platform security or point a destructive seed script at live DB.
   If a prerequisite remains unavailable, document it precisely as BLOCKED.

5. Resolve AUD-10 baseline errors: backend's three unused assignments; frontend's
   unknown-to-string checkout normalization errors and four lint diagnostics.
   Narrow unknown values correctly. The activityIcon helper returns imported
   component identities: solve the actual lint issue without inventing a remount
   defect or disabling the rule broadly. Preserve financial behavior.

6. Restore a complete non-secret backend .env.example matching current config
   validation and production requirements. Add the minimal documented synthetic
   test configuration. Never copy secret values from an existing .env/key file.

7. Run backend npm run check and the existing audit-unit command; frontend lint,
   typecheck and tests. Prove one existing transaction integration test and one
   Redis-dependent test actually execute on isolated infrastructure. Record all
   other observed baseline failures; do not run the entire heavy release suite
   repeatedly at this stage. Keep original failure evidence.

Deliver phase-0.md, source-pair manifest, environment preflight and findings.json.
Do not mark later findings fixed. Stop at the Phase 0 boundary.
```

**Exit:** Static checks green, environment template contract passes, and the required test infrastructure works. Frontend test count may legitimately change; report actual results. Phase 0 cannot be declared release-ready if Mongo/Redis/browser are still blocked. Independent code work may continue while an external prerequisite is repaired, but its dependent verification remains blocked.

## 5. Phase 1 — Authorization and tenant/session identity

**Findings:** AUD-02, AUD-20.  
**Backend:** `src/services/ecommerce-order-handover.service.js`, `ecommerce-order-return.service.js`, `ecommerce-order-cancellation.service.js`, `ecommerce-order-delivery.service.js`, `ecommerce-order.service.js`, `ecommerce-admin-order-list.service.js`, related refund/courier services and routes; `src/lib/mutation-requirements.js`.  
**Frontend:** Customer tenant context, registration guard, auth page, session slice, token storage, customer API, auth refresh/cross-tab bridges and stored payment context.

```text
Execute Phase 1 only. Fix AUD-02 and AUD-20 across reachable paths.

Backend:
- Inventory every ecommerce order/return/cancellation/refund/pickup/tracking/
  courier read and mutation endpoint, including legacy aliases. Document its
  required permission, resource ownership and branch policy.
- Reuse or centralize resource authorization. Derive branch from persisted
  pickup/customer/order data, never an unchecked request branch. Tenant must
  match first. Apply the same policy before pagination/counts and before detail,
  events, linked evidence or financial operations. A filtered list is not a
  substitute for authorizing an ID endpoint.
- Preserve legitimate tenant-wide roles and current acting-branch semantics.
  Branch-scoped roles cannot escape scope with a header/query/body override.
  Apply checks in transactions where resource relationships can change.
- Return consistent non-disclosing 403/404 behavior and guarantee no side effects
  after authorization fails. Do not leave old endpoints as bypasses.

Frontend:
- Bind protected customer identity to server-confirmed tenant ID/customer ID.
  Resolve the URL tenant and block protected queries/actions until identity is
  compatible. Handle reload, refresh, logout, another tab and expired tokens.
- On a tenant mismatch, require a valid switch/login or return to the
  authenticated tenant. Do not silently send A-authorized actions under B UI.
- Scope/reset RTK Query cache and payment/poll/idempotency state on identity
  changes. Abort or ignore stale in-flight responses so resetting cache cannot
  allow a previous identity's response to repopulate current data.
- Keep public payment-link access functional without requiring customer login.
  Preserve safe intended return paths. Do not trust client-decoded JWT fields as
  server authorization, and do not indiscriminately clear every auth realm.

Tests:
- Real HTTP authorization matrix: owner, tenant admin, manager, staff and agent;
  tenant A/B; branches A1/A2; pickup/delivery; all read and write endpoint families.
- Rejected operations change no code/version/event/stock/refund/cash state.
- Browser: log into A, open B in same/another tab, reload, refresh token and return
  from checkout. Never display A data as B or submit a B-intended action under A.
- Keep existing isolation and branch-mutation tests; extend missing cases.

Run targeted tests, backend check and frontend lint/typecheck. Record the identity
contract and source changes. Stop after Phase 1.
```

**Exit:** The original cross-branch pickup/return reproductions now fail safely, real HTTP tests pass and tenant switching has browser evidence. No maker/checker added.

## 6. Phase 2 — PhonePe identity and callback integrity

**Findings:** AUD-03, AUD-06.  
**Files:** Backend payment initiation, admin/customer/public polling, shared PhonePe reconciliation, refund initiation/reconciliation, webhook identity/storage and worker processing. Inspect `src/services/payment.service.js`, `payment-poll-status.service.js`, `phonepe-reconcile.service.js`, `payment-refund-initiation.service.js`, `phonepe-refund-reconcile.service.js`, `src/lib/phonepe-webhook-identity.js`, `src/services/webhook-event.service.js`, `src/workers/processors.js` and relevant models.

```text
Execute Phase 2 only. Fix AUD-03 and AUD-06 without changing payment amounts,
scheme allocation rules or customer/Flutter/web response compatibility.

1. Persist the exact original merchant order ID at payment initiation as an
   immutable business reference. Keep it separate from reservation/intent IDs,
   payment-link IDs, provider order IDs, transaction IDs and final receipt numbers.
   Cover fixed schemes, flexible intents and public links; check shop and
   digital-metal initiation/recovery for the same identity confusion.

2. Use one canonical resolution contract for all status polling, scheduled
   reconciliation, refund initiation and refund-status lookup. For old records
   follow verified bound relationships; ambiguous identity must fail safely with
   actionable review evidence, never guess by ID prefix or choose another payment.
   Avoid duplicate provider lookups in one poll where unnecessary.

3. If additive schema/backfill is needed, implement a resumable idempotent tool
   with read-only dry run, ambiguity report and staging rollback/compatibility
   notes. Do not run a production migration or rewrite historic financial IDs.

4. Deduplicate PhonePe events using a documented unique event ID when present;
   otherwise use canonical event semantics including type, relevant order/refund
   identity, transaction and state. A transaction/order ID is not an event ID.
   Account for compatibility with already stored event keys and queued events.
   Keep terminal transitions/accounting idempotent even when both old and new
   event identities reach processing.

5. Add real integration tests with deliberately DIFFERENT merchant-link,
   reservation, provider-order and transaction IDs. Verify pending and successful
   fixed payments, changed receipt numbers, flexible/public paths, refund create
   and refund status. Test partial refunds and retries after provider timeouts.

6. Test attempt-failed -> order-failed, pending -> completed, accepted -> completed
   refunds, byte/order-equivalent duplicates, distinct events, worker retry and
   out-of-order callbacks. Assert one financial posting, no lost valid transition,
   and no reopening a successful payment because a stale failure arrived later.

Use controlled provider doubles for deterministic races. Record exact payload
contracts and reserve genuine provider sandbox verification for approved test
accounts in Phase 9. Run affected payment/refund/webhook/isolation regressions.
Deliver the source pair, phase-2 evidence and ledger; stop for Review A.
```

**Useful existing suites:** PhonePe gateway/reconciliation/failure-injection tests, fixed-payment webhook authority and public expiry tests, webhook-event/processors tests, gateway refund initiation/concurrency/accounting/recovery tests. Use the existing serialized release runner when running selected Mongo suites; do not unknowingly drop their setup hooks.

### Review A — After Phase 2

Audit authority from HTTP route through service, legacy route coverage, verified tenant binding, source-to-provider reference consistency, webhook identity and accounting idempotency. Test fixes rather than trusting phase summaries. Keep uncovered later findings open. Re-run only relevant suites after correcting gaps. Produce `review-A.md` with accepted source identities and remaining work.

## 7. Phase 3 — OTP atomicity, cost controls and UI contract

**Findings:** AUD-04, AUD-05, AUD-09.  
**Files:** Backend OTP provider, Message Central client/credentials, auth and signup/reset routes/services, security middleware and validators; frontend customer tenant context, auth UI, OTP adapters/types.

```text
Execute Phase 3 only. Fix AUD-04, AUD-05 and AUD-09 as one end-to-end auth change.

Atomicity:
- Design a Redis-backed challenge state machine with atomic claim/attempt/consume
  transitions bound to tenant, canonical mobile, purpose and exact otpId.
- Prevent two valid concurrent verifies from issuing independent sessions. Local
  provider, MSG91 and Message Central paths must obey the application invariant.
  Validate in-process and across processes, not only against an in-memory Map.
- Define timeout/claim-lease recovery when external validation succeeds but local
  session creation/response fails. Do not introduce permanent lockout or replay
  access. Preserve deliberate idempotent retries without duplicate sessions.
- A stale verification must not delete or validate a newly resent challenge.
  Attempt budgets cannot lose concurrent increments. Production Redis loss fails
  closed with an actionable error, never a per-process fallback.

Abuse/cost controls:
- Add independent atomic destination, IP, tenant and platform/provider budgets
  around every OTP send entry point, including customer signup, merchant signup
  and password-reset paths. Preserve cooldown and idempotent no-extra-send replay.
- Bound sends across instances and distinct mobiles, not just composite IP+mobile
  buckets. Document configurable defaults and charging/reservation policy for
  provider failures and timeouts. Alert on exhausted budgets; redact mobile/OTP
  secrets appropriately. Do not add a new CAPTCHA/vendor unless justified by
  actual scope; layered server limits are required either way.

Frontend:
- Preserve validated otpLength and country metadata through tenant resolution,
  context and auth forms. Support configured 4/6/8-digit input, resend, paste and
  incomplete-code validation. Remove production example mobile/OTP initial values.
- Respect actual provider country support. Do not advertise UAE SMS support by
  merely making a country field dynamic. Preserve purpose and challenge ID.

Tests:
- 20 concurrent successful attempts; concurrent invalid attempts at the limit;
  resend during slow verification; provider timeout; expired lease/challenge;
  process restart; replay after successful verification; Redis failure.
- An IP rotating many mobiles reaches its total quota; multiple instances share
  tenant/platform quotas; independent tenants remain appropriately isolated.
- Integrated provider-to-login tests for 4/6/8 digits and clear provider errors.
- Keep current OTP and Message Central contract tests; convert old defect probes.

Run targeted real-Redis/HTTP tests and frontend auth tests plus static checks.
Record behavior, budget settings and any blocked provider verification. Stop at
Phase 3; do not mark an untested Message Central live scenario as passed.
```

**Exit:** One authentication operation per challenge under actual Redis concurrency, no resend deletion race, budgets cannot be bypassed by rotating destinations, configured OTP lengths work end to end.

## 8. Phase 4 — Production configuration and cron authentication

**Findings:** AUD-11, AUD-12.  
**Files:** Frontend `src/config/env.ts`, build/environment loading, mock entry points/test harness flags and deployment files; backend cron handlers, env validation and related deployment configuration.

```text
Execute Phase 4 only. Fix AUD-11 and AUD-12 with fail-closed production behavior.

1. A production build must explicitly select live frontend API mode and a valid
   HTTPS API base. Missing, misspelled or mock-enabled production values must fail
   clearly. Preserve explicit dev/test mocks. Check the actual Vinext/Vite/Nitro
   build environment and variable inlining; do not assume Next's env behavior.
   Validate both normal and deployment-target build paths and preview conventions.

2. Prevent production-only test payment/mock completion UI and endpoints from
   becoming available through a stray flag. Keep synthetic test harnesses usable
   only in explicitly isolated tests. Never fake a successful financial action.

3. Production cron handlers require a nonempty secret and valid authorization
   header. Missing/blank/wrong credentials return 401/503 safely BEFORE DB/Redis
   boot, dispatch, provider calls or other side effects. Remove the VERCEL=1
   authorization bypass. Do not accept secrets in query strings.

4. Define where cron prerequisites are validated so API-only deployments do not
   fail unnecessarily but enabled cron handlers cannot start insecurely. Update
   .env.example and deployment docs without inserting secrets. Bound overlapping
   invocations and reflect failed subwork in health/status rather than claiming
   an overall healthy run while catching errors silently.

5. Add automated negative tests: missing/invalid env; explicit mocks in production;
   invalid API base; missing/wrong cron secret under VERCEL=1; query-only secret;
   unauthorized request creates no DB/queue side effects. Valid config/auth must
   still build and perform the intended bounded maintenance.

Run the environment/auth tests and static checks. A staging build must prove it
uses the real synthetic backend rather than fixtures. Document infrastructure
requirements, evidence and source identity; stop for Review B.
```

### Review B — After Phase 4

Review the actual Redis scripts/state transitions and all OTP send routes, not only the originally reported customer path. Test concurrent verification/session issuance and quota reservations. Trace frontend OTP length through the real context. Test cron authorization before any effect, and verify production environment mode in the produced bundle/runtime. Recheck earlier auth/tenant/payment regressions affected by the change. Produce `review-B.md` and fix gaps before Phase 5.

## 9. Phase 5 — Dependencies, enforced gates and export hygiene

**Findings:** AUD-07, AUD-10 final, AUD-18 final.  
**Files:** Both manifests/lockfiles, build/CI/deployment scripts, source exporters/verifiers, dependency-sensitive form/validation/image code.

```text
Execute Phase 5 only. Close AUD-07, finish AUD-10 and finish AUD-18.

Dependencies:
- Refresh production dependency audit against the actual locked graphs. Verify
  applicable patched releases using primary advisories; do not blindly freeze the
  audit report's older version recommendations or upgrade everything to latest.
- Remediate the flagged Next/sharp/Zod/transitive graph compatibly with Vinext,
  React, lint tooling and resolvers. Preserve declared package-manager/security
  policies. Do not disable release-age/lockfile/build-script controls to install
  an otherwise disallowed dependency. Do not mask findings with --force.
- Prove the versions actually resolved in the deployable artifact. For any
  remaining advisory, record path, reachability, severity and specific reasoning.
  An audit exception is not verified merely because Cursor says Vinext is used.
  Applicable critical/high production vulnerabilities block release. Upgrade
  safely rather than making undocumented risk acceptance decisions.

Release checks:
- Make deployment build/CI require frontend lint/typecheck/tests and backend
  check/tests at appropriate pre-deploy stages. Demonstrate a deliberate failing
  check blocks the gate, then remove the temporary negative fixture.
- Keep fast phase gates separate from the heavy release command; do not run the
  full financial suite for every line edit. Ensure no check's exit is swallowed.

Packaging:
- Frontend uses declared pnpm; backend uses npm. Remove stale unsupported secondary
  lockfiles or deliberately maintain them with verified equivalence. Deployment
  must install frozen dependencies rather than update its own lock graph.
- Audit exporter allowlists and verifiers. Include all required source/deployment/
  worker/config-template files; exclude generated output, old nested releases,
  runtime/mock uploads, caches, credentials and local .env files. Do not rotate or
  modify the owner-managed credential. Scan without printing secret content.
- Fix the missing build:netlify reference if Netlify is supported. Otherwise
  remove the misleading unsupported configuration and document the chosen target.
  Do not promise three hosting targets without verifying them.
- Include complete non-secret .env.example files. Run source export verification,
  then extract the exports elsewhere and install/check/build from them. A build
  relying on files omitted from the ZIP is a packaging failure.

Run frontend full tests/static checks and both supported build paths, backend
check and dependency-sensitive targeted integration tests. Document breaking
changes, resolved graphs and clean-clone evidence. Stop at Phase 5.
```

**Exit:** Supported clean installs/builds are reproducible; static gates enforced; no unreviewed applicable critical/high production advisories; no broken deployment entries; clean source exports. This phase may change runtime dependencies, so earlier auth/payment contract regressions are retested where affected.

## 10. Phase 6 — Render boundaries and deadline correctness

**Findings:** AUD-08, AUD-14, AUD-15.  
**Files:** Frontend `src/hooks/use-now-ms.ts`, support SLA chips, customer tenant context and branding normalization, `customer-shop-quote-page.tsx`, shared counter/countdown users where applicable.

```text
Execute Phase 6 only. Close AUD-08, AUD-14 and AUD-15 with focused changes.

1. Replace Date.now-as-an-external-store-snapshot with a stable cached clock
   snapshot that changes only on notification, or a small local state/effect
   clock component. Preserve hydration consistency and clean subscriptions. Use
   one shared clock if appropriate, not one leaking interval per table row.
   Stop timers when no active consumer/deadline needs them.

2. Memoize tenant normalization from stable raw API data and keep exposed context
   identity stable when its values have not changed. Preserve Phase 1 identity
   fences: optimizing renders must never retain another tenant's values. Avoid
   inventing a large state architecture to fix a local identity problem.

3. Move per-second countdown state into a small quote countdown/status boundary.
   Use a stable numeric expiry, not a new Date effect dependency every render.
   Notify the parent once at expiry; update the CTA then. Place-order eligibility
   must honor both server policy/status and local deadline, including expired
   data arriving from a refetch. Server-side expiry remains authoritative.

4. Keep static product rows/address/totals/policy UI outside ticking work, with
   stable props where useful. Do not memoize everything or use stale closures to
   suppress required updates. Correctness comes before reduced render counts.

5. Tests: repeated clock snapshots are identical between ticks; no update loop;
   subscription cleanup; multiple consumers; SSR/hydration; unrelated parent
   update does not notify memoized context-only consumers; actual branding changes
   still update. Quote expiry disables placement immediately and shows refresh.

6. In a browser against the supported production build, record mount counts and
   render/commit observations before and after for SLA rows, quote countdown,
   static checkout content and customer context. Test a long table and mobile
   checkout. Account for development StrictMode separately; do not fabricate a
   percentage speedup or demand zero renders for genuinely changing props.

Run targeted component/browser tests, complete frontend test suite/static checks
and required build checks. Deliver measurements and source pair; stop for Review C.
```

### Review C — After Phase 6

Verify dependency resolution in the actual artifact, enforced check failures and clean-clone source export. Inspect the clock store for stable snapshots, cleanup and hydration. Use component tests and browser measurements to confirm the context/countdown changes, including actual deadline transitions. Recheck financial/auth flows affected by changed libraries. Produce `review-C.md`; fix gaps before Phase 7.

## 11. Phase 7 — Navigation and Back/Forward

**Findings:** AUD-13, AUD-19.  
**Files:** Frontend `src/lib/navigate-back.ts`, `portal-nav.ts`, portal layouts/routers/shells, shared back links, list view state and Vercel Link compatibility code in `vite.config.ts`.

```text
Execute Phase 7 only. Close AUD-13 and AUD-19 on the real deployment target.

1. Inspect current Vinext/Next navigation behavior after Phase 5 upgrades. Do not
   replace idx with another undocumented framework field and call it solved.
   Preserve framework-owned history state while maintaining app-owned entry
   identity/navigation metadata where needed. Distinguish push, replace and pop.

2. Custom Back traverses the actual previous known-safe portal entry. Direct or
   external entry uses a safe replace fallback, not a new push that causes a
   list/detail loop. Track full relative URLs including query/hash and tenant/
   portal realm. Reject unsafe/cross-tenant destinations. Handle unavailable or
   corrupt sessionStorage and legacy history entries without crashing.

3. Preserve important list search/filter/tab/pagination cursor and scroll on
   return. Put durable view state in the URL or a scoped store; validate cursors
   and clear incompatible state on identity/filter changes. Do not preserve stale
   payment/form state when moving from detail A to detail B.

4. Fix the actual Link soft-navigation compatibility problem. Remove or narrow
   the full-document fallback only after a working alternative is demonstrated.
   Internal links normally retain the shell/provider DOM instances. Keep expected
   external navigation to PhonePe and legitimate hard auth/session boundaries.
   Inspect compiled deployment behavior, not only a development server.

5. Add browser tests for admin, customer and agent portals, and platform where
   supported: list->detail->custom Back; native Back/Forward; filter/page/tab and
   scroll restore; detail A->B; direct link; refresh; external entry; login return;
   lazy-load errors; expired auth; tenant switch; public pay link; PhonePe return.
   Check actual URL, history direction/length and visible data. Normal internal
   clicks must not issue a new document request or remount the shared shell.

6. Count shell mounts over repeated navigations and confirm ordinary changes
   update active nav/page content only where appropriate. Do not assert that
   rendering any shell component at all is inherently a defect.

Run browser coverage on the actual supported deployment build, navigation unit
tests, frontend static checks and relevant auth/payment regressions. Record
tested routes and browser/build versions. Stop at Phase 7.
```

**Exit:** Both custom Back and native history behave correctly; direct entry is safe; important list state restores; internal navigation retains the shell; payment redirects remain functional.

## 12. Phase 8 — Fulfilment freshness and cache correctness

**Findings:** AUD-16, AUD-17.  
**Files:** Frontend `src/lib/customer-payment-polling.ts`, shop and digital-metal redemption detail pages, `src/store/api/customer-api.ts`, related lists and identity-scoped cache utilities.

```text
Execute Phase 8 only. Close AUD-16 and AUD-17 without sacrificing isolation or
replacing narrow updates with broad refetches.

1. Separate financial status polling from order fulfilment freshness. Payment
   polling can stop at PAID/CHARGE_PAID, but shipping, pickup-ready, instructions
   and handover must still refresh until genuinely complete/cancelled. Use slower
   visible-page polling or a verified push/invalidation mechanism for fulfilment.
   Refresh on focus/reconnect and suspend unnecessary background work.

2. Handle network failure, rate-limit responses and slow requests with bounded
   retry/backoff and no overlapping manual intervals. Keep needed reconciliation
   active for unknown/uncertain money states. Do not silently call them failures
   to stop polling, and do not poll every terminal historical order forever.

3. Add explicit shop-order LIST and entity tags, separate from ShopCart. Create,
   paid, cancelled, return/refund and fulfilment transitions update or invalidate
   affected detail/list/balance data. Check relevant customer home/notification
   counts too. Avoid resetting the whole customer API for every mutation.

4. Paginated merging deduplicates by stable order ID, handles first-page refresh,
   repeated cursors, ordering and filter/query identity, and resets/isolate data
   on tenant/customer changes from Phase 1. Late previous-identity responses cannot
   enter the new list. Preserve Phase 7 view-state restoration semantics.

5. Tests: load list, create/pay/cancel/return an order, navigate back within cache
   lifetime; repeated page fetch; reconnect; tenant switch while request in flight.
   An open paid order must visibly progress to shipped/delivered and an open
   charge-paid redemption to pickup-ready/instructions/handed-over without reload.
   Verify no requests for unrelated profile/plans/settings after a narrow update.
   Record visible/hidden/terminal network activity and polling shutdown.

Run frontend integration/browser/static tests and affected backend fulfilment/
payment tests. Update findings to IMPLEMENTED_AWAITING_REVIEW with evidence and
deliver both source exports plus phase-8 evidence. Stop for Review D.
```

### Review D — After Phase 8

Audit all 19 findings against current code, not the original report alone. Reproduce original defects using desired-behavior tests. Trace real state transitions and asynchronous races across frontend, backend, Mongo, Redis and worker boundaries. Distinguish resolved defects, untested claims and conditional risks. All implementation gaps must be corrected before the final candidate is frozen. Produce `review-D.md` and the reviewed source-pair manifest.

## 13. Audit and correction handoff prompts

### What to send at Reviews A/B/C/D

| Item | Required content |
|---|---|
| Backend source ZIP | Current clean source, required configs/templates/tests, no secrets or runtime data |
| Frontend source ZIP | Same reviewed candidate pair, current frozen lockfile and supported deployment configuration |
| Evidence ZIP | Phase/review summaries, findings ledger, source hashes/commit IDs, diffs/change list, exact check commands/exit codes/counts, sanitized logs and test infrastructure versions |
| Context | Checkpoint name, phases completed, known remaining findings, migration/config needs and any newly found gap |

Do not copy the private key, live `.env`, customer exports or screenshots containing customer/payment details into the evidence. Refer to secret names and synthetic IDs only. Both source archives and every log must identify which source revision they represent; a frontend from one attempt and backend from another are not a candidate pair.

### Prompt to request the checkpoint audit here

```text
Audit checkpoint [A/B/C/D] of the SwarnaGrow fix plan.

Attached are the exact backend/frontend source pair and evidence bundle after
Phases [completed numbers]. Inspect current code and real test behavior against
the plan, the original AUD findings and our preserved product flows. Do not rely
on Cursor's completion summary or passing defect-preserving probes.

Check all findings assigned to completed phases and regressions they introduced.
Keep later findings explicitly OPEN. Do not claim the full product is cleared
based on a checkpoint. AUD-01 remains owner-managed.

For each gap, give evidence, affected path/function, impact, minimal safe fix and
specific regression criteria. Run feasible verification. Mark missing essential
infrastructure/provider/browser checks BLOCKED rather than passed. Produce one
focused Cursor correction prompt for unresolved gaps. After corrections, re-audit
the new exact source pair before proceeding to the next planned phase.
```

### Prompt for Cursor to repair checkpoint gaps

```text
Correct the attached checkpoint review for SwarnaGrow. Continue from its exact
source pair and preserve existing user changes. Address every review gap with a
root-cause fix, related endpoint/flow sweep and meaningful regression coverage.
Do not reopen unrelated product design or start the next planned phase.

Do not weaken tests/permissions/configuration or mark a blocked test passed.
Run affected checks and a justified regression set. If a fix changes a shared
contract, include all its callers and compatibility behavior. Update the findings
ledger and checkpoint evidence with exact source identity, actual exits/counts,
remaining blockers and migrations/configuration needs. Export the corrected pair.

The checkpoint closes only after independent re-review. No deployment or live
database repair is authorized. AUD-01 stays owner-managed.
```

The correction loop has no arbitrary retry count. If the same class of defect recurs, expand the relevant route/state-transition matrix instead of repeatedly fixing one symptom.

## 14. Phase 9 — Frozen-candidate release verification

**Purpose:** Verify that all fixes work together and that missing financial/operational gates are finally completed. This phase does not assume that the original 19 findings were the only defects.

```text
Execute Phase 9 after Review D is closed.

1. Freeze one reviewed backend/frontend source pair and record commits or complete
   file manifests, dependency-lock hashes, API contract identity and configuration
   profile names without secrets. Build/test only that pair with isolated data.
   Do not edit source while claiming tests still verify the frozen candidate.

2. From clean installs run backend check, audit unit/integration gates and full
   test:release with heavy tests enabled by its existing runner. Run frontend
   lint, typecheck, complete tests and all supported production build checks with
   explicit live-API mode. Re-run production dependency audits. Capture each
   exact command, exit code and pass/fail/skip/cancel count. Investigate new skips,
   missing suites and cancelled tests. A smaller passing test count is not proof
   of improvement. Do not use --test-force-exit to ignore failed assertions or
   broken cleanup; keep the established runner while checking lifecycle behavior.

3. Verify the financial/operational matrix below on disposable replica-set Mongo
   and real Redis/BullMQ. Add meaningful missing tests. Existing unit/model doubles
   alone do not prove cross-document atomicity, index enforcement or queue races.
   Verify duplicate-obligation/index migration readiness with read-only reports.
   Ambiguous legacy reservation accounting remains fail-closed; do not guess modes.

4. Stage the exact build pair with synthetic accounts. Test PhonePe sandbox through
   actual provider callbacks/status/refunds for scheme, ecommerce and digital-metal
   payment paths, with web and any affected existing mobile contract. Confirm
   Message Central delivery/validation using approved internal test numbers and
   controlled volume where the provider offers no appropriate sandbox. An adapter
   mock result does not count as provider verification. If credentials or a test
   account are unavailable, record BLOCKED; do not send to customer lists or use
   real money. Do not put credentials/OTPs in evidence.

5. Run browser navigation/identity/render/cache/fulfilment matrix on the actual
   deployment-target build at desktop and narrow mobile sizes using the real
   synthetic backend. Assert persisted shell identity, required data freshness and
   correct forms/actions. Check console, failed requests, empty/loading/error
   states, focus, external checkout return and repeated Back/Forward navigation.

6. If a defect is found, stop the freeze, implement a scoped corrective patch and
   assign a new source identity. Re-run affected gates; for any final candidate
   source/lock/build-config change, obtain the complete required release evidence
   again before sign-off. Never mix earlier successful output with changed source.
   If nothing changed and evidence is valid, do not rerun expensive suites merely
   to produce more green logs.

7. Produce final clean backend/frontend ZIPs, test evidence, all-19 closure ledger,
   config checklist, migration dry-run/rollback notes, worker/scheduler startup
   order, deployment sequence, monitoring checks and rollback instructions. Extract
   and verify the final ZIP contents against the tested source manifest. Do not
   repair a broken exported package without regenerating and re-verifying it.

8. Return VERIFIED CANDIDATE or BLOCKED with exact reasons. This is preparation for
   the final independent release audit; do not deploy or self-approve production.
   AUD-01 remains owner-managed and requires owner confirmation before live release.
```

### Required cross-module test matrix

| Domain | Scenarios that must be demonstrated | Invariant |
|---|---|---|
| Tenant/branch authority | All roles; same/other tenant and branch; legacy aliases; linked events/evidence; altered headers/body/query; in-flight tenant switch | Authorized resource only; forbidden requests cause no side effects or stale-data disclosure |
| Scheme enrolment | Fixed/flexible, first payment, capacity, timeout/retry, duplicate requests and concurrent enrolments | One intended enrolment; correct seats/first-payment state and ledger |
| Scheme contributions | Cycle/month boundaries, capped free-window rules, reversals, retry, missing/duplicate/out-of-order webhook | Correct net paise/weight, no over-cap or duplicate credit |
| Closure/redemption | Maturity/premature, KYC, penalty/benefit, same/next-day 22K rates, purchase bill, concurrent payment/refund/closure | One consistent settlement; correct cash/weight and auditable evidence |
| PhonePe | Distinct IDs, scheme/shop/DM, web/mobile contract, status recovery, duplicate/delayed callbacks, timeouts, expiry, late success | Correct merchant/account binding; one financial outcome; uncertain money stays recoverable |
| Refunds | Initiation retry, partial/cumulative refund, provider accepted/failed/completed, manual/provider overlap, post-settlement cases | No duplicate obligation, reservation leak or excessive refund; correct accounting |
| Ecommerce inventory | Last-item concurrency, quote expiry, order cancellation, return receipt/restock retry, stale order state | Stock reserved/released/restocked once with order entitlement |
| Paid order fulfilment | Ship/tracking/deliver; ready/code/collect; proof and code reissue races; legacy endpoints | Correct branch, version and evidence; no duplicate handover |
| COD/courier | Accept/ship/deliver, verified/unconfirmed customer payment, partial/batched remittance, fee/reference/date, refunds | Delivery separate from collection/remittance; no phantom or duplicate money |
| Digital-metal buy | Online/counter, provider retries, late success, credit/refund-review, cash tender/recovery | One wallet/lot/journal credit and correct custody |
| Digital-metal sell/payout | Customer confirm and counter auto-execution, bank binding, retry, risk hold, payout unknown/settled, reservation expiry | One sale/payable; payment pending until evidence; no double debit/payout |
| Physical DM redemption | Charge payment/expiry race, pickup/delivery, cancellation/refund, repeated handover, legacy ambiguity | One physical-out and wallet effect; no guesswork or lost reservation |
| Hedge Book | Opening, procurement, sells, handovers, corrections, day close under concurrent changes | Source uniqueness and quantities reconcile to journals/physical out |
| OTP | Concurrent verify/resend, attempts, quotas across instances, provider failure/timeout, tenant purpose and length | Single-use challenge, bounded cost, usable login, fail-closed Redis |
| Workers/recovery | Scheduler registration, required worker heartbeats, restart/stalled leases, queue lag, retries/dead letters/outbox | Missing critical workers unhealthy; durable work recovered once |
| Frontend routing/render/data | Direct links, Back/Forward, return URL, tenant switch, active/hidden tabs, polls, mutation cache and list merge | Correct identity/history/freshness; bounded work and preserved shell |

### Standard final commands

These are the existing command names in the audited repositories. Phase 0/5 must document the actual isolated environment and updated gate wiring. Run in each repository, and capture commands individually with exit codes; do not let a pipe hide failures.

```bash
# Backend: isolated test configuration and services already established
npm ci
npm run check
npm run test:audit:unit
npm run test:audit:integration
RELEASE_LOG=./evidence/remediation/final/backend-release.log npm run test:release
npm audit --omit=dev
npm run package:export -- --out=../swarnagrow-backend-release-candidate.zip
npm run package:verify -- ../swarnagrow-backend-release-candidate.zip
```

```bash
# Frontend: declared package manager; staging live-API variables supplied explicitly
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --prod
NEXT_PUBLIC_USE_MOCKS=false pnpm build
NEXT_PUBLIC_USE_MOCKS=false pnpm build:vercel
pnpm run package:export --out=../swarnagrow-tenant-admin-release-candidate.zip
pnpm run package:verify ../swarnagrow-tenant-admin-release-candidate.zip
```

Use the checked-in browser command implemented/verified in Phases 0/7/8. Do not invent `test:e2e` or a provider verification script and claim it already exists. Existing seeded browser scripts load `.env`; inspect and isolate their configuration before execution. The export commands above select explicit output names and pass those same archives to the existing verifiers. Confirm those CLI contracts if Phase 5 changes them. Create the evidence directory before using `RELEASE_LOG` and preserve the runner's exit status.

### Final independent release audit prompt

```text
Perform the final SwarnaGrow release audit on the attached frozen backend/frontend
pair and Phase 9 evidence. Verify AUD-02..AUD-20 closure, exact source/log/artifact
identity, required full gate results, migrations/index readiness, worker recovery,
provider sandbox evidence and actual deployment-target browser behavior.

Reproduce the corrected invariants and inspect cross-module gaps, not only the
nineteen original symptoms. Distinguish test doubles from Mongo/Redis/provider/
browser evidence. No blocked critical check may be represented as a pass. Report
new defects with exact paths, impact, reproduction and corrective instructions.

AUD-01 was assigned to me; keep credential handling outside code remediation.
Record whether my containment confirmation was supplied, without asking for keys.
Give a release recommendation for this exact candidate, not a general promise of
zero bugs. If changes are required, invalidate affected candidate evidence and
request a new verified source pair. Do not deploy.
```

## 15. Evidence ledger and phase completion contract

Create `evidence/remediation/` in the working handoff area, excluded from application runtime artifacts. If the repos are separate, maintain one source-pair manifest rather than contradictory ledgers. Store non-secret evidence; use per-command files or a documented runner that preserves exit codes.

Recommended files:

```text
evidence/remediation/findings.json
evidence/remediation/source-pair.json
evidence/remediation/phase-0.md ... phase-9.md
evidence/remediation/review-A.md ... review-D.md
evidence/remediation/commands.json
evidence/remediation/final/release-verdict.md
evidence/remediation/final/deploy-and-rollback.md
```

Suggested finding fields: `id`, `phase`, `status`, `changedFiles`, `regressionTests`, `commandEvidence`, `backendSourceId`, `frontendSourceId`, `reviewCheckpoint`, `remainingBlockers`. Statuses: OPEN, IN_PROGRESS, IMPLEMENTED_AWAITING_REVIEW, VERIFIED, BLOCKED. Conditional findings need demonstrated removal of exposure or a specific reviewed risk determination; a sentence saying “not applicable” is not enough. AUD-01 can have OWNER_MANAGED status outside the 19-item remediation ledger.

Every phase summary must answer:

1. What behavior changed and why?
2. Which files/contracts/indexes/configuration changed?
3. Which failing original scenario now behaves correctly?
4. What was actually run, and against what source/environment?
5. What remains unverified or blocked?
6. What is required before the next phase or deployment?

Keep the final handoff compact enough to review. Logs supplement the source and tests; a long narrative of changes is not acceptance evidence.

## 16. Release decision

The final recommendation can be **GO for the verified candidate** only when:

- Every AUD-02–AUD-20 item is closed with evidence, including any applicable conditional exposure; no new applicable release blocker is open.
- Required lint/typecheck/build/test gates pass on the same final source pair. Skipped/cancelled tests and any advisory exceptions have specific reviewed explanations; no essential financial/auth/browser check is blocked.
- Mongo replica-set and real Redis/worker integration, actual provider verification and actual deployment-target browser checks are complete.
- Financial/index/legacy-data prerequisites are addressed by reviewed dry runs and explicit rollout instructions; no ambiguous accounting mode is guessed.
- Source ZIP contents, dependency locks and evidence match the exact candidate being recommended.
- Aadith separately confirms AUD-01 containment. This is not performed by Cursor or this plan.

After that recommendation, approve and deploy the concrete candidate through the normal release process. Do not release merely because all ten phase headings have completion summaries.
