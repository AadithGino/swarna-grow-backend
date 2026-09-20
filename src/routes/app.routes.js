import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import * as appCustomer from "../controllers/customer-app.controller.js";
import * as upload from "../controllers/upload.controller.js";
import * as payment from "../controllers/payment.controller.js";
import * as operations from "../controllers/operations.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  appEnrolBody,
  appProfileCompleteBody,
  cancelPaymentIntentBody,
  customerGrievanceMessageBody,
  customerRedemptionRequestBody,
  fcmDeleteBody,
  fcmRegisterBody,
  fixedSchemePayBody,
  paymentIntentBody,
  uploadBody,
  nomineeBody,
  nomineeVersionBody,
  kycSubmitBody,
  grievanceBody,
  grievanceReopenBody,
} from "../validators/common.validators.js";
import { enrolPaymentResponse, paymentIntentAppDto, paymentLinkDto } from "../lib/customer-app-dto.js";
import { ClosureType, DevicePrincipalType } from "../constants/enums.js";
import { registerFcmDevice, revokeFcmDevice } from "../services/device-registration.service.js";
import { AppError } from "../lib/app-error.js";
import { assertCustomerAppWritable, assertCustomerPaymentsEnabled } from "../lib/customer-app-access.js";
import { Customer } from "../models/index.js";
import { sendSuccess } from "../lib/response.js";
import * as schemes from "../services/scheme.service.js";
import * as payments from "../services/payment.service.js";
import { PaymentPattern } from "../constants/enums.js";
import { monthKey } from "../lib/date.js";
export const appRouter = Router();
const requireCustomerAppWrite = (req, _res, next) => {
  try {
    assertCustomerAppWritable(req.tenant);
    next();
  } catch (error) {
    next(error);
  }
};
const requireCustomerPayments = (req, _res, next) => {
  try {
    assertCustomerPaymentsEnabled(req.tenant);
    next();
  } catch (error) {
    next(error);
  }
};

appRouter.get("/auth/devices", asyncHandler(auth.devices));
appRouter.delete("/auth/devices/:deviceId", asyncHandler(auth.revokeDevice));

appRouter.get("/home", asyncHandler(appCustomer.home));
appRouter.get("/profile", asyncHandler(appCustomer.profile));
appRouter.patch("/profile", requireCustomerAppWrite, asyncHandler(appCustomer.completeProfile));
appRouter.post(
  "/profile/complete",
  requireCustomerAppWrite,
  validate({ body: appProfileCompleteBody }),
  idempotent,
  asyncHandler(appCustomer.completeProfile),
);
appRouter.put(
  "/profile/kyc",
  requireCustomerAppWrite,
  validate({ body: kycSubmitBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    if (req.tenant?.settings?.requireKycForEnrolment !== true) {
      throw new AppError("KYC_NOT_ENABLED", "KYC is not enabled for this jeweller.", 403);
    }
    req.params.customerId = req.auth.id;
    req.scope = { tenantId: req.auth.tenantId };
    const customers = await import("../services/customer.service.js");
    const customerAppSvc = await import("../services/customer-app.service.js");
    await customers.updateKyc(req, false);
    return sendSuccess(res, await customerAppSvc.getAppProfile(req.auth, req.tenant));
  }),
);
appRouter.put(
  "/profile/nominee",
  requireCustomerAppWrite,
  validate({ body: nomineeBody }),
  idempotent,
  asyncHandler(appCustomer.updateNominee),
);
appRouter.delete(
  "/profile/nominee",
  requireCustomerAppWrite,
  validate({ body: nomineeVersionBody }),
  idempotent,
  asyncHandler(appCustomer.removeNominee),
);

appRouter.post("/uploads/presign", requireCustomerAppWrite, validate({ body: uploadBody }), idempotent, asyncHandler(appCustomer.presign));
appRouter.post("/uploads/:uploadId/complete", requireCustomerAppWrite, idempotent, asyncHandler(upload.complete));
appRouter.get("/uploads/:uploadId", asyncHandler(upload.download));

