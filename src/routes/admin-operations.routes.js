import { Router } from "express";
import * as controller from "../controllers/operations.controller.js";
import { HandoverInitiator } from "../constants/enums.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { handoverBody, messageBody, uploadBody } from "../validators/common.validators.js";
import { presignUpload } from "../services/upload.service.js";
import * as upload from "../controllers/upload.controller.js";
import { CashHandover, Customer, Message, WebhookEvent } from "../models/index.js";
import { Permission } from "../constants/permissions.js";
import { guarded } from "../lib/route.js";
import { AppError, errors } from "../lib/app-error.js";
import { getQueue } from "../queues/index.js";
import * as audit from "../services/audit.service.js";
import * as messaging from "../services/messaging.service.js";

export const adminOperationsRouter = Router();
adminOperationsRouter.get("/cash/overview", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashOverview)));
adminOperationsRouter.get("/cash/staff-balances", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashStaffBalances)));
adminOperationsRouter.get("/cash/staff-balances/:staffId", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashStaffBalanceDetail)));
adminOperationsRouter.post("/cash/handovers", ...guarded(Permission.CASH_HANDOVER_ACCEPT, validate({ body: handoverBody }), idempotent, asyncHandler(controller.createHandover(HandoverInitiator.ADMIN))));
adminOperationsRouter.get("/cash/handovers", ...guarded(Permission.CASH_READ, asyncHandler(controller.handovers(false))));
adminOperationsRouter.get("/cash/handovers/:handoverId", ...guarded(Permission.CASH_READ, asyncHandler(async (req, res) => {
  const row = await CashHandover.findOne({ _id: req.params.handoverId, ...req.scope }).lean();
  if (!row) throw errors.notFound("Cash handover");
  return sendSuccess(res, row);
})));
adminOperationsRouter.post("/cash/handovers/:handoverId/accept", ...guarded(Permission.CASH_HANDOVER_ACCEPT, idempotent, asyncHandler(controller.settleHandover("accept"))));
adminOperationsRouter.post("/cash/handovers/:handoverId/reject", ...guarded(Permission.CASH_HANDOVER_ACCEPT, idempotent, asyncHandler(controller.settleHandover("reject"))));
adminOperationsRouter.post("/cash/handovers/:handoverId/resolve-discrepancy", ...guarded(Permission.CASH_HANDOVER_ACCEPT, idempotent, asyncHandler(controller.settleHandover("resolve-discrepancy"))));
adminOperationsRouter.get("/cash/report", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashReport)));
adminOperationsRouter.get("/cash/handovers/:handoverId/audit-events", ...guarded(Permission.AUDIT_READ, asyncHandler(async (req, res) => {
  const handover = await CashHandover.findOne({ _id: req.params.handoverId, ...req.scope }).lean();
  if (!handover) throw errors.notFound("Cash handover");
  return sendList(res, await audit.listEntityAudit(req, "CASH_HANDOVER", handover._id));
})));
adminOperationsRouter.post("/cash/adjustments", ...guarded(Permission.CASH_HANDOVER_ACCEPT, idempotent, asyncHandler(controller.cashAdjustment)));
adminOperationsRouter.get("/messaging/templates", ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.templates)));
adminOperationsRouter.get("/messaging/templates/:messageType/preview", ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.templatePreview)));
adminOperationsRouter.get("/messaging/summary", ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.messageSummary)));
adminOperationsRouter.get("/messaging/messages", ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.messages)));
adminOperationsRouter.get("/messaging/messages/:messageId", ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.messageDetail)));
adminOperationsRouter.post("/messaging/messages/:messageId/resend", ...guarded(Permission.MESSAGE_SEND, idempotent, asyncHandler(controller.resendMessage)));
adminOperationsRouter.post(
  "/messaging/messages/bulk-resend",
  ...guarded(
    Permission.MESSAGE_SEND,
    idempotent,
    asyncHandler(async (req, res) =>
      sendSuccess(res, await messaging.bulkResendMessages(req), {}, 202),
    ),
  ),
);
adminOperationsRouter.get("/messaging/opt-outs", ...guarded(Permission.MESSAGE_READ, asyncHandler(async (req, res) => sendSuccess(res, await Customer.find({ ...req.scope, whatsappOptedOutAt: { $ne: null } }).select("_id customerNumber name mobile whatsappOptedOutAt").lean()))));
adminOperationsRouter.get("/messaging/quota", ...guarded(Permission.MESSAGE_READ, asyncHandler(async (req, res) => sendSuccess(res, { used: await Message.countDocuments(req.scope), limit: req.tenant.subscription?.limits?.whatsappMessages ?? null }))));
adminOperationsRouter.get("/messaging/dead-letter", ...guarded(Permission.MESSAGE_READ, asyncHandler(async (req, res) => sendSuccess(res, await WebhookEvent.find({ ...req.scope, status: "DEAD_LETTER" }).lean()))));
adminOperationsRouter.post("/messaging/dead-letter/:id/requeue", ...guarded(Permission.MESSAGE_SEND, idempotent, asyncHandler(async (req, res) => {
  const { replayWebhookEvent } = await import("../services/webhook-event.service.js");
  const replayed = await replayWebhookEvent({
    tenantId: req.auth.tenantId,
    webhookEventId: req.params.id,
  });
  if (!replayed) throw errors.notFound("Webhook event");
  await getQueue("webhooks")?.add(
    replayed.provider.toLowerCase(),
    { webhookEventId: replayed._id },
    {
      jobId: `${replayed._id}-requeue-${Date.now()}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 5000 },
    },
  );
  sendSuccess(res, { id: replayed._id, queued: true }, {}, 202);
})));
adminOperationsRouter.get("/messaging/inbound", ...guarded(Permission.MESSAGE_READ, asyncHandler(async (req, res) => {
  const { listInboundMessages } = await import("../services/inbound-message.service.js");
  const page = await listInboundMessages(req);
  return sendList(res, page.data, page.meta);
})));
adminOperationsRouter.get("/messaging/inbound/:id", ...guarded(Permission.MESSAGE_READ, asyncHandler(async (req, res) => {
  const { getInboundMessage } = await import("../services/inbound-message.service.js");
  return sendSuccess(res, await getInboundMessage(req));
})));
adminOperationsRouter.post("/messaging/inbound/:id/read", ...guarded(Permission.MESSAGE_READ, idempotent, asyncHandler(async (req, res) => {
  const { markInboundMessageRead } = await import("../services/inbound-message.service.js");
  return sendSuccess(res, await markInboundMessageRead(req));
})));
adminOperationsRouter.get("/reminders/config", ...guarded(Permission.SETTINGS_READ, asyncHandler(controller.reminderConfig)));
adminOperationsRouter.put("/reminders/config", ...guarded(Permission.SETTINGS_WRITE, idempotent, asyncHandler(controller.updateReminderConfig)));
adminOperationsRouter.post(
  "/push/broadcasts/audience-preview",
  ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.pushBroadcastAudiencePreview)),
);
adminOperationsRouter.post(
  "/push/broadcasts",
  ...guarded(Permission.MESSAGE_SEND, idempotent, asyncHandler(controller.createPushBroadcast)),
);
adminOperationsRouter.get(
  "/push/broadcasts",
  ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.listPushBroadcasts)),
);
adminOperationsRouter.get(
  "/push/broadcasts/:broadcastId",
  ...guarded(Permission.MESSAGE_READ, asyncHandler(controller.pushBroadcastDetail)),
);
adminOperationsRouter.post(
  "/push/uploads/presign",
  ...guarded(
    Permission.MESSAGE_SEND,
    validate({ body: uploadBody }),
    idempotent,
    asyncHandler(async (req, res) => {
      if (req.body.purpose !== "PUSH_BROADCAST_IMAGE") {
        throw new AppError(
          "UPLOAD_PURPOSE_MISMATCH",
          "Only PUSH_BROADCAST_IMAGE uploads are allowed here.",
          422,
        );
      }
      return sendSuccess(res, await presignUpload(req), {}, 201);
    }),
  ),
);
adminOperationsRouter.post(
  "/push/uploads/:uploadId/complete",
  ...guarded(Permission.MESSAGE_SEND, idempotent, asyncHandler(upload.complete)),
);
adminOperationsRouter.get("/grievances", ...guarded(Permission.GRIEVANCE_READ, asyncHandler(controller.grievances)));
adminOperationsRouter.get("/grievances/:grievanceId/audit-events", ...guarded(Permission.AUDIT_READ, asyncHandler(controller.grievanceAudit)));
adminOperationsRouter.get("/grievances/:grievanceId", ...guarded(Permission.GRIEVANCE_READ, asyncHandler(controller.grievanceDetail)));
adminOperationsRouter.post("/grievances/:grievanceId/assign", ...guarded(Permission.GRIEVANCE_ASSIGN, idempotent, asyncHandler(controller.mutateGrievance("assign"))));
adminOperationsRouter.post("/grievances/:grievanceId/priority", ...guarded(Permission.GRIEVANCE_ASSIGN, idempotent, asyncHandler(controller.mutateGrievance("priority"))));
adminOperationsRouter.post("/grievances/:grievanceId/messages", ...guarded(Permission.GRIEVANCE_REPLY, validate({ body: messageBody }), idempotent, asyncHandler(controller.grievanceMessage)));
adminOperationsRouter.post("/grievances/:grievanceId/status", ...guarded(Permission.GRIEVANCE_RESOLVE, idempotent, asyncHandler(controller.mutateGrievance("status"))));
adminOperationsRouter.post("/payments/:paymentId/poll-status", ...guarded(Permission.PAYMENT_READ, idempotent, asyncHandler(async (req, res) => {
  const { pollPaymentGatewayStatus } = await import("../services/payment-poll-status.service.js");
  return sendSuccess(res, await pollPaymentGatewayStatus(req));
})));
adminOperationsRouter.post("/payments/:paymentId/reconcile", ...guarded(Permission.PAYMENT_REVERSE, idempotent, asyncHandler(async (req, res) => {
  const { reconcilePaymentById } = await import("../services/phonepe-reconcile.service.js");
  const forceReplay = req.body?.forceReplay === true || req.body?.forceReplay === "true";
  const result = await reconcilePaymentById({
    tenantId: req.auth.tenantId,
    paymentId: req.params.paymentId,
    forceReplay,
  });
  sendSuccess(res, result);
})));
