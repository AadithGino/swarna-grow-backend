# SwarnaGrow production audit

**Audit date:** 5 November 2026, Asia/Kolkata  
**Decision:** **NO-GO for production sign-off.**  
**Scope:** Uploaded backend and tenant-admin frontend, including the customer and agent portals, schemes, ecommerce, digital metals, PhonePe and OTP. Routing, in-app back behavior, cache updates and render boundaries were explicitly reviewed.

The builds succeeding does not establish production readiness. This source has an exposed service-account private key, reproduced branch authorization defects, inconsistent PhonePe merchant references, OTP concurrency problems, and failing release checks. Frontend tests miss several defects reproduced during this audit.

This is a source, dependency, build and targeted execution audit. It is **not** a production penetration test, a live-money test, a complete browser walkthrough, or a completed database release gate. These limits are material, not fine print.

## Source identity and method

| Input | SHA-256 |
|---|---|
| `swarnagrow-backend-20261105-000912.zip` | `c1f91f26a99eca3d52aab7e61532ac227b4cba5933e2d818ea444f4637d44a26` |
| `SwarnaGrow-Tenant-Admin-20261105-001050.zip` | `72917c22cb91c0531aacde75ff9e16023d2ab58552f8faed219f2e8e0fb4e8f4` |

Backend paths below are relative to `swarnagrow-backend/`. Frontend paths are relative to `SwarnaGrow-Tenant-Admin/`. Line numbers refer to the uploaded application source, not compiled bundles. Dependency installation and generated builds were performed only in extracted audit copies. New reproduction tests were added to those copies; no production application fixes or live database changes were made. Earlier audit reports and historical logs inside the archives were not counted as current verification.

The backend was installed from its npm lockfile with install scripts disabled. The frontend was installed with its declared pnpm 11.25.0 frozen lockfile, also with install scripts disabled. The application's normal frontend build and Vercel build were executed. Node was v24.22.1.

## Checks actually completed

| Check | Result | Meaning |
|---|---|---|
| Backend npm frozen installation | Passed | Declared npm dependencies installed. |
| Frontend pnpm frozen installation | Passed | Declared package manager and lockfile work. |
| Frontend npm frozen installation | Failed | The additional npm lockfile is stale; pnpm remains the declared path. |
| Backend syntax | Passed: 975 JavaScript files | Syntax only. |
| Backend contract route coverage | Passed: 468 applicable routes | Route presence/guard coverage is not proof of resource authorization. |
| Backend outbox transaction-session check | Passed | The checker found sessions on enqueue calls. |
| Backend lint | Failed: 3 errors | `npm run check` is not green. |
| Backend supplied `test:audit:unit` | 35 passed | Focused existing tests. |
| Backend additional four-file unit selection | 36 passed | Overlaps the previous run; do not add counts together. |
| Backend broader 82-file selection without direct Mongo setup | 358 tests: 342 passed, 11 failed, 5 skipped | Ten failures require unavailable Redis; one is a missing `.env.example`. This is not the full release suite. |
| Backend targeted Mongo integration command | Blocked during database setup | MongoMemoryServer's Debian 12 MongoDB 7.0.24 download returned HTTP 403. No clean integration result was obtained. |
| Frontend supplied Vitest suite | 79 files, 226 passed | Original tests, before audit probes were added. |
| Frontend typecheck | Failed: 2 errors | Checkout normalization has unknown-to-string type errors. |
| Frontend lint | Failed: 4 errors | Includes one static-component rule report and three unused imports. |
| Frontend normal build | Passed | Compilation bundles successfully despite failed typecheck/lint. |
| Frontend Vercel build, `NEXT_PUBLIC_USE_MOCKS=false` | Passed | Nitro/Vercel build completes; warnings remain. |
| Backend production dependency audit | 0 advisories reported | Registry audit result, not proof of security. |
| Frontend production dependency audit | 23 advisories: 3 critical, 7 high, 9 moderate, 4 low | Reachability differs by deployment; see AUD-07. |
| Added backend reproductions | 6 passed | These tests intentionally assert the defective behavior described below. |
| Added frontend reproductions | 5 passed | These tests intentionally assert the defective behavior described below. |
| Actual Chromium browser walkthrough | Blocked | Local Chromium could not create its required socket under the execution environment. No browser render timings or full browser navigation results are claimed. |

## Prioritized findings

P0 requires immediate containment. P1 blocks release until fixed or the specific conditional exposure is disproved with evidence. P2 is an observable correctness, usability, performance or packaging defect. **Reproduced** means a targeted application/component probe ran; model doubles do not replace a Mongo or HTTP integration test. **Source-confirmed** means the relevant executable paths establish the defect. **Conditional** means exposure depends on deployment configuration or runtime reachability.

