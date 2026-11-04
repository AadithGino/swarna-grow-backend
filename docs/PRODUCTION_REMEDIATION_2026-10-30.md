# Production remediation — 30 October 2026

Scope: F01–F13 and the unresolved walkthrough test from the production audit. Preserve existing brand colours and business pricing policies. No live payments, production data repair or deployment are included.

1. Payment callbacks, capture identity and refund obligations (F01, F05–F08).
2. Atomic quote/payout invariants and branch authorization (F02–F04).
3. Recovery of uncertain provider initiation (F09).
4. Portable production build, fail-closed configuration and quality gates (F10, F11, F13, walkthrough regression).
5. Dependency remediation, complete regression validation and release packaging (F12).

Every phase requires focused regression verification. Final acceptance also requires documented index migration/preflight and staging validation; local tests cannot prove live provider or deployment readiness.

## Phase 1 — Capture identity, callbacks and refunds

Implemented F01 and F05–F08. The redemption worker and handler share the normalized
PhonePe event contract and validate completed identifiers. A replay of the same
attempt is distinct from an additional captured attempt. Additional captures create
separate, immutable refund obligations for ecommerce and digital-metal purchases,
including after fulfilment has progressed. They do not credit metal twice or
rewrite completed physical redemption. Refund case completion and related order
resolution run together in a MongoDB transaction; the order exception clears only
when all relevant refund cases are closed.

The existing order-level refund URLs remain compatible. GET also returns `refunds`.
When an order has several cases, mutations require `refundId`; the admin UI sends
the displayed case ID and shows its actual amount. A case ID from another order is
rejected. Provider network calls remain outside database transactions and retain
stable provider references and recovery state.

## Phase 2 — Concurrency and branch authorization

Implemented F02–F04. Quote acceptance conditionally claims the customer-owned,
unexpired quote inside the reservation transaction and checks the affected count.
The tenant/quote unique index adds database enforcement. Concurrent payout creation
uses an in-session cap check, a shared payable version write and a partial unique
index for active instructions. Settlement rejects amounts above the outstanding
payable instead of clamping them. Existing maker/checker and evidence requirements
remain in force. Payout, buy refund and sell mutations check customer branch scope,
including idempotency replays.

## Phase 3 — Uncertain initiation and recovery

Implemented F09 across buy, ecommerce and redemption charges. Persisted PENDING
attempts enter the reconciler even when the provider-order response was lost.
Reconciliation falls back to the stable merchant-order ID, uses the existing lease,
and persists bounded retry progress and an exhaustion alert atomically. Invalid
completed responses and other unresolved outcomes consume retry budget. The active
attempt is not silently discarded to permit a fresh charge. Open-work summaries
also count the actual redemption statuses, so pending work remains visible.

## Phase 4 — Production configuration and release gates

Implemented F10, F11, F13 and the walkthrough regression. The frontend export has a
portable Node production build without private hosting imports. Production rejects
mock mode and missing, insecure, loopback or credential-bearing API URLs. Existing
brand CSS and logo assets are preserved. Hook and dependency lint findings were
fixed without disabling the rules. Backend contract coverage now includes all
478 applicable routes. The model request boundary takes a snapshot of conversation
contents, fixing mutation of earlier requests in the walkthrough test.

Source packagers can operate from an extracted ZIP without requiring Git metadata.
Source allowlists continue to exclude dependencies, build outputs and local secrets.
Backend test scripts use per-file process isolation so global hooks do not leak
across test files.

## Phase 5 — Dependencies and validation

Implemented F12 by refreshing the pinned dependency trees. Backend changes include
patched transitive dependencies and the compatible UUID override used by ExcelJS.
Frontend changes include patched React/Next, Zod, Vite, Vitest and build dependencies.
The pnpm overrides live in `pnpm-workspace.yaml`, where pnpm 11 actually applies
them. The existing seven-day minimum package release age remains enabled. Vitest
configuration uses the v4 project format. Release evidence and exact final test
totals are included in the separate remediation handoff bundle.

The original nine financial probes are now permanent regression tests, supplemented
by per-capture refund selection, refund rollback, overcommitted legacy settlement,
all three uncertain-initiation paths, exhaustion and invalid-provider responses.
Index tests exercise replacement order, duplicate-data refusal, idempotence and
concurrent production startup refusal before migration. Two older fixtures were
given the tenant-user role/type required by the authorization policy; their business
assertions were retained.

## Required offline index rollout

Production disables automatic index creation. Deploying this source before the
following migration intentionally fails database readiness. The migration command
connects independently of that startup guard, with `autoIndex: false`.

1. Back up MongoDB and verify a restore path. Pause API writes, workers, schedulers
   and any other writers for the migration window.
2. Run the read-only preflight against the intended database:

   ```sh
   node --env-file=.env scripts/migrate-financial-invariants.js
   ```

   Review duplicate groups and the required/legacy index report. Each duplicate
   group reports a count; output is capped at 100 groups per model, not a full data
   repair inventory. Duplicate quotes, active payouts or per-capture refund cases
   block apply. No ledger or financial history is automatically repaired.
3. Reconcile historical extra captures/refunds against provider reports and inspect
   overcommitted payables, physical orders previously moved into refund review, and
   stale uncertain attempts. The index preflight alone cannot find every historical
   business inconsistency. Resolve conflicts through a separately reviewed repair.
4. With writers still stopped, apply:

   ```sh
   node --env-file=.env scripts/migrate-financial-invariants.js --apply --writes-paused
   ```

   Replacement unique indexes are created before obsolete order-only refund indexes
   are removed. The operation is idempotent. `--writes-paused` is an operator
   attestation, not a mechanism that stops other processes. If apply fails, keep
   writers paused and inspect the report before retrying.
5. Review remaining index differences and create the other required model indexes:

   ```sh
   node --env-file=.env scripts/sync-indexes.js --dry-run
   node --env-file=.env scripts/sync-indexes.js --apply
   ```

   This procedure does not authorize unrelated index drops. Deploy API, workers and
   scheduler from the same release and verify readiness before reopening writes.

## Staging acceptance and scope limits

Run the intended provider sandbox/deployment round trips before production:

- Scheme payment, maturity redemption and premature closure: lock-in/penalty
  acknowledgement, stale rate/version rejection, ledger totals and final closure.
- Ecommerce payment, cancellation, return inspection/restock and refunds, including
  multiple captures after fulfilment advances and explicit refund case selection.
- Digital-metal buy, sell, maker/checker payout and physical redemption, including
  partial payout, pending/unknown provider outcomes, duplicate callbacks and late
  additional captures after dispatch/completion.
- Effective/future/stale rates for each supported purity and branch; verify the
  configured freshness policy and queue/readiness alerts in the deployed topology.
- Lost callbacks, worker restart, initiation response loss, browser return/reload,
  off-branch permissions and exhausted reconciliation alerts. Reconcile money and
  metal totals with provider/bank records and custody events.
- Backup restoration and expected concurrent load; observe long-running worker
  shutdown independently of tests that use `--test-force-exit` for bounded teardown.

Local verification uses disposable MongoDB replica sets and Redis with mocked
provider boundaries. It does not perform live payments, bank transfers, customer
data repair, physical handover, deployment or operational acceptance. Transactions,
unique constraints, idempotency and recovery reduce specific risks; they cannot make
external provider actions part of a MongoDB transaction or guarantee zero failures.
Historical READY notes in the source do not replace this rollout and acceptance.
The original audit evidence is retained separately.
