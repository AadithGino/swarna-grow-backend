import { Router } from "express";
import * as scheme from "../controllers/scheme.controller.js";
import * as payment from "../controllers/payment.controller.js";
import * as operations from "../controllers/operations.controller.js";
import {
  AuditEntityType,
  ClosureType,
  SchemePlanStatus,
} from "../constants/enums.js";
import { Permission } from "../constants/permissions.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  Payment,
  PaymentIntent,
  Redemption,
  Scheme,
} from "../models/index.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { gatewaySettlementUploadBody } from "../validators/gateway-settlement.validators.js";
import {
  enrolBody,
  paymentBody,
  paymentLinkBody,
  planBody,
  planPatchBody,
  previewScheduleBody,
  redemptionBody,
  settlementPreviewQuery,
} from "../validators/common.validators.js";
import { guarded } from "../lib/route.js";
import { errors } from "../lib/app-error.js";
import * as audit from "../services/audit.service.js";

export const adminSchemeRouter = Router();
adminSchemeRouter.get(
  "/scheme-plans",
  ...guarded(Permission.PLAN_READ, asyncHandler(scheme.listPlans("admin"))),
);
adminSchemeRouter.post(
  "/scheme-plans",
  ...guarded(
    Permission.PLAN_WRITE,
    validate({ body: planBody }),
    idempotent,
    asyncHandler(scheme.createPlan),
  ),
);
adminSchemeRouter.post(
  "/scheme-plans/preview-schedule",
  ...guarded(
    Permission.PLAN_WRITE,
    validate({ body: previewScheduleBody }),
    asyncHandler(scheme.previewSchedule),
  ),
);
adminSchemeRouter.get(
  "/scheme-plans/:planId",
  ...guarded(Permission.PLAN_READ, asyncHandler(scheme.getPlan)),
);
adminSchemeRouter.patch(
  "/scheme-plans/:planId",
  ...guarded(
    Permission.PLAN_WRITE,
    validate({ body: planPatchBody }),
    idempotent,
    asyncHandler(scheme.updatePlan),
  ),
);
adminSchemeRouter.post(
  "/scheme-plans/:planId/activate",
  ...guarded(
    Permission.PLAN_WRITE,
    idempotent,
    asyncHandler(scheme.setPlanStatus(SchemePlanStatus.ACTIVE)),
  ),
);
adminSchemeRouter.post(
  "/scheme-plans/:planId/deactivate",
  ...guarded(
    Permission.PLAN_WRITE,
    idempotent,
    asyncHandler(scheme.setPlanStatus(SchemePlanStatus.INACTIVE)),
  ),
);
adminSchemeRouter.post(
  "/scheme-plans/:planId/duplicate",
  ...guarded(
    Permission.PLAN_WRITE,
    idempotent,
    asyncHandler(scheme.duplicatePlan),
  ),
);
adminSchemeRouter.get(
  "/scheme-plans/:planId/stats",
  ...guarded(Permission.PLAN_READ, asyncHandler(scheme.planStats)),
);
adminSchemeRouter.post(
  "/schemes/enrol/validate",
  ...guarded(
    Permission.SCHEME_WRITE,
    validate({ body: enrolBody }),
    asyncHandler(scheme.validateEnrolment),
  ),
);
adminSchemeRouter.post(
  "/schemes/enrol",
  ...guarded(
    Permission.SCHEME_WRITE,
    validate({ body: enrolBody }),
    idempotent,
    asyncHandler(scheme.enrol),
  ),
);
adminSchemeRouter.get(
  "/schemes",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.listSchemes)),
);
adminSchemeRouter.get(
  "/schemes/analytics",
  ...guarded(Permission.REPORT_READ, asyncHandler(scheme.schemeAnalytics)),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/payable-range",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.payableRange)),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/ledger",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.ledger)),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/passbook",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.passbook)),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/maturity-projection",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.maturityProjection)),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/settlement-preview",
  ...guarded(
    Permission.REDEMPTION_READ,
    validate({ query: settlementPreviewQuery }),
    asyncHandler(async (req, res) => {
      const closureType =
        req.query.type === ClosureType.PREMATURE_CLOSURE
          ? ClosureType.PREMATURE_CLOSURE
          : ClosureType.MATURITY_REDEMPTION;
      return operations.settlementPreview(closureType)(req, res);
    }),
  ),
);
adminSchemeRouter.get(
  "/schemes/:schemeId",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.getScheme)),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/audit-events",
  ...guarded(
    Permission.AUDIT_READ,
    asyncHandler(async (req, res) => {
      const row = await Scheme.findOne({
        _id: req.params.schemeId,
        ...req.scope,
      }).lean();
      if (!row) throw errors.notFound("Scheme");
      return sendList(res, await audit.listEntityAudit(req, "SCHEME", row._id));
    }),
  ),
);
adminSchemeRouter.get(
  "/schemes/:schemeId/payment-intents",
  ...guarded(
    Permission.PAYMENT_READ,
    asyncHandler(async (req, res) => {
      const row = await Scheme.findOne({
        _id: req.params.schemeId,
        ...req.scope,
      }).lean();
      if (!row) throw errors.notFound("Scheme");
      return sendSuccess(
        res,
        await PaymentIntent.find({
          tenantId: req.auth.tenantId,
          schemeId: row._id,
        })
          .sort({ createdAt: -1 })
          .lean(),
      );
    }),
  ),
);
adminSchemeRouter.post(
  "/schemes/:schemeId/redeem",
  ...guarded(
    Permission.REDEMPTION_WRITE,
    validate({ body: redemptionBody }),
    idempotent,
    asyncHandler(
      operations.initiateRedemption(ClosureType.MATURITY_REDEMPTION),
    ),
  ),
);
adminSchemeRouter.post(
  "/schemes/:schemeId/close-premature",
  ...guarded(
    Permission.REDEMPTION_WRITE,
    validate({ body: redemptionBody }),
    idempotent,
    asyncHandler(operations.initiateRedemption(ClosureType.PREMATURE_CLOSURE)),
  ),
);
adminSchemeRouter.post(
  "/schemes/:schemeId/recompute",
  ...guarded(
    Permission.SCHEME_WRITE,
    idempotent,
    asyncHandler(scheme.recompute),
  ),
);
adminSchemeRouter.post(
  "/flexible-locks/:schemeId/apply",
  ...guarded(
    Permission.SCHEME_WRITE,
    idempotent,
    asyncHandler(scheme.applyLock),
  ),
);
adminSchemeRouter.post(
  "/payments",
  ...guarded(
    Permission.PAYMENT_RECORD,
    validate({ body: paymentBody }),
    idempotent,
    asyncHandler(payment.record),
  ),
);
adminSchemeRouter.get(
  "/payments",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.list)),
);
adminSchemeRouter.get(
  "/payments/pending",
  ...guarded(
    Permission.PAYMENT_READ,
    asyncHandler(async (req, res) => {
      req.query.status = "PENDING";
      return payment.list(req, res);
    }),
  ),
);
adminSchemeRouter.get(
  "/payments/late-success",
  ...guarded(
    Permission.PAYMENT_READ,
    asyncHandler(async (req, res) =>
      sendSuccess(
        res,
        await Payment.find({ ...req.scope, isLateSuccess: true })
          .sort({ paidAt: -1 })
          .lean(),
      ),
    ),
  ),
);
adminSchemeRouter.get(
  "/payments/:paymentId",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.detail)),
);
adminSchemeRouter.get(
  "/payments/:paymentId/audit-events",
  ...guarded(
    Permission.AUDIT_READ,
    asyncHandler(async (req, res) => {
      const row = await Payment.findOne({
        _id: req.params.paymentId,
        ...req.scope,
      }).lean();
      if (!row) throw errors.notFound("Payment");
      return sendList(
        res,
        await audit.listEntityAudit(req, "PAYMENT", row._id),
      );
    }),
  ),
);
adminSchemeRouter.get(
  "/payments/:paymentId/receipt",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.receipt)),
);
adminSchemeRouter.get(
  "/payments/:paymentId/passbook-image",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.passbookImage)),
);
adminSchemeRouter.post(
  "/payments/:paymentId/passbook-image/regenerate",
  ...guarded(
    Permission.PAYMENT_READ,
    idempotent,
    asyncHandler(payment.passbookImage),
  ),
);
adminSchemeRouter.post(
  "/payments/:paymentId/share-whatsapp",
  ...guarded(Permission.MESSAGE_SEND, idempotent, asyncHandler(payment.share)),
);
adminSchemeRouter.post(
  "/payments/:paymentId/reverse",
  ...guarded(
    Permission.PAYMENT_REVERSE,
    idempotent,
    asyncHandler(payment.reverse),
  ),
);
adminSchemeRouter.post(
  "/payments/:paymentId/refunds",
  ...guarded(
    Permission.PAYMENT_REVERSE,
    idempotent,
    asyncHandler(async (req, res) => {
      const { initiateAdminPaymentRefund } = await import("../services/payment-refund-initiation.service.js");
      const { sendSuccess } = await import("../lib/response.js");
      return sendSuccess(res, await initiateAdminPaymentRefund(req), {}, 202);
    }),
  ),
);
adminSchemeRouter.get(
  "/payments/:paymentId/refunds",
  ...guarded(
    Permission.PAYMENT_READ,
    asyncHandler(async (req, res) => {
      const { listPaymentRefunds } = await import("../services/payment-refund-initiation.service.js");
      const { sendSuccess } = await import("../lib/response.js");
      return sendSuccess(res, await listPaymentRefunds(req));
    }),
  ),
);
adminSchemeRouter.get(
  "/gateway/settlement-runs",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(async (req, res) => {
    const { listSettlementRuns } = await import("../services/gateway-settlement.service.js");
    const { sendSuccess } = await import("../lib/response.js");
    return sendSuccess(res, await listSettlementRuns(req));
  })),
);
adminSchemeRouter.get(
  "/gateway/settlement-runs/:runId",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(async (req, res) => {
    const { getSettlementRun } = await import("../services/gateway-settlement.service.js");
    const { sendSuccess } = await import("../lib/response.js");
    return sendSuccess(res, await getSettlementRun(req));
  })),
);
adminSchemeRouter.post(
  "/gateway/settlement-runs/upload",
  ...guarded(
    Permission.PAYMENT_REVERSE,
    validate({ body: gatewaySettlementUploadBody }),
    idempotent,
    asyncHandler(async (req, res) => {
    const { uploadGatewaySettlementStatement } = await import("../services/gateway-settlement.service.js");
    const { sendSuccess } = await import("../lib/response.js");
    return sendSuccess(res, await uploadGatewaySettlementStatement(req), {}, 201);
  })),
);
adminSchemeRouter.post(
  "/gateway/settlement-runs/:runId/retry",
  ...guarded(Permission.PAYMENT_REVERSE, idempotent, asyncHandler(async (req, res) => {
    const { getSettlementRun, runDailyGatewaySettlementForTenant } = await import("../services/gateway-settlement.service.js");
    const { sendSuccess } = await import("../lib/response.js");
    const run = await getSettlementRun(req);
    return sendSuccess(res, await runDailyGatewaySettlementForTenant({
      tenantId: req.auth.tenantId,
      businessDate: run.businessDate,
      leaseOwner: req.auth.id,
    }));
  })),
);
adminSchemeRouter.post(
  "/payment-links",
  ...guarded(
    Permission.PAYMENT_RECORD,
    validate({ body: paymentLinkBody }),
    idempotent,
    asyncHandler(payment.createLink),
  ),
);
adminSchemeRouter.get(
  "/payment-links",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.listLinks)),
);
adminSchemeRouter.post(
  "/payment-links/:linkId/cancel",
  ...guarded(
    Permission.PAYMENT_RECORD,
    idempotent,
    asyncHandler(payment.cancelLink),
  ),
);
adminSchemeRouter.post(
  "/payment-links/:linkId/resend",
  ...guarded(
    Permission.MESSAGE_SEND,
    idempotent,
    asyncHandler(payment.resendLink),
  ),
);
adminSchemeRouter.get(
  "/redemptions",
  ...guarded(Permission.REDEMPTION_READ, asyncHandler(operations.redemptions)),
);
adminSchemeRouter.get(
  "/redemptions/:redemptionId",
  ...guarded(
    Permission.REDEMPTION_READ,
    asyncHandler(operations.redemptionDetail),
  ),
);
adminSchemeRouter.get(
  "/redemptions/:redemptionId/receipt",
  ...guarded(
    Permission.REDEMPTION_READ,
    asyncHandler(operations.redemptionReceipt),
  ),
);
adminSchemeRouter.get(
  "/redemptions/:redemptionId/audit-events",
  ...guarded(
    Permission.AUDIT_READ,
    asyncHandler(async (req, res) => {
      const row = await Redemption.findOne({
        _id: req.params.redemptionId,
        ...req.scope,
      }).lean();
      if (!row) throw errors.notFound("Redemption");
      return sendList(
        res,
        await audit.listEntityAudit(
          req,
          AuditEntityType.REDEMPTION,
          row._id,
        ),
      );
    }),
  ),
);
adminSchemeRouter.post(
  "/redemptions/:redemptionId/approve",
  ...guarded(
    Permission.REDEMPTION_APPROVE,
    idempotent,
    asyncHandler(operations.transitionRedemption("approve")),
  ),
);
adminSchemeRouter.post(
  "/redemptions/:redemptionId/reject",
  ...guarded(
    Permission.REDEMPTION_APPROVE,
    idempotent,
    asyncHandler(operations.transitionRedemption("reject")),
  ),
);
adminSchemeRouter.post(
  "/redemptions/:redemptionId/complete",
  ...guarded(
    Permission.REDEMPTION_APPROVE,
    idempotent,
    asyncHandler(operations.transitionRedemption("complete")),
  ),
);
