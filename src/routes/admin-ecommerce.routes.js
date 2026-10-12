import { Router } from "express";
import * as controller from "../controllers/ecommerce.controller.js";
import { asyncHandler } from "../lib/async-handler.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { guarded } from "../lib/route.js";
import { requirePermission } from "../middlewares/auth.middleware.js";
import { Permission } from "../constants/permissions.js";
import {
  ecommerceCategoryCreateBody,
  ecommerceCategoryPatchBody,
  ecommerceGoldRateBody,
  ecommerceProductCreateBody,
  ecommerceProductPatchBody,
  ecommerceTaxSettingsBody,
  ecommerceVersionBody,
  ecommerceInventoryPatchBody,
  ecommerceInventoryAdjustBody,
  ecommerceFulfilmentSettingsPutBody,
  ecommerceOrderFulfilmentTransitionBody,
  ecommerceCodOrderActionBody,
  ecommerceCodCollectionBody,
  ecommercePaymentExceptionRefundManualBody,
  ecommercePaymentOperationalAckBody,
  ecommercePaymentReconcileRetryBody,
  ecommerceCancellationDecisionBody,
  ecommerceAdminInitiateCancellationBody,
  ecommerceCodCancellationManualRefundBody,
  ecommerceOrderDeliveryTrackingPatchBody,
  ecommerceReturnDecisionBody,
  ecommerceReturnReceivedBody,
  ecommerceReturnInspectionBody,
  ecommerceReturnResolveBody,
  ecommerceReturnRefundCaseBody,
  ecommerceReturnManualRefundBody,
  ecommerceAdminOrdersListQuery,
  ecommerceSummaryQuery,
  ecommerceReportKeyParam,
  ecommerceDeliveryHandoverBody,
  ecommerceCodCustodyHandoverBody,
  ecommerceCodBankDepositBody,
  ecommerceCodCustodyListQuery,
} from "../validators/ecommerce.validators.js";
import { cursorQuery } from "../validators/common.validators.js";
import {
  reportExportAliasBody,
} from "../validators/admin-mutation.validators.js";

export const adminEcommerceRouter = Router();

