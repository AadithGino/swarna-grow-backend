import test from "node:test";
import assert from "node:assert/strict";
import { findEcommerceSchemeLedgerBackfillCandidates } from "../src/lib/ecommerce-scheme-ledger-backfill.js";
import { startTestDb, stopTestDb, resetTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });

test("findEcommerceSchemeLedgerBackfillCandidates returns empty on fresh db", async () => {
  await resetTestDb();
  const rows = await findEcommerceSchemeLedgerBackfillCandidates();
  assert.equal(rows.length, 0);
});