appRouter.get("/scheme-plans", asyncHandler(appCustomer.listPlans));
appRouter.get("/scheme-plans/:planId", asyncHandler(appCustomer.getPlan));
appRouter.get("/schemes", asyncHandler(appCustomer.listSchemes));
appRouter.get("/schemes/:schemeId/payable-range", asyncHandler(appCustomer.payableRange));
appRouter.get("/schemes/:schemeId/passbook", asyncHandler(async (req, res) => sendSuccess(res, await schemes.getPassbook(req))));
appRouter.get("/schemes/:schemeId/settlement-preview", asyncHandler(operations.settlementPreview(ClosureType.MATURITY_REDEMPTION)));
appRouter.get("/schemes/:schemeId", asyncHandler(appCustomer.getScheme));

appRouter.post(
  "/schemes/enrol",
  requireCustomerPayments,
  validate({ body: appEnrolBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    req.body.customerId = req.auth.id;
    const enrolled = await schemes.enrol(req);
    let payment = null;
    if (req.body.payNow !== false && enrolled.firstInstallmentRequired) {
      const schemeId = enrolled._id ?? enrolled.id;
      const targetCycle = req.query?.targetCycle ?? req.body?.targetCycle ?? monthKey();
      const payReq = {
        auth: req.auth,
        tenant: req.tenant,
        baseUrl: req.baseUrl,
        scope: { tenantId: req.auth.tenantId, customerId: req.auth.id },
        params: { schemeId },
        query: { ...(req.query ?? {}), targetCycle },
        body: {
          amountPaise: enrolled.installmentAmountPaise,
          redirectUrl: req.body.redirectUrl,
          schemeId,
          targetCycle,
        },
      };
      if (enrolled.paymentPattern === PaymentPattern.FLEXIBLE) {
        payReq.body.expectedPositionVersion = enrolled.positionVersion ?? 0;
        const intent = await payments.createPaymentIntent(payReq);
        payment = enrolPaymentResponse(
          "FLEXIBLE_PAYMENT_INTENT",
          paymentIntentAppDto(intent, intent),
        );
      } else {
        const link = await payments.createPaymentLink(payReq);
        payment = enrolPaymentResponse(
          "FIXED_PAYMENT_LINK",
          paymentLinkDto(link, link.token),
        );
      }
    }
    const schemeId = enrolled._id ?? enrolled.id;
    try {
      const { queueCustomerNotification } = await import("../services/customer-notification.service.js");
      const customer = await Customer.findOne({
        _id: req.auth.id,
        tenantId: req.auth.tenantId,
      })
        .select("mobile whatsappOptedOutAt")
        .lean();
      if (customer) {
        await queueCustomerNotification({
          tenantId: req.auth.tenantId,
          branchId: enrolled.branchId,
          customerId: req.auth.id,
          schemeId,
          type: "SCHEME_JOINED",
          templateParams: {
            mobile: customer.mobile,
            enrollmentNumber: enrolled.enrollmentNumber,
            schemeName: enrolled.planSnapshot?.displayName ?? enrolled.planSnapshot?.name,
          },
        });
      }
    } catch {
      // enrolment must succeed even if notification queue fails
    }
    return sendSuccess(
      res,
      {
        scheme: { id: schemeId, schemeNumber: enrolled.enrollmentNumber },
        ...payment,
      },
      {},
      201,
    );
  }),
);

appRouter.post(
  "/schemes/:schemeId/pay",
  requireCustomerPayments,
  validate({ body: fixedSchemePayBody }),
  idempotent,
  asyncHandler(appCustomer.fixedSchemePay),
);
appRouter.post(
  "/schemes/:schemeId/payment-intents",
  requireCustomerPayments,
  validate({ body: paymentIntentBody }),
  idempotent,
  asyncHandler(appCustomer.createIntent),
);
appRouter.post(
  "/schemes/:schemeId/pay/sdk-order",
  requireCustomerPayments,
  validate({ body: paymentIntentBody }),
  idempotent,
  asyncHandler(appCustomer.createSdkOrder),
);
appRouter.get("/payment-intents/:intentId", asyncHandler(appCustomer.getIntent));
appRouter.post(
  "/payment-intents/:intentId/cancel",
  requireCustomerPayments,
  validate({ body: cancelPaymentIntentBody }),
  idempotent,
  asyncHandler(payment.cancelIntent),
);

appRouter.get("/payments", asyncHandler(appCustomer.listPayments));
appRouter.get("/payments/:paymentId/receipt", asyncHandler(async (req, res) => {
  req.scope = { tenantId: req.auth.tenantId, customerId: req.auth.id };
  return payment.receipt(req, res);
}));
appRouter.get("/payments/:paymentId", asyncHandler(appCustomer.getPayment));
appRouter.get("/payments/:linkId/status", asyncHandler(appCustomer.paymentLinkStatus));

