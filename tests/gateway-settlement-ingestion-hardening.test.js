import test from "node:test";
import assert from "node:assert/strict";
import { escapeCsvCell } from "../src/lib/csv-formula-escape.js";
import { SettlementItem, SettlementRun } from "../src/models/index.js";
import {
  formatSettlementItemsForCsvExport,
  uploadGatewaySettlementStatement,
} from "../src/services/gateway-settlement.service.js";
import { GATEWAY_SETTLEMENT_MAX_ITEMS } from "../src/validators/gateway-settlement.validators.js";
import { createId } from "../src/lib/ids.js";
import { resetTestDb, seedTenantUser, startTestDb, stopTestDb } from "./helpers/db.js";

test.before(async () => { await startTestDb(); });
test.after(async () => { await stopTestDb(); });
test.beforeEach(async () => { await resetTestDb(); });

function mockReq(tenantId, body = {}) {
  return { auth: { tenantId, id: "usr_test" }, body };
}

test("formula characters escaped on export", () => {
  const csv = formatSettlementItemsForCsvExport([
    { providerTransactionId: "=SUM(A1)", settledAmountPaise: 100 },
  ]);
  assert.match(csv, /^providerTransactionId,providerRefundId,settledAmountPaise/);
  assert.match(csv, /'=SUM\(A1\)/);
  assert.equal(escapeCsvCell("+100"), "'+100");
});

test("upload rejects malformed amounts and oversized row count", async () => {
  const { tenant } = await seedTenantUser();
  await assert.rejects(
    () => uploadGatewaySettlementStatement(mockReq(tenant._id, {
      businessDate: "2026-09-22",
      items: [{ providerTransactionId: "tx1", settledAmountPaise: 1.5 }],
    })),
    (error) => error.code === "SETTLEMENT_AMOUNT_INVALID",
  );
  const tooMany = Array.from({ length: GATEWAY_SETTLEMENT_MAX_ITEMS + 1 }, (_, i) => ({
    providerTransactionId: `tx_${i}`,
    settledAmountPaise: 100,
  }));
  await assert.rejects(
    () => uploadGatewaySettlementStatement(mockReq(tenant._id, {
      businessDate: "2026-09-22",
      items: tooMany,
    })),
    (error) => error.code === "SETTLEMENT_TOO_MANY_ROWS",
  );
});

test("safe filename stored without path segments", async () => {
  const { tenant } = await seedTenantUser();
  const businessDate = "2026-03-18";
  const upload = await uploadGatewaySettlementStatement(mockReq(tenant._id, {
    businessDate,
    sourceFileName: "../../etc/passwd.csv",
    items: [{ providerTransactionId: `tx_${createId("stl")}`, settledAmountPaise: 1000 }],
  }));
  assert.equal(upload.duplicate, false);
  assert.ok(upload.runId);
  const run = await SettlementRun.findOne({ _id: upload.runId, tenantId: tenant._id }).lean();
  assert.ok(run, "expected settlement run to persist for upload.runId");
  assert.equal(run.sourceFileName, "passwd.csv");
  assert.equal(await SettlementItem.countDocuments({ tenantId: tenant._id }), 1);
});

test("malformed upload leaves no partial items", async () => {
  const { tenant } = await seedTenantUser();
  await assert.rejects(
    () => uploadGatewaySettlementStatement(mockReq(tenant._id, {
      businessDate: "2026-09-22",
      items: [{ settledAmountPaise: 1000 }],
    })),
    (error) => error.code === "SETTLEMENT_ROW_INVALID",
  );
  assert.equal(await SettlementItem.countDocuments({ tenantId: tenant._id }), 0);
});
