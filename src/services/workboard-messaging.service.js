import { Customer, Message, Scheme } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { effectiveScope } from "../lib/query-filters.js";
import {
  installmentRemainingPaise,
  pickWorkboardInstallment,
} from "./admin-summary.service.js";
import { queueMessage } from "./messaging.service.js";
import * as payments from "./payment.service.js";

function istTodayYmd() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

async function queueWorkboardReminder(req, scheme, boardKind) {
  if (scheme.paymentPattern === "FLEXIBLE") {
    return {
      skipped: { schemeId: scheme._id, reason: "FLEXIBLE_SCHEME_EXCLUDED" },
    };
  }

  const customer = await Customer.findOne({
    _id: scheme.customerId,
    tenantId: req.auth.tenantId,
  })
    .select("mobile whatsappOptedOutAt name")
    .lean();
  if (!customer) {
    return { skipped: { schemeId: scheme._id, reason: "CUSTOMER_NOT_FOUND" } };
  }
  if (customer.whatsappOptedOutAt) {
    return { skipped: { schemeId: scheme._id, reason: "WHATSAPP_OPTED_OUT" } };
  }

  const today = istTodayYmd();
  const board = boardKind === "overdues" ? "overdues" : "dues";
  const inst = pickWorkboardInstallment(
    scheme.installments ?? [],
    board,
    {},
    {},
  );
  if (!inst) {
    return { skipped: { schemeId: scheme._id, reason: "NO_OPEN_INSTALLMENT" } };
  }

  const type =
    board === "overdues" || inst.status === "OVERDUE"
      ? "PAYMENT_OVERDUE"
      : "PAYMENT_DUE";
  if (boardKind === "overdues" && type !== "PAYMENT_OVERDUE") {
    return { skipped: { schemeId: scheme._id, reason: "NO_OPEN_INSTALLMENT" } };
  }

  const exists = await Message.exists({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    type,
    "templateParams.reminderDate": today,
  });
  if (exists) {
    return { skipped: { schemeId: scheme._id, reason: "ALREADY_SENT" } };
  }

  const remaining = installmentRemainingPaise(inst);
  const link = await payments.createPaymentLink({
    ...req,
    body: { schemeId: scheme._id, amountPaise: remaining },
  });

  await queueMessage(req, {
    branchId: scheme.branchId,
    customerId: scheme.customerId,
    schemeId: scheme._id,
    type,
    templateKey: type,
    templateParams: {
      mobile: customer.mobile,
      reminderDate: today,
      enrollmentNumber: scheme.enrollmentNumber,
      paymentLinkToken: link.token,
    },
  });

  return { queued: true };
}

async function bulkSend(req, boardKind, extraMeta = {}) {
  const schemeIds = [
    ...new Set((req.body.schemeIds ?? []).map(String).filter(Boolean)),
  ];
  const jobId = createId("job");
  const skipped = [];
  let queued = 0;
  const scope = effectiveScope(req);
  let quotaHit = false;

  for (const schemeId of schemeIds) {
    if (quotaHit) break;
    const scheme = await Scheme.findOne({ _id: schemeId, ...scope }).lean();
    if (!scheme) {
      skipped.push({ schemeId, reason: "NOT_FOUND" });
      continue;
    }
    try {
      const result = await queueWorkboardReminder(req, scheme, boardKind);
      if (result.skipped) skipped.push(result.skipped);
      else queued += 1;
    } catch (err) {
      if (err?.code === "QUOTA_EXCEEDED") {
        skipped.push({ schemeId, reason: "QUOTA_EXCEEDED" });
        quotaHit = true;
        continue;
      }
      skipped.push({
        schemeId,
        reason: err?.code ?? "FAILED",
      });
    }
  }

  return { jobId, queued, accepted: queued, skipped, ...extraMeta };
}

export async function bulkSendDueLinks(req) {
  return bulkSend(req, "dues");
}

export async function bulkSendOverdueReminders(req) {
  return bulkSend(req, "overdues", { flexibleSchemesExcluded: true });
}
