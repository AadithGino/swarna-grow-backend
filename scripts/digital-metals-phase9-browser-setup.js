/**
 * Prepares KAIRALI on the dev MongoDB for Phase 9 browser smoke (idempotent).
 * Run: node --env-file=.env scripts/digital-metals-phase9-browser-setup.js
 */
import { randomUUID } from "node:crypto";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { CustomerStatus, PlanTier, UserStatus } from "../src/constants/enums.js";
import { createId } from "../src/lib/ids.js";
import { computeTermsContentHash } from "../src/lib/digital-metals-readiness.js";
import {
  Branch,
  Customer,
  DigitalMetalAccessMarker,
  DigitalMetalJournal,
  DigitalMetalProcurementEntry,
  DigitalMetalTermsPublication,
  DigitalMetalWallet,
  Tenant,
  User,
} from "../src/models/index.js";

export const PHASE9_SMOKE_CUSTOMER_MOBILE = "9847099901";
export const PHASE9_SMOKE_MAKER_MOBILE = "9847012347";
export const PHASE9_SMOKE_APPROVER_MOBILE = "9847012345";

async function main() {
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) {
    throw new Error("KAIRALI tenant not found — run npm run seed:demo first.");
  }
  const branch = await Branch.findOne({ tenantId: tenant._id, active: true }).lean();
  if (!branch) throw new Error("No active branch for KAIRALI");

  await Tenant.updateOne(
    { _id: tenant._id },
    {
      $set: {
        "operations.digitalMetalsEnabled": true,
        "operations.digitalMetalsPaused": false,
        "operations.digitalMetalsTermsVersion": "phase9-smoke-v1",
        "subscription.planFeaturesSnapshot.digitalMetals": true,
        "subscription.tier": PlanTier.GROWTH,
      },
      $unset: {
        "operations.digitalMetalsPauseReason": "",
      },
    },
  );

  const terms = await DigitalMetalTermsPublication.findOne({
    tenantId: tenant._id,
    termsVersion: "phase9-smoke-v1",
  }).lean();
  if (!terms) {
    const contentSnapshot = "Phase 9 smoke terms.";
    await DigitalMetalTermsPublication.create({
      tenantId: tenant._id,
      termsVersion: "phase9-smoke-v1",
      contentSnapshot,
      contentHash: computeTermsContentHash({
        termsVersion: "phase9-smoke-v1",
        contentSnapshot,
      }),
      publishedAt: new Date(),
      publishedBy: "phase9-setup",
      active: true,
    });
  }

  let maker = await User.findOne({ tenantId: tenant._id, mobile: PHASE9_SMOKE_MAKER_MOBILE }).lean();
  let approver = await User.findOne({ tenantId: tenant._id, mobile: PHASE9_SMOKE_APPROVER_MOBILE }).lean();
  if (!maker || !approver) throw new Error("Seed users 9847012347 / 9847012345 missing — run npm run seed:demo");

  let smokeCustomer = await Customer.findOne({
    tenantId: tenant._id,
    mobile: PHASE9_SMOKE_CUSTOMER_MOBILE,
  }).lean();
  if (!smokeCustomer) {
    smokeCustomer = await Customer.create({
      _id: createId("customer"),
      tenantId: tenant._id,
      branchId: branch._id,
      customerNumber: "CUS-P9SMK",
      passbookNumber: "CUS-P9SMK",
      name: "Phase9 Smoke Customer",
      mobile: PHASE9_SMOKE_CUSTOMER_MOBILE,
      status: CustomerStatus.ACTIVE,
      kyc: { status: "VERIFIED", verifiedAt: new Date() },
    });
    process.stdout.write(`Created smoke customer ${PHASE9_SMOKE_CUSTOMER_MOBILE}\n`);
  }

  let wallet = await DigitalMetalWallet.findOne({
    tenantId: tenant._id,
    customerId: smokeCustomer._id,
    metal: "GOLD",
    finenessPpm: 916_000,
  }).lean();
  if (!wallet) {
    wallet = await DigitalMetalWallet.create({
      _id: createId("dmw"),
      tenantId: tenant._id,
      customerId: smokeCustomer._id,
      branchId: branch._id,
      metal: "GOLD",
      finenessPpm: 916_000,
      heldUg: 2_000_000,
      reservedUg: 0,
      journalSequence: 1,
    });
    await DigitalMetalJournal.create({
      _id: createId("dmj"),
      tenantId: tenant._id,
      walletId: wallet._id,
      sequence: 1,
      entryType: "CREDIT",
      quantityUgDelta: 2_000_000,
      reservedUgDelta: 0,
      idempotencyKey: `phase9-smoke-journal-${smokeCustomer._id}`,
      referenceType: "SMOKE_SEED",
      referenceId: "phase9",
    });
    process.stdout.write("Created GOLD 916000 wallet + journal for smoke customer\n");
  }

  await DigitalMetalAccessMarker.updateOne(
    { tenantId: tenant._id, customerId: smokeCustomer._id },
    { $set: { kinds: ["HOLDINGS"] } },
    { upsert: true },
  );

  const owner = await User.findOne({
    tenantId: tenant._id,
    mobile: { $regex: /9847012345$/ },
    status: UserStatus.ACTIVE,
  }).lean();

  const existingOpening = await DigitalMetalProcurementEntry.findOne({
    tenantId: tenant._id,
    entryType: "OPENING_POSITION",
    status: "APPROVED",
  }).lean();
  if (!existingOpening && owner) {
    await DigitalMetalProcurementEntry.create({
      tenantId: tenant._id,
      entryType: "OPENING_POSITION",
      status: "APPROVED",
      metal: "GOLD",
      finenessPpm: 999_000,
      quantityUg: 2_000_000,
      obligationQuantityUg: 2_000_000,
      effectiveDate: "2020-01-01",
      evidenceUploadIds: ["phase9-smoke-evidence"],
      createdByUserId: owner._id,
      approvedByUserId: owner._id,
      idempotencyKey: randomUUID(),
    });
    process.stdout.write("Created approved OPENING_POSITION for hedge smoke.\n");
  }

  process.stdout.write(
    JSON.stringify(
      {
        tenantId: tenant._id,
        smokeCustomerId: smokeCustomer._id,
        smokeCustomerMobile: PHASE9_SMOKE_CUSTOMER_MOBILE,
        makerMobile: PHASE9_SMOKE_MAKER_MOBILE,
        approverMobile: PHASE9_SMOKE_APPROVER_MOBILE,
        providerModeHint: "Restart worker with PROVIDER_MODE=mock for local PDF storage",
      },
      null,
      2,
    ),
  );
  process.stdout.write("\n");
  await disconnectDatabase();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