| ID | Priority | Finding | Evidence level |
|---|---|---|---|
| AUD-01 | P0 | Firebase service-account private key included in backend archive | Source-confirmed |
| AUD-02 | P1 | Ecommerce branch authorization bypasses remain | Reproduced at service level |
| AUD-03 | P1 | Fixed-scheme polling and refunds use the wrong merchant order ID | Reproduced / source-confirmed |
| AUD-04 | P1 | OTP verification and consumption are not atomic | Reproduced for local provider path; Redis race inferred from implementation |
| AUD-05 | P1 | OTP send limit can be bypassed by changing destination numbers | Source-confirmed |
| AUD-06 | P1 | Distinct PhonePe callback events can collapse into one deduplication ID | Reproduced |
| AUD-07 | P1 | Frontend lockfile contains critical/high dependency advisories | Registry-confirmed; exploitability conditional |
| AUD-08 | P1 | Shared clock hook can cause maximum-update-depth failures | Reproduced in component harness |
| AUD-09 | P1 | Configured OTP length is discarded before reaching login UI | Reproduced |
| AUD-10 | P1 | Required frontend/backend release checks fail | Executed |
| AUD-11 | P1 | Production frontend can silently default to mock data and actions | Source-confirmed; deployment conditional |
| AUD-12 | P1 | Vercel queue maintenance endpoint fails open without cron secret | Source-confirmed; deployment conditional |
| AUD-13 | P2 | In-app back guard reads unsupported history metadata and pushes fallbacks | Reproduced |
| AUD-14 | P2 | Customer tenant context broadcasts changes on unchanged data | Reproduced |
| AUD-15 | P2 | Quote timer rerenders full checkout and expiry does not disable its CTA immediately | Source-confirmed |
| AUD-16 | P2 | Order polling stops before fulfilment is finished | Source-confirmed |
| AUD-17 | P2 | Customer order-list cache is disconnected from order mutations | Source-confirmed |
| AUD-18 | P2 | Source packaging/deployment paths are inconsistent | Executed / source-confirmed |
| AUD-19 | P2 | Vercel navigation patch can replace soft navigation with document reloads | Source-confirmed fallback; activation unverified |
| AUD-20 | P1 | Customer session is not bound to the tenant in the URL | Reproduced at guard level; full live request sequence unverified |

### AUD-01 — Service-account private key in distributed source

**File:** Backend root `swarna-grow-firebase-adminsdk-fbsvc-63a93c9a1f.json`.

The archive contains a JSON object with `type: service_account`, a private-key identifier and a PEM private key. Only presence/type were inspected for reporting; secret bytes are not included in this report or evidence bundle. Whether the key is still active and its assigned IAM privileges were not tested.

**Impact:** Anyone receiving this archive obtains the key material. `.gitignore` does not protect a manually created archive. Deleting the file from a future ZIP does not revoke an already distributed credential.

**Fix:** Check the key identifier in the owning Google project; revoke the exposed key if active and replace it through the deployment secret mechanism. Review use of the exposed identity. Export only an explicit source allowlist, and add a private-key/service-account scan to packaging and CI. Scan nested ZIPs too.

**Closure evidence:** Revocation/replacement recorded without revealing secrets; clean source export and nested-archive scan show no credential material.

### AUD-02 — Branch managers can reach other branches' ecommerce work

**Files:** Backend `src/services/ecommerce-order-handover.service.js:40` and `:265`; `src/services/ecommerce-order-return.service.js:81` and `:249`; `src/services/ecommerce-order.service.js:560` and `:580`; `src/services/ecommerce-admin-order-list.service.js:19`; `src/routes/admin-ecommerce.routes.js:689`; `src/constants/permissions.js`.

The legacy pickup-code and delivery-proof services load by order ID and tenant ID but do not apply the actor's branch scope. Return decisions use `loadReturnForAdmin`, which also loads by ID and tenant only. The branch-manager role has the relevant ecommerce operational permissions. Route permission guards do not add the missing resource check.

Two model-backed service probes demonstrated a manager from `branch_a` issuing a six-digit code for a pickup at `branch_b`, and approving a return for another branch's order. Both succeeded. Order lists, details and events also omit actor branch filtering in the inspected paths, which makes this more than a hidden-ID issue. The newer compound fulfilment service does perform branch checks; those checks do not cover the older endpoints.

**Impact:** Unauthorized same-tenant cross-branch disclosure and operational changes, including pickup-code rotation and return decisions. This is a branch-isolation defect, not evidence of cross-tenant database access.

**Fix:** Centralize an authorized order/return loader. Resolve pickup-branch versus delivery customer-branch policy consistently. Enforce it in list, detail, events, pickup-code issue/reissue, tracking, handover, cancellation, return and refund endpoints. Keep the check within the financial mutation's transaction where applicable. Do not rely on frontend visibility.

**Regression:** A branch-A manager receives the chosen consistent 403/404 behavior for every branch-B read and write; no code, event, version, stock or refund changes occur. Same-branch operations and tenant-wide roles must still work.

### AUD-03 — Payment-link merchant IDs differ from reservation IDs

**Files:** Backend `src/services/payment.service.js:1833`, `:1904` and `:1962`; `src/services/payment-poll-status.service.js:42`; `src/services/payment-refund-initiation.service.js:181`; `src/services/phonepe-refund-reconcile.service.js:35`; `src/services/phonepe-reconcile.service.js` (`resolveMerchantOrderIdForPayment`).

