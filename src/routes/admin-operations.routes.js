import { Router } from "express";
import * as controller from "../controllers/operations.controller.js";
import { HandoverInitiator } from "../constants/enums.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { handoverBody, messageBody, uploadBody } from "../validators/common.validators.js";
import {
  cashAdjustmentBody,
  grievanceAssignBody,
  grievancePriorityBody,
  grievanceStatusBody,
  handoverAcceptBody,
  handoverRejectBody,
  handoverResolveDiscrepancyBody,
  paymentReconcileBody,
  postSettlementRefundResolveBody,
  pushBroadcastAudiencePreviewBody,
  pushBroadcastBody,
  uploadCompleteBody,
} from "../validators/admin-mutation.validators.js";
import { presignUpload } from "../services/upload.service.js";
import * as upload from "../controllers/upload.controller.js";
import { CashHandover } from "../models/index.js";
import { Permission } from "../constants/permissions.js";
import { guarded } from "../lib/route.js";
import { AppError, errors } from "../lib/app-error.js";
import * as audit from "../services/audit.service.js";

export const adminOperationsRouter = Router();
adminOperationsRouter.get("/cash/overview", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashOverview)));
adminOperationsRouter.get("/cash/staff-balances", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashStaffBalances)));
adminOperationsRouter.get("/cash/staff-balances/:staffId", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashStaffBalanceDetail)));
adminOperationsRouter.post("/cash/handovers", ...guarded(Permission.CASH_HANDOVER_ACCEPT, validate({ body: handoverBody }), idempotent, asyncHandler(controller.createHandover(HandoverInitiator.ADMIN))));
adminOperationsRouter.get("/cash/handovers", ...guarded(Permission.CASH_READ, asyncHandler(controller.handovers(false))));
adminOperationsRouter.get("/cash/handovers/:handoverId", ...guarded(Permission.CASH_READ, asyncHandler(controller.getHandover)));
adminOperationsRouter.post(
  "/cash/handovers/:handoverId/accept",
  ...guarded(
    Permission.CASH_HANDOVER_ACCEPT,
    validate({ body: handoverAcceptBody }),
    idempotent,
    asyncHandler(controller.settleHandover("accept")),
  ),
);
adminOperationsRouter.post(
  "/cash/handovers/:handoverId/reject",
  ...guarded(
    Permission.CASH_HANDOVER_ACCEPT,
    validate({ body: handoverRejectBody }),
    idempotent,
    asyncHandler(controller.settleHandover("reject")),
  ),
);
adminOperationsRouter.post(
  "/cash/handovers/:handoverId/resolve-discrepancy",
  ...guarded(
    Permission.CASH_HANDOVER_ACCEPT,
    validate({ body: handoverResolveDiscrepancyBody }),
    idempotent,
    asyncHandler(controller.settleHandover("resolve-discrepancy")),
  ),
);
adminOperationsRouter.get("/cash/report", ...guarded(Permission.CASH_READ, asyncHandler(controller.cashReport)));
adminOperationsRouter.get("/cash/handovers/:handoverId/audit-events", ...guarded(Permission.AUDIT_READ, asyncHandler(async (req, res) => {
  const handover = await CashHandover.findOne({ _id: req.params.handoverId, ...req.scope }).lean();
  if (!handover) throw errors.notFound("Cash handover");
  return sendList(res, await audit.listEntityAudit(req, "CASH_HANDOVER", handover._id));
})));
adminOperationsRouter.post(
  "/cash/adjustments",
  ...guarded(
    Permission.CASH_HANDOVER_ACCEPT,
    validate({ body: cashAdjustmentBody }),
    idempotent,
    asyncHandler(controller.cashAdjustment),
  ),
);
adminOperationsRouter.post(
  "/push/broadcasts/audience-preview",
  ...guarded(
    Permission.MESSAGE_READ,
    validate({ body: pushBroadcastAudiencePreviewBody }),
    asyncHandler(controller.pushBroadcastAudiencePreview),
  ),
);
adminOperationsRouter.post(
  "/push/broadcasts",
  ...guarded(
    Permission.MESSAGE_SEND,
    validate({ body: pushBroadcastBody }),
    idempotent,
    asyncHandler(controller.createPushBroadcast),
  ),
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
  ...guarded(
    Permission.MESSAGE_SEND,
    validate({ body: uploadCompleteBody }),
    idempotent,
    asyncHandler(upload.complete),
  ),
);
adminOperationsRouter.get("/grievances", ...guarded(Permission.GRIEVANCE_READ, asyncHandler(controller.grievances)));
adminOperationsRouter.get("/grievances/:grievanceId/audit-events", ...guarded(Permission.AUDIT_READ, asyncHandler(controller.grievanceAudit)));
adminOperationsRouter.get("/grievances/:grievanceId", ...guarded(Permission.GRIEVANCE_READ, asyncHandler(controller.grievanceDetail)));
adminOperationsRouter.post(
  "/grievances/:grievanceId/assign",
  ...guarded(
    Permission.GRIEVANCE_ASSIGN,
    validate({ body: grievanceAssignBody }),
    idempotent,
    asyncHandler(controller.mutateGrievance("assign")),
  ),
);
adminOperationsRouter.post(
  "/grievances/:grievanceId/priority",
  ...guarded(
    Permission.GRIEVANCE_ASSIGN,
    validate({ body: grievancePriorityBody }),
    idempotent,
    asyncHandler(controller.mutateGrievance("priority")),
  ),
);
adminOperationsRouter.post("/grievances/:grievanceId/messages", ...guarded(Permission.GRIEVANCE_REPLY, validate({ body: messageBody }), idempotent, asyncHandler(controller.grievanceMessage)));
adminOperationsRouter.post(
  "/grievances/:grievanceId/status",
  ...guarded(
    Permission.GRIEVANCE_RESOLVE,
    validate({ body: grievanceStatusBody }),
    idempotent,
    asyncHandler(controller.mutateGrievance("status")),
  ),
);
adminOperationsRouter.post("/payments/:paymentId/poll-status", ...guarded(Permission.PAYMENT_READ, idempotent, asyncHandler(async (req, res) => {
  const { pollPaymentGatewayStatus } = await import("../services/payment-poll-status.service.js");
  return sendSuccess(res, await pollPaymentGatewayStatus(req));
})));
adminOperationsRouter.get(
  "/post-settlement-refund-cases",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(controller.postSettlementRefundCases)),
);
adminOperationsRouter.get(
  "/post-settlement-refund-cases/:caseId",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(controller.postSettlementRefundCaseDetail)),
);
adminOperationsRouter.post(
  "/post-settlement-refund-cases/:caseId/resolve",
  ...guarded(
    Permission.PAYMENT_REVERSE,
    validate({ body: postSettlementRefundResolveBody }),
    idempotent,
    asyncHandler(controller.resolvePostSettlementRefundCase),
  ),
);
adminOperationsRouter.post(
  "/payments/:paymentId/reconcile",
  ...guarded(
    Permission.PAYMENT_REVERSE,
    validate({ body: paymentReconcileBody }),
    idempotent,
    asyncHandler(async (req, res) => {
  const { reconcilePaymentById } = await import("../services/phonepe-reconcile.service.js");
  const forceReplay = req.body?.forceReplay === true;
  const result = await reconcilePaymentById({
    tenantId: req.auth.tenantId,
    paymentId: req.params.paymentId,
    forceReplay,
  });
  sendSuccess(res, result);
})),
);
