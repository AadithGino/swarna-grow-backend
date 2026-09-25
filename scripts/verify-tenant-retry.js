import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Customer,
  GoldRate,
  Grievance,
  Scheme,
  SchemePlan,
  Tenant,
} from "../src/models/index.js";
import { SubscriptionUpgradeRequest } from "../src/models/platform.models.js";

await connectDatabase();
const plans = await SchemePlan.find({ code: /^AU/ }).select("name code displayName status").lean();
const customer = await Customer.findById("cus_01M346YX7FX9YV3A1M3GD76NH2")
  .select("name nominee kyc.status")
  .lean();
const schemes = await Scheme.find({ customerId: "cus_01M346YX7FX9YV3A1M3GD76NH2" })
  .select("enrollmentNumber status paymentPattern flexiblePhase valueBasis planId createdAt")
  .sort({ createdAt: -1 })
  .lean();
const ticket = await Grievance.findById("grv_01M33YWFC3FH1QKBNARGV0K540").select("status subject").lean();
const rate = await GoldRate.find({ effectiveDate: "2026-09-22", ratePerGramPaise: 1635000 })
  .select("branchId ratePerGramPaise")
  .lean();
const tenant = await Tenant.findOne({ code: "KAIRALI" })
  .select("branding.primaryColor operations.receiptPrefix")
  .lean();
const requests = await SubscriptionUpgradeRequest.find({})
  .select("status targetTier note")
  .sort({ createdAt: -1 })
  .limit(2)
  .lean();
console.log(JSON.stringify({ plans, customer, schemes, ticket, rate, tenant: { color: tenant?.branding?.primaryColor, prefix: tenant?.operations?.receiptPrefix }, requests }, null, 2));
await disconnectDatabase();
