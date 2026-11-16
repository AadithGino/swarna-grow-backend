import { buildOneTimeGoldSchedule } from "./one-time-gold-schedule.js";
import { addMonthsClamped } from "./date.js";
import { calendarDayYmd } from "./reminder-timezone.js";
import { SchemeStatus } from "../constants/enums.js";
import { OutboxEvent } from "../models/index.js";

export function schemeStatusesBlockingActivation() {
  return [SchemeStatus.PENDING_PAYMENT];
}

export async function activateSchemeAfterAllocatedFirstPayment({
  scheme,
  payment,
  session,
  req,
}) {
  if (scheme.status !== SchemeStatus.PENDING_PAYMENT) return { activated: false };
  if (!payment || payment.status !== "SUCCESS" || !(payment.allocatedAmountPaise > 0)) {
    return { activated: false };
  }
  if (scheme.collectionFrequency && scheme.planSnapshot?.collectionRules?.maturityRule === "FIRST_PAYMENT_ANNIVERSARY") {
    const startDate = calendarDayYmd(new Date(payment.paidAt));
    if (startDate > scheme.startDate) {
      // The customer approved the original dates and amounts. Move the lock-in
      // anniversary only, so a gateway success can always fund the original row.
      scheme.startDate = startDate;
      scheme.maturityDate = addMonthsClamped(startDate, scheme.planSnapshot.durationMonths).format("YYYY-MM-DD");
    }
  }
  if (scheme.planSnapshot?.oneTimeRules) {
    const fundedOn = calendarDayYmd(new Date(payment.paidAt));
    const periods = buildOneTimeGoldSchedule(scheme.planSnapshot, fundedOn);
    scheme.startDate = fundedOn;
    scheme.maturityDate = periods.at(-1).dueDate;
    scheme.oneTimeGold = {
      fundedOn, periods, paymentId: payment._id, fundingRatePerGramPaise: payment.ratePerGramPaise, principalWeightMg: payment.weightMg, originalPaidPaise: payment.allocatedAmountPaise,
      nextCreditDate: periods[0].dueDate,
    };
  }
  scheme.status = SchemeStatus.ACTIVE;
  scheme.version += 1;
  await scheme.save({ session });
  await OutboxEvent.create(
    [
      {
        tenantId: scheme.tenantId,
        topic: "scheme.joined",
        key: scheme._id,
        payload: {
          schemeId: scheme._id,
          customerId: scheme.customerId,
          branchId: scheme.branchId,
          paymentId: payment._id,
        },
      },
    ],
    { session },
  );
  if (req) {
    const { writeAudit } = await import("../services/audit.service.js");
    const { AuditEntityType } = await import("../constants/enums.js");
    await writeAudit({
      req,
      action: "SCHEME_ACTIVATED",
      entityType: AuditEntityType.SCHEME,
      entityId: scheme._id,
      after: scheme.toObject(),
      metadata: { paymentId: payment._id, reason: "FIRST_PAYMENT_ALLOCATED" },
      session,
    });
  }
  return { activated: true };
}