appRouter.get("/notifications", asyncHandler(appCustomer.notifications));
appRouter.post("/notifications/:id/read", idempotent, asyncHandler(async (req, res) => {
  assertCustomerAppWritable(req.tenant);
  const { Message } = await import("../models/index.js");
  sendSuccess(res, await Message.findOneAndUpdate(
    { _id: req.params.id, tenantId: req.auth.tenantId, customerId: req.auth.id },
    { $set: { readAt: new Date() } },
    { new: true },
  ).lean());
}));
appRouter.post("/notifications/read-all", idempotent, asyncHandler(async (req, res) => {
  assertCustomerAppWritable(req.tenant);
  const { Message } = await import("../models/index.js");
  const result = await Message.updateMany(
    { tenantId: req.auth.tenantId, customerId: req.auth.id, readAt: null },
    { $set: { readAt: new Date() } },
  );
  sendSuccess(res, { updated: result.modifiedCount });
}));

appRouter.post(
  "/devices/fcm-token",
  requireCustomerAppWrite,
  validate({ body: fcmRegisterBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    const deviceId = req.body.deviceId ?? req.auth.deviceId;
    await registerFcmDevice({
      tenantId: req.auth.tenantId,
      principalType: DevicePrincipalType.CUSTOMER,
      principalId: req.auth.id,
      deviceId,
      platform: req.body.platform,
      fcmToken: req.body.fcmToken,
    });
    sendSuccess(res, {
      registered: true,
      deviceId,
      replacedPreviousToken: true,
    });
  }),
);
appRouter.delete(
  "/devices/fcm-token",
  requireCustomerAppWrite,
  validate({ body: fcmDeleteBody }),
  asyncHandler(async (req, res) => {
    const deviceId = req.body.deviceId ?? req.auth.deviceId;
    await revokeFcmDevice({
      tenantId: req.auth.tenantId,
      principalType: DevicePrincipalType.CUSTOMER,
      principalId: req.auth.id,
      deviceId,
    });
    const { Session } = await import("../models/index.js");
    await Session.updateMany(
      { customerId: req.auth.id, tenantId: req.auth.tenantId, deviceId },
      { $set: { revokedAt: new Date() } },
    );
    sendSuccess(res, { removed: true, deviceId });
  }),
);

appRouter.get("/branches", asyncHandler(async (req, res) => {
  const { Branch } = await import("../models/index.js");
  sendSuccess(res, await Branch.find({ tenantId: req.auth.tenantId, active: true }).lean());
}));
appRouter.get("/gold-rate/current", asyncHandler(async (req, res) => {
  const { currentGoldRate } = await import("../services/tenant.service.js");
  const { today } = await import("../lib/date.js");
  sendSuccess(res, await currentGoldRate({ tenantId: req.auth.tenantId, branchId: req.query.branchId ?? req.auth.branchId }, today()));
}));
appRouter.get("/gold-rate/history", asyncHandler(async (req, res) => {
  const { GoldRate } = await import("../models/index.js");
  sendSuccess(res, await GoldRate.find({ tenantId: req.auth.tenantId }).sort({ effectiveDate: -1 }).limit(100).lean());
}));

appRouter.post("/grievances", requireCustomerAppWrite, validate({ body: grievanceBody }), idempotent, asyncHandler(operations.createGrievance));
appRouter.get("/grievances", asyncHandler(operations.grievances));
appRouter.get("/grievances/:grievanceId", asyncHandler(operations.grievanceDetail));
appRouter.post(
  "/grievances/:grievanceId/messages",
  requireCustomerAppWrite,
  validate({ body: customerGrievanceMessageBody }),
  idempotent,
  asyncHandler(operations.customerGrievanceMessage),
);
appRouter.post(
  "/grievances/:grievanceId/reopen",
  requireCustomerAppWrite,
  validate({ body: grievanceReopenBody }),
  idempotent,
  asyncHandler(operations.reopenGrievance),
);

appRouter.post(
  "/schemes/:schemeId/redemption-request",
  requireCustomerAppWrite,
  validate({ body: customerRedemptionRequestBody }),
  idempotent,
  asyncHandler(operations.requestCustomerRedemption),
);
