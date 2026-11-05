/**
 * Spread KAIRALI timestamps across the current calendar month (IST) so charts populate:
 * collections, redemptions, enrolments, new customers, gold accrual cumulative grams.
 *
 * Idempotent — safe to re-run before a webinar (~5–15s).
 *
 *   npm run patch:kairali-dashboard-charts
 */
import dayjs from "dayjs";
import mongoose from "mongoose";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { PaymentStatus } from "../src/constants/enums.js";
import { env } from "../src/config/env.js";
import { today } from "../src/lib/date.js";
import { netCollectionStatusFilter } from "../src/lib/payment-net-aggregation.js";
import {
  Branch,
  Customer,
  LedgerEntry,
  Payment,
  Redemption,
  Scheme,
  Tenant,
} from "../src/models/index.js";

const TENANT_CODE = "KAIRALI";
const MODES = ["CASH", "UPI", "CARD", "CASH", "UPI", "CARD", "ONLINE_GATEWAY"];
/** Relative weight per day in month (ramps toward today). */
const DAY_WEIGHTS = [0.6, 0.75, 0.85, 0.95, 1.0, 1.05, 1.1];

function istDayStart(ymd) {
  return dayjs.tz(`${ymd}T00:00:00`, env.APP_TIMEZONE);
}

function monthDaysThroughToday() {
  const endYmd = today();
  const start = istDayStart(endYmd).startOf("month");
  const end = istDayStart(endYmd);
  const days = [];
  for (let d = start; !d.isAfter(end, "day"); d = d.add(1, "day")) {
    days.push(d.format("YYYY-MM-DD"));
  }
  return days;
}