The fixed-scheme SDK path creates the PhonePe order using the **payment-link ID** as `merchantOrderId`. Its associated `PaymentIntent` is a separate reservation record. Admin polling chooses `intent._id`, while refund initiation and refund reconciliation also use `intent._id` as `originalMerchantOrderId`.

Probe result: the shared reconciliation resolver returned `plk_actual`, while the admin status path queried `pmi_reservation`. A refund-status probe independently captured `pmi_reservation` as the original merchant order reference. Direct intent flows can work, which hides this defect in tests that assume the intent and provider reference are interchangeable.

**Impact:** Status recovery queries the wrong PhonePe order. Refund initiation can fail or refer to the wrong original order. The admin path also performs a preliminary provider lookup and then another lookup during reconciliation, adding avoidable work.

**Fix:** Persist the exact original merchant order ID as an immutable field at initiation. Use one canonical resolver for status, initiation recovery and refunds across fixed links, public links and direct intents. For legacy records, resolve through their bound link/intent relationships; do not blindly strip a final receipt number after successful allocation. Do not substitute a PhonePe-generated provider order ID for the merchant's original order ID.

**Regression:** Initiate a fixed-scheme payment with distinct link, reservation and provider IDs; status, refund initiation and refund status all send the same original merchant ID. Repeat for flexible intent and public-link flows, including after the payment receipt number changes.

### AUD-04 — OTP validation, attempt counting and consumption can race

**Files:** Backend `src/integrations/otp.provider.js:106`, `:121`, `:273` and `:276`; `src/services/auth.service.js:279` and `:318`.

Verification reads a record, validates it and later deletes it. Customer login creates the session **before** consuming the OTP. There is no application-level single-use claim bound to `otpId`. Two concurrent `otpProvider.verify` calls using one valid local OTP both returned `true` in the probe. Production Redis uses the same separate GET/SET/DEL pattern; no atomic consume is present. Redis incorrect-attempt increments are also read/modify/write rather than atomic.

The probe used the local/mock provider to isolate application behavior. Message Central's own concurrent validation semantics were not tested, so duplicate successful live Message Central logins are not claimed as observed.

**Impact:** The application cannot itself guarantee one successful use or an exact attempt budget. An older verification can also delete a newer record created during resend because consumption deletes by key without comparing the challenge ID.

**Fix:** Use Redis Lua or a comparable atomic state transition to claim/consume the matching challenge and count attempts. Bind the operation to tenant, canonical mobile, purpose and exact challenge ID. Handle external validation with a bounded claim lease and a defined recoverable failure policy. Issue at most one successful authentication result per claimed challenge, with deliberate idempotent replay if supported.

**Regression:** Twenty concurrent verifies result in one consumption/authentication operation; wrong attempts cannot lose increments; resend during a slow verification preserves the new challenge; Redis outage fails closed in production.

### AUD-05 — OTP rate limits do not bound total sends

**Files:** Backend `src/middlewares/security.middleware.js:6`, `:13` and `:154`; `src/routes/public.routes.js:23` and `:26`; `src/services/auth.service.js` (`requestOtp`).

The OTP endpoints are excluded from the general public limiter. The send bucket key combines IP and mobile number. A caller can create a new bucket for each new destination. SIGNUP requests can request codes for previously unregistered numbers when tenant self-registration is enabled. Per-number resend cooldown does not cap aggregate SMS volume.

**Impact:** SMS pumping/cost abuse and provider saturation remain possible even from one IP, using multiple valid numbers and distinct idempotency keys. Distributed callers further weaken IP-only protection.

**Fix:** Apply independent limits for IP, destination, tenant and platform/provider budget. Preserve per-number cooldown, but do not use a composite key as the sole overall quota. Add challenge/escalation thresholds for public signup sends and alert on volume anomalies. Bound forgot-password/signup entry points consistently.

**Regression:** One IP cycling through many destinations hits its total budget; tenant and global budgets remain effective across multiple app instances. Normal retries with the same idempotency key do not send extra messages.

### AUD-06 — Webhook deduplication confuses transactions with events

**Files:** Backend `src/lib/phonepe-webhook-identity.js:25`; `src/services/webhook-event.service.js` (`persistVerifiedWebhook`); `src/workers/processors.js:496`.

When no explicit event/callback ID is present, `paymentDetails[0].transactionId` is treated as an immutable event identity. That early return excludes callback type and state. The probe generated identical IDs for a transaction-attempt failure and a final order failure with the same transaction ID. The first event can therefore cause the later distinct event to be discarded as a duplicate. The worker intentionally treats an attempt failure as non-terminal, making the distinction operationally important.

**Impact:** Legitimate payment lifecycle transitions can be lost. Scheduled status reconciliation may reduce the damage but is not a valid deduplication contract.

**Fix:** Prefer a provider field only when it is documented as a unique event ID. Otherwise include the event type, order/refund identity, transaction and terminal state in a stable canonical identity. Avoid using an ambiguous generic `payload.id` as an event ID without confirming its semantics. Preserve true duplicate suppression and allow distinct lifecycle events.

