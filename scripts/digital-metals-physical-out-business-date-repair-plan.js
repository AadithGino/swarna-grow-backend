#!/usr/bin/env node
/**
 * Dry-run only: lists DigitalMetalPhysicalOutEvent rows whose businessDate
 * would differ under IST calendar (vs legacy UTC slice on createdAt).
 * Does not mutate production data.
 *
 * Usage: node --env-file=.env scripts/digital-metals-physical-out-business-date-repair-plan.js [--dry-run]
 */
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { istBusinessDateFromInstant } from "../src/lib/digital-metals-business-calendar.js";
import { DigitalMetalPhysicalOutEvent } from "../src/models/index.js";

const dryRun = !process.argv.includes("--apply");

async function main() {
  await mongoose.connect(env.MONGODB_URI);
  const rows = await DigitalMetalPhysicalOutEvent.find({}).select("_id tenantId businessDate createdAt").lean();
  const mismatches = [];
  for (const row of rows) {
    const istDate = istBusinessDateFromInstant(row.createdAt ?? new Date());
    const legacyUtc = (row.createdAt ?? new Date()).toISOString().slice(0, 10);
    if (row.businessDate !== istDate || row.businessDate !== legacyUtc) {
      mismatches.push({
        id: row._id,
        tenantId: row.tenantId,
        storedBusinessDate: row.businessDate,
        istFromCreatedAt: istDate,
        legacyUtcSlice: legacyUtc,
        proposedBusinessDate: istDate,
      });
    }
  }
  console.log(
    JSON.stringify(
      {
        dryRun,
        totalEvents: rows.length,
        mismatchCount: mismatches.length,
        note: dryRun
          ? "No writes performed. Review proposedBusinessDate before any manual migration."
          : "Apply path not implemented — use an approved migration after review.",
        mismatches: mismatches.slice(0, 500),
      },
      null,
      2,
    ),
  );
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