adminEcommerceRouter.get(
  "/ecommerce/store-status",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.storeStatus)),
);
adminEcommerceRouter.get(
  "/ecommerce/categories",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listCategories)),
);
adminEcommerceRouter.post(
  "/ecommerce/categories",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceCategoryCreateBody }),
    idempotent,
    asyncHandler(controller.createCategory),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/categories/:categoryId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getCategory)),
);
adminEcommerceRouter.patch(
  "/ecommerce/categories/:categoryId",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceCategoryPatchBody }),
    asyncHandler(controller.patchCategory),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/categories/:categoryId/archive",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceVersionBody }),
    idempotent,
    asyncHandler(controller.archiveCategory),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/products",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listProducts)),
);
adminEcommerceRouter.post(
  "/ecommerce/products",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceProductCreateBody }),
    idempotent,
    asyncHandler(controller.createProduct),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/products/:productId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getProduct)),
);
adminEcommerceRouter.patch(
  "/ecommerce/products/:productId",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceProductPatchBody }),
    asyncHandler(controller.patchProduct),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/products/:productId/publish",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceVersionBody }),
    idempotent,
    asyncHandler(controller.publishProduct),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/products/:productId/archive",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceVersionBody }),
    idempotent,
    asyncHandler(controller.archiveProduct),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/products/:productId/price-preview",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.previewProductPrice)),
);
adminEcommerceRouter.post(
  "/ecommerce/gold-rates",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceGoldRateBody }),
    idempotent,
    asyncHandler(controller.setGoldRate),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/gold-rates/history",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.goldRateHistory)),
);
adminEcommerceRouter.get(
  "/ecommerce/gold-rates/current",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.goldRatesCurrent)),
);
adminEcommerceRouter.get(
  "/ecommerce/tax-settings",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.taxSettings)),
);
adminEcommerceRouter.put(
  "/ecommerce/tax-settings",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceTaxSettingsBody }),
    asyncHandler(controller.putTaxSettings),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/inventory",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listInventory)),
);
adminEcommerceRouter.get(
  "/ecommerce/inventory/:productId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getInventoryProduct)),
);
adminEcommerceRouter.patch(
  "/ecommerce/inventory/:productId",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceInventoryPatchBody }),
    asyncHandler(controller.patchInventoryProduct),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/inventory/:productId/adjust",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceInventoryAdjustBody }),
    idempotent,
    asyncHandler(controller.adjustInventoryProduct),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/fulfilment-settings",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getFulfilmentSettings)),
);
adminEcommerceRouter.put(
  "/ecommerce/fulfilment-settings",
  ...guarded(
    Permission.ECOMMERCE_WRITE,
    validate({ body: ecommerceFulfilmentSettingsPutBody }),
    asyncHandler(controller.putFulfilmentSettings),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/payment-exceptions",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listPaymentExceptions)),
);
adminEcommerceRouter.get(
  "/ecommerce/summary",
  requirePermission(Permission.ECOMMERCE_READ, Permission.REPORT_READ),
  validate({ query: ecommerceSummaryQuery }),
  asyncHandler(controller.getEcommerceWorkspaceSummary),
);
adminEcommerceRouter.get(
  "/ecommerce/reports/:reportKey",
  requirePermission(Permission.ECOMMERCE_READ, Permission.REPORT_READ),
  validate({ params: ecommerceReportKeyParam, query: cursorQuery }),
  asyncHandler(controller.ecommerceReport),
);
adminEcommerceRouter.post(
  "/ecommerce/reports/:reportKey/export",
  requirePermission(Permission.ECOMMERCE_READ, Permission.REPORT_EXPORT),
  validate({ params: ecommerceReportKeyParam, body: reportExportAliasBody }),
  idempotent,
  asyncHandler(async (req, res) => {
      req.body = {
        type: req.params.reportKey,
        filters: req.body.filters ?? {},
        format: req.body.format ?? "CSV",
      };
      const { createExport } = await import("../controllers/analytics.controller.js");
      return createExport(req, res);
    }),
);
adminEcommerceRouter.get(
  "/ecommerce/orders",
  ...guarded(
    Permission.ECOMMERCE_READ,
    validate({ query: ecommerceAdminOrdersListQuery }),
    asyncHandler(controller.listOrders),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/returns",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderReturns)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrder)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/invoice.pdf",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.adminOrderInvoicePdf)),
);
adminEcommerceRouter.get(
  "/ecommerce/cancellation-requests",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listCancellationRequests)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/cancellation",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrderCancellation)),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cancellation/decision",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceCancellationDecisionBody }),
    asyncHandler(controller.decideOrderCancellation),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cancellation/initiate",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    idempotent,
    validate({ body: ecommerceAdminInitiateCancellationBody }),
    asyncHandler(controller.adminInitiateOrderCancellation),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cancellation/cod-manual-refund",
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    idempotent,
    validate({ body: ecommerceCodCancellationManualRefundBody }),
    asyncHandler(controller.recordOrderCodCancellationManualRefund),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-attempts",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderPaymentAttempts)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-attempt-events",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderPaymentAttemptEvents)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-exception-refund",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrderPaymentExceptionRefund)),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-exception-refund/initiate",
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    asyncHandler(controller.initiateOrderPaymentExceptionRefund),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-exception-refund/record-manual",
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    validate({ body: ecommercePaymentExceptionRefundManualBody }),
    asyncHandler(controller.recordOrderPaymentExceptionRefundManual),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/fulfilment-transition",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceOrderFulfilmentTransitionBody }),
    asyncHandler(controller.transitionOrderFulfilment),
  ),
);
adminEcommerceRouter.patch(
  "/ecommerce/orders/:orderId/delivery-tracking",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceOrderDeliveryTrackingPatchBody }),
    asyncHandler(controller.patchOrderDeliveryTracking),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/return-requests",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listReturnRequests)),
);
adminEcommerceRouter.post(
  "/ecommerce/return-requests/:returnRequestId/decision",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceReturnDecisionBody }),
    asyncHandler(controller.decideReturnRequest),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/return-requests/:returnRequestId/received",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceReturnReceivedBody }),
    asyncHandler(controller.recordReturnReceived),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/return-requests/:returnRequestId/inspection",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceReturnInspectionBody }),
    asyncHandler(controller.recordReturnInspection),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/return-requests/:returnRequestId/resolve",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceReturnResolveBody }),
    asyncHandler(controller.resolveReturnRequest),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/return-requests/:returnRequestId/refund-case",
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    validate({ body: ecommerceReturnRefundCaseBody }),
    asyncHandler(controller.createReturnRefundCase),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/return-requests/:returnRequestId/record-manual-refund",
  idempotent,
  ...guarded(
    Permission.ECOMMERCE_REFUND_OPERATE,
    validate({ body: ecommerceReturnManualRefundBody }),
    asyncHandler(controller.recordReturnManualRefund),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cod/accept",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceCodOrderActionBody }),
    asyncHandler(controller.acceptCodOrder),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cod/reject",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceCodOrderActionBody }),
    asyncHandler(controller.rejectCodOrder),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cod/record-collection",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceCodCollectionBody }),
    idempotent,
    asyncHandler(controller.recordCodCollection),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/events",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.listOrderEvents)),
);
adminEcommerceRouter.get(
  "/ecommerce/orders/:orderId/payment-attempts/:paymentAttemptId/provider-status",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getOrderPaymentAttemptProviderStatus)),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-attempts/:paymentAttemptId/reconcile-retry",
  ...guarded(
    Permission.ECOMMERCE_PAYMENT_OPERATE,
    validate({ body: ecommercePaymentReconcileRetryBody }),
    asyncHandler(controller.retryOrderPaymentAttemptReconcile),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/payment-attempts/:paymentAttemptId/operational-ack",
  ...guarded(
    Permission.ECOMMERCE_PAYMENT_OPERATE,
    validate({ body: ecommercePaymentOperationalAckBody }),
    asyncHandler(controller.acknowledgeOrderPaymentAttemptOperational),
  ),
);
adminEcommerceRouter.get(
  "/ecommerce/cod-custody/summary",
  ...guarded(Permission.ECOMMERCE_READ, asyncHandler(controller.getCodCustodySummary)),
);
adminEcommerceRouter.get(
  "/ecommerce/cod-custody/orders",
  ...guarded(
    Permission.ECOMMERCE_READ,
    validate({ query: ecommerceCodCustodyListQuery }),
    asyncHandler(controller.listCodCustodyOrders),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cod-custody/handover",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    idempotent,
    validate({ body: ecommerceCodCustodyHandoverBody }),
    asyncHandler(controller.initiateCodCustodyHandover),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/cod-custody/handovers/:handoverId/accept",
  ...guarded(
    Permission.CASH_HANDOVER_ACCEPT,
    idempotent,
    validate({ body: ecommerceVersionBody }),
    asyncHandler(controller.acceptCodCustodyHandover),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/cod-custody/bank-deposit",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    idempotent,
    validate({ body: ecommerceCodBankDepositBody }),
    asyncHandler(controller.recordCodBankDeposit),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/pickup-code",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceVersionBody }),
    asyncHandler(controller.issuePickupCode),
  ),
);
adminEcommerceRouter.post(
  "/ecommerce/orders/:orderId/delivery-handover",
  ...guarded(
    Permission.ECOMMERCE_FULFILMENT_OPERATE,
    validate({ body: ecommerceDeliveryHandoverBody }),
    asyncHandler(controller.recordDeliveryHandover),
  ),
);