**Regression:** Attempt failure followed by order failure persists/processes both; accepted then completed refund events both process; exact replays have no duplicate accounting effect; out-of-order terminal callbacks remain safe.

### AUD-07 — Dependency advisories require deployment-aware remediation

**Files:** Frontend `package.json`, `pnpm-lock.yaml`, `vite.config.ts` and generated deployment output.

The production pnpm audit reports **23 advisories: 3 critical, 7 high, 9 moderate, 4 low**. `next` is pinned to **16.3.4**. The lockfile also includes **sharp 0.35.4** under Next and **zod 3.25.76**. Examples from the returned audit:

| Advisory | Package | Reported issue / patch |
|---|---|---|
| GHSA-vcvr-r3jv-pc5j | next | `next/og` ImageResponse RCE; patched in 16.3.6 |
| GHSA-2464-fhr4-w9xw | next / image processing | SVG image-optimization RCE advisory; Next patch 16.4.1; upstream workaround sharp >=0.35.5 |
| GHSA-673q-mjm6-r5xr | next | Typed-array `use cache` RCE advisory; patched in 16.4.1 |
| GHSA-p3m5-59mp-jv5r | next | App Router Server Actions denial of service; patched in 16.4.1 |
| GHSA-mrhx-c7xc-m3w5 | zod | Constrained-collection memory exhaustion; audit reports patch >=4.6.6 |

The actual application is built through **Vinext**, rather than the standard Next CLI. The inspected application source did not establish a reachable `next/og` or typed-array `use cache` exploit. Dependency audit severity must not be presented as proof that this deployed app is exploitable. Conversely, the deployment difference is not sufficient evidence to dismiss the advisories.

**Fix:** Update to compatible versions at or above the reported patched releases, checking Vinext's peer requirements and its image implementation. Update Next and matching lint tooling together, refresh the declared pnpm lockfile, and verify the exact resolved sharp version in the deployment artifact. Do not blindly force a Zod major upgrade without checking schemas/resolvers. Assess build-only transitive advisories separately from internet-reachable runtime paths. Re-run dependency audit and build tests after remediation.

