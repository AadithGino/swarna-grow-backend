import { Router } from "express";
import * as customer from "../controllers/customer.controller.js";
import * as scheme from "../controllers/scheme.controller.js";
import * as payment from "../controllers/payment.controller.js";
import * as operations from "../controllers/operations.controller.js";
import * as analytics from "../controllers/analytics.controller.js";
import { HandoverInitiator, MessageType } from "../constants/enums.js";
import { Permission } from "../constants/permissions.js";
import { Message, User } from "../models/index.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { asyncHandler } from "../lib/async-handler.js";
import { guarded } from "../lib/route.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  customerBody,
  customerSetPasswordBody,
  enrolBody,
  fcmDeleteBody,
  fcmTokenBody,
  handoverBody,
  messageBody,
  nomineeBody,
  paymentBody,
  paymentLinkBody,
} from "../validators/common.validators.js";
import { sha256 } from "../lib/crypto.js";
import * as audit from "../services/audit.service.js";

/** Staff-facing operational reminders — not customer WhatsApp receipts or branch-wide message feed. */
const STAFF_NOTIFICATION_TYPES = [
  MessageType.PAYMENT_DUE,
  MessageType.PAYMENT_OVERDUE,
];

export const staffRouter = Router();
staffRouter.get("/home", asyncHandler(analytics.staffHome));
staffRouter.get("/dashboard/summary", asyncHandler(analytics.staffHome));
staffRouter.get("/customers", ...guarded(Permission.CUSTOMER_READ, asyncHandler(customer.list)));
staffRouter.get("/customers/check-mobile", ...guarded(Permission.CUSTOMER_READ, asyncHandler(customer.checkMobile)));
staffRouter.post(
  "/customers",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: customerBody }),
    idempotent,
    asyncHandler(customer.create),
  ),
);
staffRouter.get("/customers/:customerId", ...guarded(Permission.CUSTOMER_READ, asyncHandler(customer.detail)));
staffRouter.patch(
  "/customers/:customerId",
  ...guarded(Permission.CUSTOMER_WRITE, idempotent, asyncHandler(customer.update)),
);
staffRouter.post(
  "/customers/:customerId/set-password",
  ...guarded(
    Permission.CUSTOMER_PASSWORD_WRITE,
    validate({ body: customerSetPasswordBody }),
    idempotent,
    asyncHandler(customer.setPassword),
  ),
);
staffRouter.put(
  "/customers/:customerId/kyc",
  ...guarded(Permission.CUSTOMER_KYC, idempotent, asyncHandler(customer.kyc(false))),
);
staffRouter.get(
  "/customers/:customerId/nominee",
  ...guarded(Permission.CUSTOMER_READ, asyncHandler(customer.nomineeDetail)),
);
staffRouter.put(
  "/customers/:customerId/nominee",
  ...guarded(
    Permission.CUSTOMER_WRITE,
    validate({ body: nomineeBody }),
    idempotent,
    asyncHandler(customer.nominee(false)),
  ),
);
staffRouter.delete(
  "/customers/:customerId/nominee",
  ...guarded(Permission.CUSTOMER_WRITE, idempotent, asyncHandler(customer.nominee(true))),
);
staffRouter.get(
  "/customers/:customerId/audit-events",
  ...guarded(
    Permission.AUDIT_READ,
    asyncHandler(async (req, res) =>
      sendList(res, await audit.listCustomerAudit(req, req.params.customerId)),
    ),
  ),
);
staffRouter.get("/scheme-plans", ...guarded(Permission.PLAN_READ, asyncHandler(scheme.listPlans("staff"))));
staffRouter.post(
  "/schemes/enrol/validate",
  ...guarded(Permission.SCHEME_WRITE, validate({ body: enrolBody }), asyncHandler(scheme.validateEnrolment)),
);
staffRouter.post(
  "/schemes/enrol",
  ...guarded(
    Permission.SCHEME_WRITE,
    validate({ body: enrolBody }),
    idempotent,
    asyncHandler(scheme.enrol),
  ),
);
staffRouter.get(
  "/schemes/:schemeId/payable-range",
  ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.payableRange)),
);
staffRouter.get("/schemes/:schemeId/passbook", ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.passbook)));
staffRouter.get("/schemes/:schemeId", ...guarded(Permission.SCHEME_READ, asyncHandler(scheme.getScheme)));
staffRouter.post(
  "/payments",
  ...guarded(
    Permission.PAYMENT_RECORD,
    validate({ body: paymentBody }),
    idempotent,
    asyncHandler(payment.record),
  ),
);
staffRouter.get("/payments", ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.list)));
staffRouter.get("/payments/:paymentId", ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.get)));
staffRouter.get("/payments/:paymentId/receipt", ...guarded(Permission.PAYMENT_READ, asyncHandler(payment.receipt)));
staffRouter.post(
  "/payment-links",
  ...guarded(
    Permission.PAYMENT_RECORD,
    validate({ body: paymentLinkBody }),
    idempotent,
    asyncHandler(payment.createLink),
  ),
);
staffRouter.post(
  "/payments/:paymentId/share-whatsapp",
  ...guarded(Permission.PAYMENT_RECORD, idempotent, asyncHandler(payment.share)),
);
staffRouter.get(
  "/collections/summary",
  ...guarded(Permission.PAYMENT_READ, asyncHandler(analytics.collectionSummary)),
);
staffRouter.get("/cash/summary", ...guarded(Permission.CASH_READ, asyncHandler(operations.cashSummary)));
staffRouter.get("/cash/collections", ...guarded(Permission.CASH_READ, asyncHandler(payment.list)));
staffRouter.post(
  "/cash/handovers",
  ...guarded(
    Permission.CASH_HANDOVER,
    validate({ body: handoverBody }),
    idempotent,
    asyncHandler(operations.createHandover(HandoverInitiator.STAFF)),
  ),
);
staffRouter.get("/cash/handovers", ...guarded(Permission.CASH_READ, asyncHandler(operations.handovers(true))));
staffRouter.post(
  "/cash/handovers/:handoverId/cancel",
  ...guarded(Permission.CASH_HANDOVER, idempotent, asyncHandler(operations.cancelHandover)),
);
staffRouter.get("/cash/handovers/:handoverId", ...guarded(Permission.CASH_READ, asyncHandler(operations.getHandoverStaff)));
staffRouter.get("/dues", ...guarded(Permission.REPORT_READ, asyncHandler(analytics.dueList("dues"))));
staffRouter.get("/overdues", ...guarded(Permission.REPORT_READ, asyncHandler(analytics.dueList("overdues"))));
staffRouter.get(
  "/notifications",
  asyncHandler(async (req, res) =>
    sendSuccess(
      res,
      await Message.find({
        tenantId: req.auth.tenantId,
        branchId: req.auth.branchId,
        type: { $in: STAFF_NOTIFICATION_TYPES },
      })
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
    ),
  ),
);
staffRouter.post(
  "/devices/fcm-token",
  validate({ body: fcmTokenBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    const deviceId = req.body.deviceId ?? req.auth.deviceId;
    await User.updateOne(
      { _id: req.auth.id, tenantId: req.auth.tenantId },
      { $pull: { fcmTokens: { deviceId } } },
    );
    await User.updateOne(
      { _id: req.auth.id, tenantId: req.auth.tenantId },
      {
        $push: {
          fcmTokens: {
            tokenHash: sha256(req.body.fcmToken),
            deviceId,
            platform: req.body.platform,
            updatedAt: new Date(),
          },
        },
      },
    );
    return sendSuccess(res, { registered: true, deviceId });
  }),
);
staffRouter.delete(
  "/devices/fcm-token",
  validate({ body: fcmDeleteBody }),
  asyncHandler(async (req, res) => {
    const deviceId = req.body.deviceId ?? req.auth.deviceId;
    await User.updateOne(
      { _id: req.auth.id, tenantId: req.auth.tenantId },
      { $pull: { fcmTokens: { deviceId } } },
    );
    const { Session } = await import("../models/index.js");
    await Session.updateMany(
      { userId: req.auth.id, tenantId: req.auth.tenantId, deviceId },
      { $set: { revokedAt: new Date() } },
    );
    return sendSuccess(res, { removed: true, deviceId });
  }),
);
staffRouter.get(
  "/profile",
  asyncHandler(async (req, res) => {
    const { tenantUserAuthDto } = await import("../services/auth.service.js");
    sendSuccess(
      res,
      await tenantUserAuthDto(
        await User.findById(req.auth.id).select("-passwordHash").lean(),
      ),
    );
  }),
);
staffRouter.get(
  "/gold-rate/current",
  ...guarded(Permission.GOLD_RATE_READ, asyncHandler(async (req, res) => {
    const { currentGoldRate } = await import("../services/tenant.service.js");
    const { today } = await import("../lib/date.js");
    sendSuccess(res, await currentGoldRate(req.scope, today()));
  })),
);
staffRouter.get("/grievances", ...guarded(Permission.GRIEVANCE_READ, asyncHandler(operations.grievances)));
staffRouter.get(
  "/grievances/:grievanceId",
  ...guarded(Permission.GRIEVANCE_READ, asyncHandler(operations.grievanceDetail)),
);
staffRouter.post(
  "/grievances/:grievanceId/messages",
  ...guarded(
    Permission.GRIEVANCE_REPLY,
    validate({ body: messageBody }),
    idempotent,
    asyncHandler(operations.grievanceMessage),
  ),
);
