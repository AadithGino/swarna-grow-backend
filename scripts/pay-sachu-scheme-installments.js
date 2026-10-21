/**
 * One-off: record scheme installment payments for Sachu Sudhish until 3 SUCCESS payments.
 * Usage: node --env-file=.env scripts/pay-sachu-scheme-installments.js
 */
import { connectDatabase } from "../src/config/database.js";
import {
  Customer,
  Scheme,
  Payment,
  Tenant,
  User,
  LedgerEntry,
} from "../src/models/index.js";
import { PaymentStatus, UserType } from "../src/constants/enums.js";
import { recordPayment } from "../src/services/payment.service.js";
import { rebuildSchemeProjection } from "../src/services/scheme.service.js";

async function recomputeSchemeStatuses(schemeId) {
  const scheme = await Scheme.findById(schemeId);
  if (!scheme) return;
  const entries = await LedgerEntry.find({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
  })
    .sort({ sequence: 1 })
    .lean();
  rebuildSchemeProjection(scheme, entries);
  scheme.version += 1;
  await scheme.save();
}

function makeCtx(tenant, user) {
  const branchId = user.branchId;
  return {
    auth: {
      id: user._id,
      tenantId: tenant._id,
      type: UserType.TENANT_USER,
      role: user.role,
      ...(branchId ? { branchId } : {}),
    },
    scope: {
      tenantId: tenant._id,
      ...(branchId ? { branchId } : {}),
    },
    tenant,
    baseUrl: "/api/v1/admin",
    headers: { "user-agent": "pay-sachu-scheme-installments" },
    ip: "127.0.0.1",
    body: {},
    query: {},
  };
}

const TARGET_PAYMENTS = 3;

await connectDatabase();

const customer = await Customer.findOne({ name: "Sachu Sudhish" }).lean();
if (!customer) {
  console.error("Customer Sachu Sudhish not found");
  process.exit(1);
}

const tenant = await Tenant.findById(customer.tenantId).lean();
const schemes = await Scheme.find({ customerId: customer._id })
  .sort({ createdAt: 1 })
  .lean();
const scheme = schemes[0];
if (!scheme) {
  console.error("No scheme for Sachu Sudhish");
  process.exit(1);
}

console.log(
  "Customer:",
  customer.name,
  customer.mobile,
  "| Tenant:",
  tenant.code,
);
console.log(
  "Scheme:",
  scheme.enrollmentNumber,
  "| installmentPaise:",
  scheme.installmentAmountPaise,
);

const owner = await User.findOne({
  tenantId: tenant._id,
  role: "TENANT_OWNER",
}).lean();
if (!owner) {
  console.error("No TENANT_OWNER for tenant", tenant.code);
  process.exit(1);
}

const ctx = makeCtx(tenant, owner);
let paid = await Payment.countDocuments({
  schemeId: scheme._id,
  status: PaymentStatus.SUCCESS,
});
console.log("SUCCESS payments before:", paid);

while (paid < TARGET_PAYMENTS) {
  const doc = await Scheme.findById(scheme._id);
  await recordPayment({
    ...ctx,
    body: {
      schemeId: doc._id,
      amountPaise: doc.installmentAmountPaise,
      mode: "CASH",
      expectedVersion: doc.version,
    },
  });
  paid += 1;
  console.log(`Recorded payment ${paid}/${TARGET_PAYMENTS}`);
}

await recomputeSchemeStatuses(scheme._id);

const after = await Scheme.findById(scheme._id).lean();
paid = await Payment.countDocuments({
  schemeId: scheme._id,
  status: PaymentStatus.SUCCESS,
});
console.log(
  "Done:",
  after.enrollmentNumber,
  after.status,
  "| SUCCESS payments:",
  paid,
);

process.exit(0);