**Primary references:** [Next SVG/image advisory](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw), [Next cache advisory](https://github.com/vercel/next.js/security/advisories/GHSA-673q-mjm6-r5xr), [Next ImageResponse advisory](https://github.com/vercel/next.js/security/advisories/GHSA-vcvr-r3jv-pc5j). The complete returned dependency-audit JSON is in the evidence bundle.

### AUD-08 — Clock snapshots are unstable between notifications

**Files:** Frontend `src/hooks/use-now-ms.ts:10`; `src/features/support/sla-chip.tsx:17`.

`useSyncExternalStore` reads `Date.now()` directly as its snapshot. Time changes independently of the minute interval's notification, so two snapshot reads can disagree without any store update. In a component probe where the clock advances one millisecond between reads, React repeatedly rendered and reached **Maximum update depth exceeded** before a clock interval fired.

**Impact:** Support SLA chips can trigger unnecessary work and potentially crash their render subtree. A minute-long subscription interval does not make the snapshot stable.

**Fix:** Keep a cached timestamp that changes only when the clock store emits, with a shared subscription/interval and cleanup, or use local state/effect in a small clock-dependent component. Keep the server snapshot stable. Do not call a continuously changing getter from an external-store snapshot.

**Regression:** Repeated snapshots between notifications are identical; zero timer notifications cause no continuing renders; a minute tick updates the affected chips only; unmount clears subscriptions.

**Reference:** [React's snapshot contract](https://react.dev/reference/react/useSyncExternalStore).

### AUD-09 — Non-six-digit OTP logins are broken in the UI

**Files:** Frontend `src/components/customer/customer-tenant-context.tsx:99` and `:119`; `src/features/customer/customer-auth-page.tsx:50`; `src/lib/customer-otp-ui.ts`.

The provider's tenant type declares `otpLength` and `authCountryCode`, and the resolved tenant can contain them. Its constructed context tenant copies neither field. The login screen derives its code length from that context and defaults to six. A probe supplying backend `otpLength: 4` observed a six-digit UI requirement.

**Impact:** A correctly delivered four-digit or eight-digit Message Central code cannot satisfy this frontend's validation. Unit-testing the length helper alone missed the broken data path.

**Fix:** Preserve validated `otpLength` and country metadata through normalization and context construction. Test the real provider-to-login path for four, six and eight digits. Remove the hardcoded example mobile and `123456` OTP initial values from the production login form. The current SMS provider deliberately supports India only; adding country metadata alone does not implement UAE SMS support.

### AUD-10 — Build scripts do not enforce the release gate

**Backend lint failures:**

- `scripts/configure-evoluxe-phonepe.js:102` — unused assignment to `verified`.
- `src/services/digital-metals-buy-payment.service.js:403` — unused assignment to `resolvedAttempt`.
- Same file `:404` — unused assignment to `resolvedOrder`.

**Frontend type errors:**

- `src/lib/customer-phonepe-checkout.ts:32` and `:42` — `unknown` fields passed to a helper typed to accept strings/null/undefined.

**Frontend lint failures:**

- `src/features/customer/customer-activity-row.tsx:42` — `react-hooks/static-components` report for `activityIcon(item)`.
- `src/features/customer/customer-home-page.tsx:24` — unused `formatCustomerDate`.
- `src/features/customer/customer-shop-order-page.tsx:25` — unused `readShopPaymentIdempotencyKey`.
- `src/store/api/customer-api.ts:77` — unused `CustomerRecentActivityItem`.

The icon helper returns imported stable icon components; the lint diagnostic by itself does **not** prove that this icon remounts each render. Resolve the rule-compatible representation without claiming a demonstrated runtime remount.

**Fix:** Correct these issues, and make the deployed build depend on successful lint, typecheck and the required tests. The current successful builds must not bypass those checks. Keep fixes separate from financial behavior changes where possible.

### AUD-11 — Missing production frontend flag selects mocks

**Files:** Frontend `src/config/env.ts:5`; `src/store/api/admin-api.ts`; `src/store/api/customer-api.ts`; `src/store/slices/customer-session-slice.ts`.

`readUseMocks()` returns `true` when the flag is absent or unrecognized. There is no production failure gate here. Customer session initial state is also authenticated in mock mode. The default build completed without being required to declare live API mode; the explicit Vercel audit build used `NEXT_PUBLIC_USE_MOCKS=false`.

**Impact:** A missing build-time variable can produce a deployed application showing demo balances and simulated successful actions. This does not bypass backend auth, but it is unacceptable for an operational financial UI. Current live hosting variables were not inspected, so an existing deployment is not asserted to be in mock mode.

**Fix:** Production builds fail unless live mode and a valid HTTPS API base are explicit. Make mock access an explicit development/test choice. Add a smoke check against a unique staging response that cannot be returned by fixtures.

### AUD-12 — Cron authorization fails open on Vercel

**Files:** Backend `api/cron/queue-tick.js:20`; `api/cron/keep-warm.js` (`authorize`).

When `CRON_SECRET` is missing, queue-tick authorizes any request if `VERCEL === "1"`. It then runs dispatch, digital-metal outbox dispatch and lease reclamation. Keep-warm has a similar deployment-dependent open fallback. The cron handlers live outside the Express route rate-limit stack. The source does not require this secret in production environment validation.

**Impact:** An incorrectly configured deployment exposes maintenance execution to unauthenticated callers, allowing repeated resource consumption and job dispatch activity. This is not a claim that the current production secret is absent.

**Fix:** Require a nonempty cron secret for production cron handlers and fail closed when absent. Accept it through the authorization header, not query strings. Add bounded invocation controls and report degraded subsystem results as unhealthy rather than always returning an overall `ok: true` after caught errors.

### AUD-13 — In-app Back usually pushes a new list entry

**Files:** Frontend `src/lib/navigate-back.ts:8` and `:30`; `src/lib/portal-nav.ts`; installed `vinext/dist/server/app-history-state.js`.

The guard requires `window.history.state.idx > 0`. The installed Vinext implementation maintains its own `__vinext_historyIndex`; the app does not write `idx`. The component probe supplied valid Vinext history metadata and a recorded previous portal path, yet `canNavigateBackInPortal()` returned false and `navigateBack()` called `push(fallback)`.

**Impact:** The app button does not traverse the browser stack in that scenario. It adds another entry, which can produce list/detail loops when the real browser Back button is used afterwards. It also loses the natural return route, query filters and scroll context. This concerns the app's custom Back buttons; native browser Back was not demonstrated to be universally broken.

The current tracker stores only current/previous pathname, not a real history stack, search parameters or push/replace/pop direction. Merely switching to another framework-private index does not solve that design.

**Fix:** Track app-owned navigation entries/keys while preserving router history state. Distinguish push, replace and pop. Include the full relative URL and portal/tenant identity. Only traverse when the actual preceding entry is known to be safe; use `replace(fallback)` on direct entry. Persist important list filters/cursor/tab in URL or a scoped view-state store so restoration survives a page remount. Handle denied sessionStorage access.

**Regression:** Test list→detail→Back, browser Back/Forward, filtered/paginated lists, detail→detail, refresh/direct entry, external referrer, login redirect and different customer tenant slugs. Verify both URL and history length/direction, plus filter and scroll restoration.

### AUD-14 — Tenant context defeats its own memoization

**File:** Frontend `src/components/customer/customer-tenant-context.tsx:99` and `:119`.

`normalizeCustomerTenantBranding()` constructs a new tenant object on every provider render. That object is a dependency of the context value's `useMemo`, so the context value changes even when its source data has not. A provider rerender probe observed a different context value with unchanged tenant content.

**Impact:** Context consumers throughout the customer portal are scheduled to render on unrelated parent/provider updates, weakening the persistent shell and page boundaries.

**Fix:** Memoize normalization by the raw resolved tenant reference or stable primitives. Keep the provider value stable when its exposed values are unchanged. Consider separate branding/capability contexts only if profiling shows a useful boundary; do not create a large new state architecture to fix one identity bug.

**Regression:** An unrelated parent update does not notify a memoized context-only consumer; changing tenant branding/capabilities still updates the relevant UI.

### AUD-15 — Checkout timer owns too much state; expiry CTA is inconsistent

**File:** Frontend `src/features/customer/customer-shop-quote-page.tsx:34`, `:56`, `:71`, `:111` and `:236`.

The one-second countdown hook runs in the full quote page. Each tick therefore reruns the entire checkout component, including product rows, policy links, address and totals. The page constructs a new `Date` every render; that value is the countdown effect dependency, causing the timer to be torn down and recreated after each update.

There is also a correctness mismatch: the expired banner uses the local countdown, but `canPlaceOrder` only uses the last server status. For up to the next 30-second query poll, the screen can say the quote expired while its Place Order button is still enabled. Backend expiry checks may reject it; this is a frontend inconsistency, not proof of an expired server order being accepted.

**Fix:** Put ticking state in a small countdown/status component, use a stable numeric expiry, and notify the parent once at expiry. Derive CTA eligibility from both server permission/status and the actual deadline. Stop the clock when no longer needed. Keep server expiry authoritative.

**Regression:** A one-second tick updates the countdown, not the static order/address/totals subtree. Crossing the deadline immediately disables placement and offers a fresh quote. No interval restarts occur from unrelated form changes.

### AUD-16 — Payment terminal status is not fulfilment terminal status

**Files:** Frontend `src/lib/customer-payment-polling.ts:10` and `:27`; `src/features/customer/customer-shop-order-page.tsx:105`; `src/features/customer/customer-digital-metals-redeem-pages.tsx:575`.

The shop order stops polling at `PAID`, before shipping or pickup. A digital-metal redemption stops order polling at `CHARGE_PAID`, and its separate fulfilment query is not polled. The inspected queries do not enable focus/reconnect refresh on these endpoints.

**Impact:** A customer leaving the tracking page open can miss packing, shipping, pickup-ready and collection/delivery updates. A pickup instructions query may never start if the cached fulfilment status does not advance to `PICKUP_READY`.

**Fix:** Separate payment polling from fulfilment freshness. Stop high-frequency payment polling at financial terminal states, then use slower visible-page fulfilment polling or targeted push invalidation until actual completion/cancellation. Enable focus/reconnect refresh and avoid background polling when the page is hidden.

### AUD-17 — Order-list cache does not update with order changes

**File:** Frontend `src/store/api/customer-api.ts:1415` and `:1433` and related order mutations.

`listShopOrders` supplies no order-list tag. Creating an order does not invalidate it. Cancellation/return mutations invalidate `ShopCart` and individual detail tags, but the list does not provide them. Returning to a recently visited list can therefore reuse stale entries and statuses. Its endpoint-only paginated merge also appends without deduplicating IDs, making repeated page fetches another possible source of duplicate rows.

**Fix:** Add dedicated order LIST and per-order tags. Invalidate/update the affected entity and relevant lists after creation, payment success, cancellation and return/refund changes. Merge pages by stable order ID. Reset the paginated list on tenant/customer changes. Avoid invalidating the entire customer API for every small mutation.

**Regression:** Load list, create/cancel/pay for an order, return within the cache lifetime: the list reflects the change. Re-fetching a cursor does not append duplicates. Narrow invalidation does not refetch unrelated plans/profile data.

### AUD-18 — Export and deployment inputs need one reproducible path

**Files:** Backend archive root and `tests/phase-g1-env.test.js:33`; frontend `package-lock.json`, `pnpm-lock.yaml`, `package.json`, `netlify.toml`.

The backend `.env.example` is absent, and the existing environment-contract test fails with ENOENT. At the same time the archive includes a real service-account key, runtime/mock storage and historical outputs. The frontend includes generated deployment directories and nested older source/deployment ZIPs. Its extra npm lockfile does not match `package.json` (`npm ci` fails), while its declared pnpm lockfile installs. `netlify.toml` calls `pnpm run build:netlify`, but no such package script exists.

**Impact:** Different deployment instructions select different or stale inputs. The current upload is not a clean, self-contained release export. A stale npm lockfile is not a failure of the verified pnpm install, but it should not remain as an apparent supported alternative.

**Fix:** Export source from an allowlist with input hashes. Include a non-secret complete environment template. Standardize pnpm for the frontend and npm for the backend, removing or regenerating any intentionally supported secondary lockfile. Repair or remove unused deployment configurations. Exclude nested releases, generated builds, caches, logs and uploaded/mock data from the source package.

### AUD-19 — Framework fallback can trigger complete reloads

**File:** Frontend `vite.config.ts:62` and `:79`.

The Vercel build patches Vinext's Link implementation. If its dynamically imported `navigateClientSide` export is absent, it calls `window.location.assign` or `replace`. That is a full document navigation, remounting providers, shell and page state. The source comment ties this to a minification compatibility issue. The fallback is confirmed in source; whether it fires in the actual production build was not observable here.

**Fix:** Resolve and pin the framework/bundler compatibility issue rather than relying on hidden reloads for normal portal navigation. Instrument fallback activation in staging. Keep hard navigation for actual external destinations such as PhonePe, where it is expected. Do not remove the fallback before a tested soft-navigation path exists.

**Regression:** On the Vercel deployment target, normal internal links issue no new document request and preserve the shell DOM instance. Browser Back/Forward works after payment return and across lazy route chunks. A change to page content may rerender; the shared shell should not remount merely because the route changes.

### AUD-20 — URL tenant, auth session and cache can disagree

**Files:** Frontend `src/components/customer/customer-tenant-context.tsx`; `src/components/customer/customer-registration-guard.tsx`; `src/features/customer/customer-auth-page.tsx:60`; `src/store/slices/customer-session-slice.ts`; `src/store/api/customer-api.ts:749` and `:903`; `src/lib/auth-token-storage.ts`.

The customer URL selects branding/tenant resolution, but the customer access/refresh tokens use one global storage slot. The registration guard accepts any stored customer token or authenticated flag; it does not compare the session's tenant with the resolved URL tenant. Login also redirects an already authenticated customer without that comparison. Protected home/profile queries have void cache keys, and a URL tenant change does not reset them.

A guard probe rendered protected content under a tenant-B URL context while the supplied authenticated session belonged to tenant A. Backend bearer authentication still determines the actual data tenant: this is **not evidence that tenant-B data can be read using tenant-A authorization**. The risk is presenting tenant-A balances/actions under tenant-B branding and routes, plus reusing cached tenant-A data. The exact live request/payment sequence needs a browser integration test.

**Fix:** Bind customer auth and query-cache identity to a stable backend tenant ID and customer ID. On tenant URL mismatch, block protected queries/actions and require an explicit switch/login or redirect to the authenticated tenant. Verify the identity from the authenticated backend profile; do not trust a decoded JWT as sole authorization. Preserve tenant identity across refresh, cross-tab changes, payment-return context and stored pending checkout keys. Reset or scope caches on identity changes.

**Regression:** Log into A, open B's customer link in the same tab and another tab, then reload, refresh a token and return from PhonePe. No A balance is displayed as B, and no action intended for B is silently submitted under A.

## Domain review: what was established and what remains open

| Area | Positive controls observed in current source | Required runtime proof before sign-off |
|---|---|---|
| Scheme enrolment and contributions | Transactions, durable enrolment operation support, position/version fences, first-payment and capacity guards are present. | Concurrent first payments; retry after timeout/cache loss; capacity cap; fixed/flexible cycle boundaries and reversal restoration against a replica set. |
| Maturity, premature closure and settlement | Scoped redemptions, KYC gates, settlement snapshots, contribution eligibility checks, exact-date 22K valuation and purchase bill requirement are present. Maintenance uses version fences in inspected paths. | Cross-midnight rate changes; concurrent payment/refund versus closure; minimum/forfeit/penalty boundaries; one final ledger debit and correct cash/weight outputs. |
| Scheme payment recovery/refunds | Shared reconciliation exists; success finalization and accounting use transaction/idempotency safeguards. | AUD-03 fixed-link reference repair; missing/duplicate/out-of-order webhook; partial and cumulative refunds; provider timeout/unknown result; late success after expiry. |
| Ecommerce checkout/inventory | Quote/order snapshots, stock reservation mechanisms, versioned compound fulfilment and cancellation/restock protections are present. | Concurrent last-item orders, quote expiry versus payment, COD acceptance expiry, delivery with unconfirmed collection and courier money receipt, return/cancel/refund overlap. |
| Ecommerce pickup/delivery | Newer compound actions enforce branch/version checks and bind evidence. | Close AUD-02 on every legacy path; pickup code issue/reissue/consume races; one evidence-backed transition; repeat handover does not complete twice. |
| Digital-metal buy | Quote/payment finalization, wallet journal, lot and transaction protections are present. | Exactly one credit under webhook/poll/retry overlap; accepted money with expired quote; refund-review behavior; counter tender and cash-custody reconciliation. |
| Digital-metal sell/payout | Immediate finalization path, payable-aware replay, separate payout state and risk/branch guards are present. | Customer confirmation and counter sell auto-execute once; accepted sale is payment pending until evidence; uncertain payout never creates a second obligation; permissions and bank destination stay bound. |
| Digital-metal reservations/physical redemption | Explicit lot accounting modes fail closed on ambiguous legacy reservations; expiry is scheduled every minute; fulfilment has evidence/version mechanisms. | Inspect the actual deployment database for ambiguous reservations; reconcile without guessing modes; expire/release unattended work once; late charge payment versus expiry/handover. No current live count was obtained. |
| Daily Hedge Book | Dedicated book/perimeter/aggregation services and source uniqueness constraints are present. | Opening + purchases - sells - physical out +/- corrections reconciles to wallet/lot/physical journals under concurrent close-day changes. |
| MongoDB invariants | Snapshot/majority transactions and a financial-index readiness gate are present. | Required indexes actually installed; duplicate obligations absent; crash/retry/commit ambiguity tests on the deployed MongoDB version/topology. Schema declarations alone are insufficient. |
| Worker/scheduler operations | Repeatable jobs include reservation expiry, payment reconciliation, outbox and recovery work. Worker heartbeat/readiness code exists. | Real Redis/BullMQ startup, missing-worker readiness, restart recovery, stalled leases, queue backlog and dead-letter handling. Vercel API deploy alone does not run long-lived workers. |
| OTP | Message Central integration has tenant credentials, provider timeouts, purpose binding, code-length storage and production Redis requirements. | AUD-04/05/09 closure; actual provider delivery and validation for configured lengths; provider downtime and concurrent resend/verify. |

These are controls observed, not blanket assurances that the areas are defect-free. The blocked Mongo/Redis gates prevent that conclusion.

## Frontend rendering and navigation acceptance contract

The target is to minimize **unnecessary render work**, while keeping query freshness and state correctness. Render, DOM commit and remount are different events. A component may render without changing the DOM; a remount destroys state. Do not apply `React.memo` or `useMemo` everywhere and call the requirement satisfied.

The existing portal layout already keeps shell structure above page content, and the admin sidebar/topbar use memoized boundaries. Preserve that arrangement. Fix the broken history, unstable context/clock and state ownership first.

| Trigger | Expected work | Work that should remain isolated |
|---|---|---|
| Route change | Active navigation item, page content and route-dependent effects update. | Shared shell instance stays mounted; unrelated global data need not refetch. |
| Search typing | Search input updates; debounced query fetches once per settled value. | Sidebar, branding and unrelated cards do not run expensive work. |
| Checkout countdown | A small clock/status display updates. | Product rows, address, policy and totals do not rerender each second just for time. |
| Notification read | Notification rows/count and matching badge update. | Scheme/order lists do not all refetch. |
| Payment succeeds | Affected payment/order, customer balance and relevant list tags update. | Unrelated plans/settings avoid broad invalidation. |
| Branch change | All visible branch-scoped data refreshes; pagination resets appropriately. | Data must never be retained merely to suppress a legitimate refresh. |
| Tenant/customer switch | Auth identity validated, cache isolated/reset, appropriate data reloads. | Old user's data must not survive under new branding. |
| Back/Forward | Prior full URL, filters, tab/cursor and scroll restore. | No new fallback history entry during an ordinary safe back traversal. |

Use a browser production build with React Profiler and mount counters to verify these boundaries. Record render counts and durations before/after; no precise performance improvement is claimed by this audit. Include desktop and narrow mobile screens, keyboard focus, lazy loading/error states, direct deep links and PhonePe external-return navigation. Normal external payment redirects remain document navigations by design.

## Release remediation order

1. **Contain credentials:** AUD-01, including already distributed archives.
2. **Restore data/transaction identity:** AUD-02, AUD-03 and AUD-20. These affect authority and which merchant/account an action belongs to.
3. **Fix authentication and callback integrity:** AUD-04, AUD-05, AUD-06 and AUD-09.
4. **Harden the release boundary:** AUD-07, AUD-10, AUD-11 and AUD-12. Resolve deployment-specific exposure with concrete artifact/configuration evidence.
5. **Fix the render loop and user-visible flow defects:** AUD-08 and AUD-13 through AUD-19. The clock fix is small enough to perform alongside earlier work.
6. **Run the missing database, queue, provider and browser gates on one frozen candidate.** Do not combine green output from different source trees.

## Minimum final verification

Run these from clean source trees after fixes, with only synthetic/staging configuration and isolated test infrastructure. Do not import the production database URI into tests.

```bash
# Backend
npm ci
npm run check
npm run test:audit:unit
npm run test:audit:integration
npm run test:release
npm audit --omit=dev
```

```bash
# Frontend (declared package manager)
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm audit --prod
NEXT_PUBLIC_USE_MOCKS=false pnpm build:vercel
```

The full release command requires a usable MongoMemoryServer binary and the suite's required Redis setup. The audit reproductions included in the evidence bundle assert today's defective behavior; convert them into desired-behavior regression tests before adding them to the release suite.

Additional sign-off evidence must include the source hashes, exact command exit codes, Mongo and Redis test infrastructure versions, live-provider sandbox traces for scheme/shop/digital-metal payments, delayed/duplicate webhook and refund outcomes, browser back/forward tests on the actual deployment target, tenant/branch isolation matrix, and migration/index readiness against the chosen staging database.

**Sign-off condition:** No open P0, no unresolved applicable P1, no failing required checks, and no blocked financial/authorization integration gate. A green build or the existing 226 frontend tests alone is insufficient.

## Evidence bundle

The accompanying ZIP contains this report, unmodified check output, dependency-audit JSON, the selected test-file list, and the added frontend/backend reproduction tests. The reproductions use synthetic identities/model doubles; they do not contact real customers or transfer money. No service-account key or input source archive is included.

Key files: `frontend-tests.log`, `frontend-typecheck.log`, `frontend-lint.log`, `frontend-build.log`, `frontend-vercel-build.log`, `backend-check.log`, `backend-db-free.log`, `backend-audit-integration.log`, `frontend-probes.log`, `backend-probes.log`, and both dependency-audit JSON files.
