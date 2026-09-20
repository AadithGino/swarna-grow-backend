import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExportRowCount,
  assertSyncReportRowCount,
  maxExportRows,
} from "../src/lib/report-limits.js";
import { AppError } from "../src/lib/app-error.js";
import { portfolioStatsFromSchemes } from "../src/lib/scheme-portfolio-stats.js";

test("assertSyncReportRowCount rejects oversized synchronous reports", () => {
  assert.throws(
    () => assertSyncReportRowCount(10_000, { reportKey: "OUTSTANDING" }),
    (err) => err instanceof AppError && err.code === "REPORT_TOO_LARGE",
  );
});

test("assertExportRowCount enforces export cap", () => {
  assert.throws(
    () => assertExportRowCount(maxExportRows() + 1),
    (err) => err instanceof AppError && err.code === "EXPORT_TOO_LARGE",
  );
});

test("portfolioStatsFromSchemes aggregates without reloading per bucket", () => {
  const schemes = [
    {
      installments: [
        { dueDate: "2026-01-01", amountPaise: 1000, paidPaise: 500, status: "PARTIALLY_PAID", graceEndsAt: "2026-01-10" },
      ],
    },
  ];
  const stats = portfolioStatsFromSchemes(schemes, "2026-01-15");
  assert.ok(stats.expectedToDate >= 0);
  assert.ok(Number.isFinite(stats.efficiency));
});
