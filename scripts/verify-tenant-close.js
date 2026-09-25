import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import { CashHandover, Redemption, Scheme, SchemePlan } from "../src/models/index.js";

await connectDatabase();
const scheme = await Scheme.findById("sch_01M33YWB8JF07A166F02D6MVNV")
  .select("enrollmentNumber status closureReason")
  .lean();
const redemption = await Redemption.findOne({ schemeId: "sch_01M33YWB8JF07A166F02D6MVNV" })
  .sort({ createdAt: -1 })
  .select("status mode settlementPaise")
  .lean();
const plan = await SchemePlan.findById("spl_01M3499VN8DYM1YJ34DF1THPQH").select("displayName status").lean();
const pending = await CashHandover.find({ status: "PENDING" })
  .select("createdAt amountPaise branchId")
  .limit(5)
  .lean();
const approved = await Redemption.findById("red_01M33ZBVWBC9B2RNSZKM3V7HT3").select("status").lean();
console.log(JSON.stringify({ scheme, redemption, plan, pending, approved }, null, 2));
await disconnectDatabase();
