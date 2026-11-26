/**
 * Backfill REDEMPTION_DEBIT ledger rows for ecommerce orders that consumed
 * scheme reservations before phase 8 (debits written on CONSUMED).
 *
 *   node scripts/backfill-ecommerce-scheme-ledger-debits.js --dry-run
 *   node scripts/backfill-ecommerce-scheme-ledger-debits.js --apply
 *   node scripts/backfill-ecommerce-scheme-ledger-debits.js --apply --tenant-id ten_xxx
 */
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { recordOnlineShopRedemptionLedgerDebit } from "../src/lib/ecommerce-scheme-ledger-debit.js";
import { findEcommerceSchemeLedgerBackfillCandidates } from "../src/lib/ecommerce-scheme-ledger-backfill.js";
import { netReservationUnits } from "../src/lib/ecommerce-scheme-net-spend.js";
import { withTransaction } from "../src/lib/transaction.js";

function parseArgs(argv) {
  const apply = argv.includes("--apply");
  const dryRun = !apply || argv.includes("--dry-run");
  const tenantIdx = argv.indexOf("--tenant-id");
  const tenantId = tenantIdx >= 0 ? argv[tenantIdx + 1] : null;
  return { apply, dryRun, tenantId };
}

async function main() {
  const { apply, dryRun, tenantId } = parseArgs(process.argv.slice(2));
  await connectDatabase();
  try {
    const candidates = await findEcommerceSchemeLedgerBackfillCandidates(tenantId);
    console.log(`Found ${candidates.length} CONSUMED reservation(s) without REDEMPTION_DEBIT.`);
    let applied = 0;
    let failed = 0;
    for (const { reservation, order, redemptionId } of candidates) {
      const net = netReservationUnits(reservation);
      const line = [
        reservation.tenantId,
        reservation.schemeId,
        order.orderNumber ?? order._id,
        redemptionId,
        net,
      ].join(" · ");
      if (dryRun) {
        console.log(`[dry-run] would backfill: ${line}`);
        continue;
      }
      try {
        const ok = await withTransaction(async (session) => {
          return recordOnlineShopRedemptionLedgerDebit({
            tenantId: reservation.tenantId,
            order,
            session,
            actorId: "backfill-ecommerce-scheme-ledger-debits",
          });
        });
        if (ok) {
          applied += 1;
          console.log(`[applied] ${line}`);
        } else {
          console.log(`[skip] ${line} (no debit written)`);
        }
      } catch (err) {
        failed += 1;
        console.error(`[fail] ${line}`, err?.message ?? err);
      }
    }
    if (!dryRun) console.log(`Done. applied=${applied} failed=${failed}`);
  } finally {
    await disconnectDatabase();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});