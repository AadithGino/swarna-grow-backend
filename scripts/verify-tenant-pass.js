import { connectDatabase, disconnectDatabase } from "../src/config/database.js";
import {
  Branch,
  Grievance,
  Payment,
  Scheme,
  Tenant,
  User,
} from "../src/models/index.js";

await connectDatabase();
const branch = await Branch.findById("brn_01M348XN6DJJCSWKT7HT7RXBG5").lean();
const staff = await User.findById("usr_01M346ZGHHV4RXJ8ZEER8HH44R").lean();
const payments = await Payment.find({ schemeId: "sch_01M346YZW09TD8F3E3JKVK9FEH" })
  .select("receiptNo amountPaise status mode createdAt")
  .sort({ createdAt: -1 })
  .lean();
const ticket = await Grievance.findOne({ subject: "Flow ticket 2765" }).lean();
const tenant = await Tenant.findOne({ code: "KAIRALI" }).select("name branding.displayName operations.receiptPrefix").lean();
const scheme = await Scheme.findById("sch_01M346YZW09TD8F3E3JKVK9FEH").select("status enrollmentNumber installments.status").lean();
console.log(JSON.stringify({
  branch: branch && { name: branch.name, code: branch.code, active: branch.active, address: branch.address, mobile: branch.mobile },
  staff: staff && { name: staff.name, status: staff.status },
  payments: payments.map((p) => ({ receipt: p.receiptNo, paise: p.amountPaise, status: p.status, mode: p.mode })),
  scheme: scheme && { no: scheme.enrollmentNumber, status: scheme.status, installments: (scheme.installments ?? []).map((i) => i.status) },
  ticket: ticket && { subject: ticket.subject, status: ticket.status },
  tenant: { name: tenant?.name, displayName: tenant?.branding?.displayName, receiptPrefix: tenant?.operations?.receiptPrefix },
}, null, 2));
await disconnectDatabase();