function pickDay(days, index) {
  const weights = days.map((_, i) => DAY_WEIGHTS[i % DAY_WEIGHTS.length] ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let target = (index * 17) % total;
  for (let i = 0; i < days.length; i += 1) {
    target -= weights[i];
    if (target <= 0) return days[i];
  }
  return days[days.length - 1];
}

/** Spread index 0..total-1 monotonically across month days (for cumulative gold trend). */
function pickDaySpread(days, index, total) {
  if (!days.length) return today();
  if (total <= 1) return days[0];
  const slot = Math.round((index / (total - 1)) * (days.length - 1));
  return days[Math.min(days.length - 1, Math.max(0, slot))];
}

function istTimestamp(ymd, hour, minute) {
  return istDayStart(ymd).hour(hour).minute(minute).second(0).toDate();
}

async function main() {
  await connectDatabase();

  const tenant = await Tenant.findOne({ code: TENANT_CODE });
  if (!tenant) {
    throw new Error(`Tenant ${TENANT_CODE} not found`);
  }
  const tenantId = tenant._id;

  const branches = await Branch.find({ tenantId, active: true }).lean();
  const branchIds = branches.map((b) => b._id);
  if (!branchIds.length) {
    throw new Error("No active branches");
  }

  const days = monthDaysThroughToday();
  if (!days.length) {
    throw new Error("No days in range");
  }

  const payments = await Payment.find({
    tenantId,
    ...netCollectionStatusFilter(),
    refundedAmountPaise: { $lte: 0 },
  })
    .sort({ amountPaise: -1 })
    .limit(160)
    .select("_id mode branchId paidAt amountPaise")
    .lean();

  const paymentOps = payments.map((row, i) => {
    const ymd = pickDay(days, i);
    const hour = 9 + (i % 8);
    const minute = 10 + ((i * 7) % 50);
    const paidAt = istDayStart(ymd).hour(hour).minute(minute).second(0).toDate();
    const mode = MODES[i % MODES.length];
    const branchId = branchIds[i % branchIds.length];
    return {
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { paidAt, mode, branchId } },
      },
    };
  });

  let paymentResult = { modifiedCount: 0 };
  if (paymentOps.length) {
    paymentResult = await Payment.bulkWrite(paymentOps, { ordered: false });
  }

  const redemptions = await Redemption.find({
    tenantId,
    status: "COMPLETED",
  })
    .sort({ updatedAt: -1 })
    .limit(24)
    .select("_id completedAt")
    .lean();

  const redemptionOps = redemptions.map((row, i) => {
    const ymd = days[i % days.length];
    const completedAt = istDayStart(ymd).hour(15 + (i % 3)).minute(30).second(0).toDate();
    return {
      updateOne: {
        filter: { _id: row._id },
        update: { $set: { completedAt } },
      },
    };
  });

  let redemptionResult = { modifiedCount: 0 };
  if (redemptionOps.length) {
    redemptionResult = await Redemption.bulkWrite(redemptionOps, { ordered: false });
  }

  const schemes = await Scheme.find({ tenantId })
    .sort({ createdAt: 1 })
    .select("_id createdAt startDate")
    .lean();
  const schemeOps = schemes.map((row, i) => {
    const ymd = pickDay(days, i + 3);
    return {
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: {
            createdAt: istTimestamp(ymd, 8 + (i % 4), (i * 11) % 55),
            startDate: ymd,
          },
        },
      },
    };
  });
  let schemeResult = { modifiedCount: 0 };
  if (schemeOps.length) {
    schemeResult = await Scheme.bulkWrite(schemeOps, { ordered: false });
  }

  const customers = await Customer.find({ tenantId })
    .sort({ createdAt: 1 })
    .select("_id createdAt")
    .lean();
  const customerOps = customers.map((row, i) => {
    const ymd = pickDay(days, i + 5);
    return {
      updateOne: {
        filter: { _id: row._id },
        update: {
          $set: { createdAt: istTimestamp(ymd, 10 + (i % 3), (i * 13) % 50) },
        },
      },
    };
  });
  let customerResult = { modifiedCount: 0 };
  if (customerOps.length) {
    customerResult = await Customer.bulkWrite(customerOps, { ordered: false });
  }

  const goldSchemeIds = (
    await Scheme.find({ tenantId, valueBasis: "GOLD_WEIGHT" }).select("_id").lean()
  ).map((s) => s._id);
  let ledgerResult = { modifiedCount: 0 };
  let ledgerOps = [];
  if (goldSchemeIds.length) {
    const ledgerEntries = await LedgerEntry.find({
      tenantId,
      schemeId: { $in: goldSchemeIds },
    })
      .sort({ schemeId: 1, sequence: 1 })
      .select("_id effectiveAt")
      .lean();
    ledgerOps = ledgerEntries.map((row, i) => {
      const ymd = pickDaySpread(days, i, ledgerEntries.length);
      return {
        updateOne: {
          filter: { _id: row._id },
          update: {
            $set: {
              effectiveAt: istTimestamp(ymd, 11 + (i % 5), (i * 9) % 55),
            },
          },
        },
      };
    });
    if (ledgerOps.length) {
      const ledgerColl = mongoose.connection.collection(LedgerEntry.collection.name);
      ledgerResult = await ledgerColl.bulkWrite(ledgerOps, { ordered: false });
    }
  }

  const inMonthFrom = days[0];
  const inMonthTo = days[days.length - 1];
  const monthRange = {
    $gte: istDayStart(inMonthFrom).toDate(),
    $lte: istDayStart(inMonthTo).endOf("day").toDate(),
  };
  const [monthPayments, monthRedemptions, monthEnrolments, monthCustomers] = await Promise.all([
    Payment.countDocuments({ tenantId, status: PaymentStatus.SUCCESS, paidAt: monthRange }),
    Redemption.countDocuments({ tenantId, status: "COMPLETED", completedAt: monthRange }),
    Scheme.countDocuments({ tenantId, createdAt: monthRange }),
    Customer.countDocuments({ tenantId, createdAt: monthRange }),
  ]);

  console.log(
    JSON.stringify(
      {
        tenantCode: TENANT_CODE,
        period: { from: inMonthFrom, to: inMonthTo },
        paymentsPatched: paymentOps.length,
        paymentsModified: paymentResult.modifiedCount ?? paymentResult.nModified,
        redemptionsPatched: redemptionOps.length,
        redemptionsModified: redemptionResult.modifiedCount ?? redemptionResult.nModified,
        schemesPatched: schemeOps.length,
        schemesModified: schemeResult.modifiedCount ?? schemeResult.nModified,
        customersPatched: customerOps.length,
        customersModified: customerResult.modifiedCount ?? customerResult.nModified,
        goldLedgerPatched: ledgerOps.length,
        goldLedgerModified: ledgerResult.modifiedCount ?? ledgerResult.nModified,
        verify: {
          paymentsInMonth: monthPayments,
          completedRedemptionsInMonth: monthRedemptions,
          enrolmentsInMonth: monthEnrolments,
          customersRegisteredInMonth: monthCustomers,
        },
      },
      null,
      2,
    ),
  );

  await disconnectDatabase();
}

main().catch(async (err) => {
  console.error(err);
  await disconnectDatabase();
  process.exit(1);
});
