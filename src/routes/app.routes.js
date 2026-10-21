import { Router } from "express";
import * as auth from "../controllers/auth.controller.js";
import * as appCustomer from "../controllers/customer-app.controller.js";
import * as upload from "../controllers/upload.controller.js";
import * as payment from "../controllers/payment.controller.js";
import * as operations from "../controllers/operations.controller.js";
import * as ecommerce from "../controllers/ecommerce.controller.js";
import * as digitalMetals from "../controllers/digital-metals.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import {
  appEnrolBody,
  appProfileCompleteBody,
  appProfilePatchBody,
  cancelPaymentIntentBody,
  customerGrievanceMessageBody,
  customerRedemptionRequestBody,
  settlementPreviewQuery,
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
  cursorQuery,
} from "../validators/common.validators.js";
import {
  digitalMetalsBankDestinationCreateBody,
  digitalMetalsBankDestinationPatchBody,
  digitalMetalsBuyOrderCreateBody,
  digitalMetalsBuyPaymentIntentBody,
  digitalMetalsCustomerBuyQuoteBody,
  digitalMetalsCustomerSellQuoteBody,
  digitalMetalsSellOrderConfirmBody,
  digitalMetalsRedemptionQuoteBody,
  digitalMetalsRedemptionOrderCreateBody,
  digitalMetalsRedemptionPaymentIntentBody,
  digitalMetalsSellOrderCreateBody,
  digitalMetalsDocumentRequestBody,
  digitalMetalsCustomerOrderListQuery,
} from "../validators/digital-metals.validators.js";
import { attachDigitalMetalsCapability } from "../middlewares/digital-metals.middleware.js";
import {
  ecommerceAddressCreateBody,
  ecommerceAddressPatchBody,
  ecommerceCartPutBody,
  ecommerceQuoteCreateBody,
  ecommerceOrderCreateBody,
  ecommerceCancellationReasonBody,
  ecommerceReturnRequestCreateBody,
  ecommerceTestHarnessPaymentBody,
  ecommercePaymentIntentBody,
  ecommercePickupConfirmBody,
} from "../validators/ecommerce.validators.js";
import { enrolPaymentResponse, paymentIntentAppDto, paymentLinkDto } from "../lib/customer-app-dto.js";
import { ClosureType, DevicePrincipalType } from "../constants/enums.js";
import { registerFcmDevice, revokeFcmDevice } from "../services/device-registration.service.js";
import { AppError } from "../lib/app-error.js";
import {
  assertCustomerAppAvailable,
  assertCustomerAppWritable,
  assertCustomerPaymentsEnabled,
} from "../lib/customer-app-access.js";
import { sendSuccess } from "../lib/response.js";
import * as schemes from "../services/scheme.service.js";
export const appRouter = Router();
const requireCustomerAppAvailable = (req, _res, next) => {
  try {
    assertCustomerAppAvailable(req.tenant);
    next();
  } catch (error) {
    next(error);
  }
};
appRouter.use(requireCustomerAppAvailable);
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
/** Self-enrol payment capability is enforced from resolved first-installment mode in enrolment validation. */
const requireCustomerEnrolAccess = (req, _res, next) => {
  try {
    assertCustomerAppWritable(req.tenant);
    next();
  } catch (error) {
    next(error);
  }
};

appRouter.get("/auth/devices", asyncHandler(auth.devices));
appRouter.delete("/auth/devices/:deviceId", asyncHandler(auth.revokeDevice));

