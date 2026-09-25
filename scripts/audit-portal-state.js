/**
 * Compare a portal action manifest with the live database.
 * Usage: node --env-file=.env scripts/audit-portal-state.js <manifest.json>
 */
import fs from "node:fs";
import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { OPEN_ENROLLMENT_STATUSES } from "../src/lib/scheme-enrollment-status.js";
import {
  Branch,
  CashHandover,
  Customer,
  Grievance,
  LedgerEntry,
  Payment,
  Redemption,
  Scheme,
  Tenant,
  User,
} from "../src/models/index.js";
import { dashboard } from "../src/services/reporting.service.js";
import { maturityBoardSummary } from "../src/services/admin-summary.service.js";

const issues = [];

function issue(area, detail) {
  issues.push({ area, detail });
}

async function main() {
  const manifest = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  await connectDatabase();
  const tenant = await Tenant.findOne({ code: "KAIRALI" }).lean();
  if (!tenant) {
    issue("tenant", "KAIRALI tenant is missing");
    finish();
    return;
  }
  const scope = { tenantId: tenant._id };
  const req = { auth: { tenantId: tenant._id, type: "TENANT_USER" }, scope, query: {} };

  if (manifest.dashboard) {
    const live = await dashboard({ ...req, query: { period: manifest.dashboard.period ?? "THIS_MONTH" } });
    const shown = manifest.dashboard.raw ?? {};
    const pairs = [
      ["today collection paise", shown.today?.amountPaise, live.today.amountPaise],
      ["today payment count", shown.today?.count, live.today.count],
      ["active customers", shown.customers?.active, live.customers.active],
      ["open enrollments", shown.schemes?.open, live.schemes.open],
      ["overdue schemes", shown.schemes?.overdue, live.schemes.overdue],
      ["matured schemes", shown.schemes?.matured, live.schemes.matured],
      ["pending cash handovers", shown.attention?.pendingCashHandovers, live.attention.pendingCashHandovers],
      ["open grievances", shown.attention?.openGrievances, live.attention.openGrievances],
      ["open redemptions", shown.attention?.openRedemptions, live.attention.openRedemptions],
    ];
    for (const [label, ui, db] of pairs) {
      if (ui == null) issue("dashboard", `UI did not return ${label}`);
      else if (Number(ui) !== Number(db)) {
        issue("dashboard", `${label}: screen/API ${ui}, database ${db}`);
      }
    }
    const activeCustomers = await Customer.countDocuments({ ...scope, status: "ACTIVE" });
    const openSchemes = await Scheme.countDocuments({ ...scope, status: { $in: OPEN_ENROLLMENT_STATUSES } });
    const matured = await Scheme.countDocuments({ ...scope, status: "MATURED" });
    const openRedemptions = await Redemption.countDocuments({
      ...scope,
      status: { $in: ["REQUESTED", "PENDING_APPROVAL", "APPROVED"] },
    });
    if (activeCustomers !== live.customers.active) {
      issue("dashboard", `active customer query ${activeCustomers} != dashboard ${live.customers.active}`);
    }
    if (openSchemes !== live.schemes.open) {
      issue("dashboard", `open scheme query ${openSchemes} != dashboard ${live.schemes.open}`);
    }
    if (matured !== live.schemes.matured) {
      issue("dashboard", `matured query ${matured} != dashboard ${live.schemes.matured}`);
    }
    if (openRedemptions !== live.attention.openRedemptions) {
      issue("dashboard", `open redemption query ${openRedemptions} != dashboard ${live.attention.openRedemptions}`);
    }
    const pendingCash = await CashHandover.countDocuments({ ...scope, status: "PENDING" });
    const openGrievances = await Grievance.countDocuments({
      ...scope,
      status: { $in: ["OPEN", "IN_PROGRESS"] },
    });
    if (pendingCash !== live.attention.pendingCashHandovers) {
      issue("dashboard", `pending handover query ${pendingCash} != dashboard ${live.attention.pendingCashHandovers}`);
    }
    if (openGrievances !== live.attention.openGrievances) {
      issue("dashboard", `open grievance query ${openGrievances} != dashboard ${live.attention.openGrievances}`);
    }
  }

  if (manifest.maturity) {
    const live = await maturityBoardSummary({
      ...req,
      query: manifest.maturity.query ?? {},
    });
    const shown = manifest.maturity.summary ?? {};
    for (const key of ["upcoming", "maturedToday", "incomplete", "notRedeemed", "liabilityPaise", "goldMg"]) {
      if (shown[key] == null) continue;
      if (Number(shown[key]) !== Number(live[key])) {
        issue("maturity", `${key}: screen/API ${shown[key]}, database ${live[key]}`);
      }
    }
  }

  if (manifest.customer) {
    const customer = await Customer.findOne({ ...scope, mobile: manifest.customer.mobile }).lean();
    if (!customer) issue("customer", `no customer saved for ${manifest.customer.mobile}`);
    else {
      if (customer.name !== manifest.customer.name) {
        issue("customer", `name saved as "${customer.name}", form was "${manifest.customer.name}"`);
      }
      if (customer.status !== "ACTIVE") issue("customer", `status is ${customer.status}, expected ACTIVE`);
      if (!customer.branchId) issue("customer", "branchId was not saved");
      manifest.customer.id = customer._id;
      manifest.customer.branchId = customer.branchId;
    }
  }

  if (manifest.scheme) {
    const scheme = await Scheme.findById(manifest.scheme.id).lean();
    if (!scheme) issue("enrollment", `scheme ${manifest.scheme.id} was not saved`);
    else {
      if (manifest.customer?.id && scheme.customerId !== manifest.customer.id) {
        issue("enrollment", "scheme customer does not match the customer just created");
      }
      if (manifest.customer?.branchId && scheme.branchId !== manifest.customer.branchId) {
        issue("enrollment", `scheme branch ${scheme.branchId} != customer branch ${manifest.customer.branchId}`);
      }
      const payments = await Payment.find({ ...scope, schemeId: scheme._id, status: "SUCCESS" }).lean();
      const ledger = await LedgerEntry.countDocuments({ ...scope, schemeId: scheme._id, type: "INSTALLMENT_PAYMENT" });
      if (["ACTIVE", "LOCKED"].includes(scheme.status) && payments.length === 0) {
        issue("enrollment", `scheme is ${scheme.status} but has no successful payment`);
      }
      if (payments.length > 0 && ledger === 0) {
        issue("enrollment", "a successful payment was saved without an installment ledger row");
      }
      if (payments.length > 0 && scheme.status === "PENDING_PAYMENT") {
        issue("enrollment", "payment succeeded but the scheme is still pending payment");
      }
      manifest.scheme.status = scheme.status;
      manifest.scheme.payments = payments.length;
      manifest.scheme.ledger = ledger;
    }
  }

  if (manifest.branch) {
    const branch = await Branch.findOne({ ...scope, code: manifest.branch.code }).lean();
    if (!branch) issue("branch", `branch code ${manifest.branch.code} was not saved`);
    else if (branch.name !== manifest.branch.name) {
      issue("branch", `name saved as "${branch.name}", form was "${manifest.branch.name}"`);
    }
  }

  if (manifest.staff) {
    const staff = await User.findOne({ ...scope, mobile: manifest.staff.mobile }).lean();
    if (!staff) issue("staff", `staff mobile ${manifest.staff.mobile} was not saved`);
    else {
      if (staff.role !== "BRANCH_STAFF") issue("staff", `role saved as ${staff.role}, form was BRANCH_STAFF`);
      if (!staff.branchId) issue("staff", "branchId was not saved");
      if (staff.status && staff.status !== "ACTIVE") issue("staff", `status is ${staff.status}`);
      if (staff.name !== manifest.staff.name) {
        issue("staff", `name saved as "${staff.name}", form was "${manifest.staff.name}"`);
      }
    }
  }

  if (manifest.redemption) {
    const row = await Redemption.findById(manifest.redemption.id).lean();
    if (!row) issue("redemption", `redemption ${manifest.redemption.id} was not saved`);
    else {
      if (row.status !== "APPROVED") issue("redemption", `status is ${row.status} after approval, expected APPROVED`);
      if (!row.approvedAt || !row.approvedBy) issue("redemption", "approvedAt or approvedBy was not saved");
      if (!(row.settlementPaise > 0)) issue("redemption", "settlement amount was not saved");
      const snapshot = row.modeDetails?.settlementSnapshot;
      if (!snapshot) issue("redemption", "settlement snapshot is missing on the request");
      else if (Number(snapshot.settlementPaise) !== Number(row.settlementPaise)) {
        issue("redemption", `snapshot ${snapshot.settlementPaise} != redemption ${row.settlementPaise}`);
      }
      const scheme = await Scheme.findById(row.schemeId).select("status").lean();
      if (scheme?.status === "REDEEMED") {
        issue("redemption", "scheme was marked redeemed on approval, before handover was completed");
      }
      const debit = await LedgerEntry.countDocuments({
        ...scope,
        redemptionId: row._id,
        type: "REDEMPTION_DEBIT",
      });
      if (debit > 0) issue("redemption", "a ledger debit was written on approval, before completion");
      manifest.redemption.status = row.status;
      manifest.redemption.settlementPaise = row.settlementPaise;
      manifest.redemption.mode = row.mode;
      manifest.redemption.schemeStatus = scheme?.status;
    }
  }

  finish(manifest);
}

function finish(manifest) {
  const out = {
    issues,
    scheme: manifest?.scheme,
    redemption: manifest?.redemption,
  };
  fs.writeFileSync(
    new URL("../docs/e2e-audit-db.json", import.meta.url),
    JSON.stringify(out, null, 2),
  );
  console.log(JSON.stringify(out, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => disconnectDatabase().catch(() => {}));