appRouter.get("/home", asyncHandler(appCustomer.home));
appRouter.get("/profile", asyncHandler(appCustomer.profile));
appRouter.patch(
  "/profile",
  requireCustomerAppWrite,
  validate({ body: appProfilePatchBody }),
  asyncHandler(appCustomer.completeProfile),
);
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
    const { isCustomerSelfKycEnabled } = await import("../lib/kyc-policy.js");
    if (!isCustomerSelfKycEnabled(req.tenant)) {
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
appRouter.get(
  "/schemes/:schemeId/settlement-preview",
  validate({ query: settlementPreviewQuery }),
  asyncHandler(operations.settlementPreview(ClosureType.MATURITY_REDEMPTION)),
);
appRouter.get("/schemes/:schemeId", asyncHandler(appCustomer.getScheme));

appRouter.post(
  "/schemes/enrol",
  requireCustomerEnrolAccess,
  validate({ body: appEnrolBody }),
  idempotent,
  asyncHandler(async (req, res) => {
    req.body.customerId = req.auth.id;
    const { enrolled, checkout, checkoutKind } = await schemes.customerEnrolWithCheckout(req);
    const schemeId = enrolled._id ?? enrolled.id;
    let payment = null;
    if (checkoutKind === "FLEXIBLE_PAYMENT_INTENT" && checkout) {
      payment = enrolPaymentResponse(
        "FLEXIBLE_PAYMENT_INTENT",
        paymentIntentAppDto(checkout, checkout),
      );
    } else if (checkoutKind === "FIXED_PAYMENT_LINK" && checkout) {
      payment = enrolPaymentResponse(
        "FIXED_PAYMENT_LINK",
        paymentLinkDto(checkout, checkout.token),
      );
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
  const customerApp = await import("../services/customer-app.service.js");
  sendSuccess(res, await customerApp.markNotificationRead(req.auth, req.params.id));
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

appRouter.get("/digital-metals/capability", asyncHandler(digitalMetals.customerCapability));
appRouter.get("/digital-metals/portfolio", asyncHandler(digitalMetals.customerPortfolio));
appRouter.get("/digital-metals/passbook", asyncHandler(digitalMetals.customerPassbook));
appRouter.get("/digital-metals/statements/metal", asyncHandler(digitalMetals.customerMetalStatement));
appRouter.get("/digital-metals/statements/metal.pdf", asyncHandler(digitalMetals.customerMetalStatementPdf));
appRouter.get(
  "/digital-metals/redemption/orders/:orderId/charge-receipt.pdf",
  asyncHandler(digitalMetals.customerRedemptionChargeReceipt),
);
appRouter.get(
  "/digital-metals/redemption/orders/:orderId/handover-receipt.pdf",
  asyncHandler(digitalMetals.customerPhysicalHandoverReceipt),
);
appRouter.get(
  "/digital-metals/sell-orders/:orderId/acknowledgement.pdf",
  asyncHandler(digitalMetals.customerSellAcknowledgement),
);
appRouter.post(
  "/digital-metals/documents/request",
  validate({ body: digitalMetalsDocumentRequestBody }),
  idempotent,
  asyncHandler(digitalMetals.customerRequestDigitalMetalDocument),
);
appRouter.get(
  "/digital-metals/documents/by-subject",
  asyncHandler(digitalMetals.customerFindDigitalMetalDocumentBySubject),
);
appRouter.get(
  "/digital-metals/documents/:artifactId",
  asyncHandler(digitalMetals.customerGetDigitalMetalDocument),
);
appRouter.get(
  "/digital-metals/documents/:artifactId/download-url",
  asyncHandler(digitalMetals.customerGetDigitalMetalDocumentDownloadUrl),
);
appRouter.post(
  "/digital-metals/documents/:artifactId/retry",
  idempotent,
  asyncHandler(digitalMetals.customerRetryDigitalMetalDocument),
);
appRouter.post(
  "/digital-metals/quotes/buy",
  validate({ body: digitalMetalsCustomerBuyQuoteBody }),
  idempotent,
  asyncHandler(digitalMetals.customerBuyQuote),
);
appRouter.post(
  "/digital-metals/buy-orders",
  validate({ body: digitalMetalsBuyOrderCreateBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateBuyOrder),
);
appRouter.get(
  "/digital-metals/buy-orders",
  attachDigitalMetalsCapability,
  validate({ query: digitalMetalsCustomerOrderListQuery }),
  asyncHandler(digitalMetals.customerListBuyOrders),
);
appRouter.get("/digital-metals/buy-orders/:orderId", asyncHandler(digitalMetals.customerGetBuyOrder));
appRouter.get(
  "/digital-metals/buy-orders/:orderId/invoice",
  asyncHandler(digitalMetals.customerStreamBuyOrderInvoice),
);
appRouter.post(
  "/digital-metals/buy-orders/:orderId/payment-intents",
  validate({ body: digitalMetalsBuyPaymentIntentBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateBuyPaymentIntent),
);
appRouter.get(
  "/digital-metals/buy-orders/:orderId/payment-intents/:paymentAttemptId",
  asyncHandler(digitalMetals.customerGetBuyPaymentIntent),
);
appRouter.post(
  "/digital-metals/buy-orders/:orderId/test-harness/complete-payment",
  idempotent,
  asyncHandler(digitalMetals.customerCompleteBuyTestHarnessPayment),
);
appRouter.post(
  "/digital-metals/quotes/sell",
  validate({ body: digitalMetalsCustomerSellQuoteBody }),
  idempotent,
  asyncHandler(digitalMetals.customerSellQuote),
);
appRouter.get(
  "/digital-metals/orders/open-summary",
  attachDigitalMetalsCapability,
  asyncHandler(digitalMetals.customerOpenOrdersSummary),
);
appRouter.post(
  "/digital-metals/sell-orders",
  validate({ body: digitalMetalsSellOrderCreateBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateSellOrder),
);
appRouter.get(
  "/digital-metals/sell-orders",
  attachDigitalMetalsCapability,
  validate({ query: digitalMetalsCustomerOrderListQuery }),
  asyncHandler(digitalMetals.customerListSellOrders),
);
appRouter.post(
  "/digital-metals/sell-orders/:orderId/confirm",
  validate({ body: digitalMetalsSellOrderConfirmBody }),
  idempotent,
  asyncHandler(digitalMetals.customerConfirmSellOrder),
);
appRouter.post(
  "/digital-metals/sell-orders/:orderId/cancel",
  idempotent,
  asyncHandler(digitalMetals.customerCancelSellOrder),
);
appRouter.get(
  "/digital-metals/sell-orders/:orderId",
  asyncHandler(digitalMetals.customerGetSellOrder),
);
appRouter.get(
  "/digital-metals/sell-orders/:orderId/payout-status",
  asyncHandler(digitalMetals.customerGetSellOrderPayoutStatus),
);
appRouter.get(
  "/digital-metals/delivery-addresses",
  asyncHandler(digitalMetals.customerListDigitalMetalsDeliveryAddresses),
);
appRouter.post(
  "/digital-metals/delivery-addresses",
  validate({ body: ecommerceAddressCreateBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateDigitalMetalsDeliveryAddress),
);
appRouter.get(
  "/digital-metals/redemption/catalogue",
  asyncHandler(digitalMetals.customerRedemptionCatalogue),
);
appRouter.post(
  "/digital-metals/quotes/redemption",
  validate({ body: digitalMetalsRedemptionQuoteBody }),
  idempotent,
  asyncHandler(digitalMetals.customerRedemptionQuote),
);
appRouter.post(
  "/digital-metals/redemption/orders",
  validate({ body: digitalMetalsRedemptionOrderCreateBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateRedemptionOrder),
);
appRouter.get(
  "/digital-metals/redemption/orders",
  attachDigitalMetalsCapability,
  validate({ query: digitalMetalsCustomerOrderListQuery }),
  asyncHandler(digitalMetals.customerListRedemptionOrders),
);
appRouter.get(
  "/digital-metals/redemption/orders/:orderId",
  asyncHandler(digitalMetals.customerGetRedemptionOrder),
);
appRouter.post(
  "/digital-metals/redemption/orders/:orderId/cancel",
  idempotent,
  asyncHandler(digitalMetals.customerCancelRedemptionOrder),
);
appRouter.post(
  "/digital-metals/redemption/orders/:orderId/payment-intents",
  validate({ body: digitalMetalsRedemptionPaymentIntentBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateRedemptionPaymentIntent),
);
appRouter.post(
  "/digital-metals/redemption/orders/:orderId/test-harness/complete-payment",
  idempotent,
  asyncHandler(digitalMetals.customerCompleteRedemptionTestHarnessPayment),
);
appRouter.get(
  "/digital-metals/redemption/orders/:orderId/payment-intents/:paymentAttemptId",
  asyncHandler(digitalMetals.customerPollRedemptionChargePayment),
);
appRouter.get(
  "/digital-metals/redemption/orders/:orderId/fulfilment",
  asyncHandler(digitalMetals.customerRedemptionFulfilmentProgress),
);
appRouter.get(
  "/digital-metals/redemption/orders/:orderId/pickup-instructions",
  asyncHandler(digitalMetals.customerRedemptionPickupReveal),
);
appRouter.get(
  "/digital-metals/bank-destinations",
  asyncHandler(digitalMetals.customerListBankDestinations),
);
appRouter.post(
  "/digital-metals/bank-destinations",
  validate({ body: digitalMetalsBankDestinationCreateBody }),
  idempotent,
  asyncHandler(digitalMetals.customerCreateBankDestination),
);
appRouter.patch(
  "/digital-metals/bank-destinations/:destinationId",
  validate({ body: digitalMetalsBankDestinationPatchBody }),
  asyncHandler(digitalMetals.customerPatchBankDestination),
);
appRouter.get("/home/banners", asyncHandler(ecommerce.shopHomeBanners));
appRouter.get("/shop/availability", asyncHandler(ecommerce.shopAvailability));
appRouter.get("/shop/banners", asyncHandler(ecommerce.shopStorefrontBanners));
appRouter.get("/shop/categories", asyncHandler(ecommerce.shopCategories));
appRouter.get("/shop/store-policies", asyncHandler(ecommerce.shopStorePolicies));
appRouter.get("/shop/products", asyncHandler(ecommerce.shopProducts));
appRouter.get("/shop/products/:productIdOrSlug", asyncHandler(ecommerce.shopProduct));
appRouter.get("/shop/addresses", asyncHandler(ecommerce.shopListAddresses));
appRouter.post(
  "/shop/addresses",
  validate({ body: ecommerceAddressCreateBody }),
  idempotent,
  asyncHandler(ecommerce.shopCreateAddress),
);
appRouter.patch(
  "/shop/addresses/:addressId",
  validate({ body: ecommerceAddressPatchBody }),
  asyncHandler(ecommerce.shopPatchAddress),
);
appRouter.get("/shop/cart", asyncHandler(ecommerce.shopGetCart));
appRouter.put(
  "/shop/cart",
  validate({ body: ecommerceCartPutBody }),
  idempotent,
  asyncHandler(ecommerce.shopPutCart),
);
appRouter.get("/shop/fulfilment-options", asyncHandler(ecommerce.shopFulfilmentOptions));
appRouter.post(
  "/shop/quotes",
  validate({ body: ecommerceQuoteCreateBody }),
  asyncHandler(ecommerce.shopCreateQuote),
);
appRouter.get("/shop/quotes/:quoteId", asyncHandler(ecommerce.shopGetQuote));
appRouter.post(
  "/shop/quotes/:quoteId/cancel",
  idempotent,
  asyncHandler(ecommerce.shopCancelQuote),
);
appRouter.post(
  "/shop/orders",
  validate({ body: ecommerceOrderCreateBody }),
  asyncHandler(ecommerce.shopCreateOrder),
);
appRouter.get(
  "/shop/orders",
  validate({ query: cursorQuery }),
  asyncHandler(ecommerce.shopListOrders),
);
appRouter.get("/shop/orders/:orderId", asyncHandler(ecommerce.shopGetOrder));
appRouter.post(
  "/shop/orders/:orderId/confirm-pickup",
  validate({ body: ecommercePickupConfirmBody }),
  asyncHandler(ecommerce.confirmPickupHandover),
);
appRouter.get(
  "/shop/orders/:orderId/invoice.pdf",
  asyncHandler(ecommerce.shopOrderInvoicePdf),
);
appRouter.post(
  "/shop/orders/:orderId/cancel",
  validate({ body: ecommerceCancellationReasonBody }),
  asyncHandler(ecommerce.shopCancelOrder),
);
appRouter.get(
  "/shop/orders/:orderId/cancellation",
  asyncHandler(ecommerce.shopGetOrderCancellation),
);
appRouter.post(
  "/shop/orders/:orderId/cancellation-requests",
  idempotent,
  validate({ body: ecommerceCancellationReasonBody }),
  asyncHandler(ecommerce.shopCreateCancellationRequest),
);
appRouter.get(
  "/shop/orders/:orderId/return",
  asyncHandler(ecommerce.shopGetOrderReturn),
);
appRouter.post(
  "/shop/orders/:orderId/return-requests",
  idempotent,
  validate({ body: ecommerceReturnRequestCreateBody }),
  asyncHandler(ecommerce.shopCreateReturnRequest),
);
appRouter.post(
  "/shop/orders/:orderId/payment-intents",
  validate({ body: ecommercePaymentIntentBody }),
  asyncHandler(ecommerce.shopCreateOrderPaymentIntent),
);
appRouter.get(
  "/shop/orders/:orderId/payment-intents/:paymentAttemptId",
  asyncHandler(ecommerce.shopGetOrderPaymentIntent),
);
appRouter.post(
  "/shop/orders/:orderId/test-harness/complete-payment",
  validate({ body: ecommerceTestHarnessPaymentBody }),
  idempotent,
  asyncHandler(ecommerce.shopCompleteTestHarnessPayment),
);

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
