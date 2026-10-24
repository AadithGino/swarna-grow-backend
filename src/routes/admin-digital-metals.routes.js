import { Router } from "express";
import { asyncHandler } from "../lib/async-handler.js";
import { guarded } from "../lib/route.js";
import { Permission } from "../constants/permissions.js";
import { requireDigitalMetalsCapability } from "../middlewares/digital-metals.middleware.js";
import { validate } from "../middlewares/validation.middleware.js";
import { idempotent } from "../middlewares/idempotency.middleware.js";
import {
  digitalMetalsPayoutCreateBody,
  digitalMetalsPayoutSettlementBody,
  digitalMetalsPayoutFailureBody,
  digitalMetalsPayoutResolveUnknownBody,
  digitalMetalsPayoutSubmitBody,
  digitalMetalsQuotePreviewBody,
  digitalMetalsRatePublishBody,
  digitalMetalsRiskHoldCreateBody,
  digitalMetalsRiskHoldResolveBody,
  digitalMetalsSellApproveBody,
  digitalMetalsSettingsPatchBody,
  digitalMetalsTenantPauseBody,
  digitalMetalsRedemptionCatalogCreateBody,
  digitalMetalsRedemptionFulfilmentVersionBody,
  digitalMetalsRedemptionChargeRefundManualBody,
  digitalMetalsProcurementEntryBody,
  digitalMetalsHedgeCloseDayBody,
  digitalMetalsDocumentRequestBody,
  digitalMetalsAdminScopedOrderListQuery,
  digitalMetalsBankVerificationQueueQuery,
  digitalMetalsBankDestinationVerifyBody,
  digitalMetalsBankDestinationDisableBody,
} from "../validators/digital-metals.validators.js";
import * as controller from "../controllers/digital-metals.controller.js";

export const adminDigitalMetalsRouter = Router();

adminDigitalMetalsRouter.get(
  "/digital-metals/capability",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminCapability)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/workspace",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    requireDigitalMetalsCapability("canViewHoldings"),
    asyncHandler(controller.adminWorkspace),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/settings",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminSettings)),
);

adminDigitalMetalsRouter.patch(
  "/digital-metals/settings",
  ...guarded(
    Permission.DIGITAL_METALS_SETTINGS_WRITE,
    validate({ body: digitalMetalsSettingsPatchBody }),
    idempotent,
    asyncHandler(controller.patchAdminSettings),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/rates/current",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.ratesCurrent)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/rates/history",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.ratesHistory)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/rates/publish",
  ...guarded(
    Permission.DIGITAL_METALS_RATES_WRITE,
    validate({ body: digitalMetalsRatePublishBody }),
    idempotent,
    asyncHandler(controller.publishRate),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/quotes/preview",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ body: digitalMetalsQuotePreviewBody }),
    idempotent,
    asyncHandler(controller.quotePreview),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/operations/pause",
  ...guarded(
    Permission.DIGITAL_METALS_SETTINGS_WRITE,
    validate({ body: digitalMetalsTenantPauseBody }),
    idempotent,
    asyncHandler(controller.tenantPause),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/operations/work-queue",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminDigitalMetalsWorkQueue)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/operations/outbox/:eventId/retry",
  ...guarded(
    Permission.DIGITAL_METALS_SETTINGS_WRITE,
    idempotent,
    asyncHandler(controller.adminRetryDigitalMetalsOutboxEvent),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/operations/documents/:artifactId/retry",
  ...guarded(
    Permission.DIGITAL_METALS_SETTINGS_WRITE,
    idempotent,
    asyncHandler(controller.adminRetryDigitalMetalsDocumentFromOps),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/customers/:customerId/wallets",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminCustomerWallets)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/customers/:customerId/passbook",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminCustomerPassbook)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/buy-orders",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListBuyOrders),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/buy-orders/:orderId",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetBuyOrder)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/payment-exceptions",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminListPaymentExceptions)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/buy-orders/:orderId/refund",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetBuyOrderRefund)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/buy-orders/:orderId/refund-initiate",
  ...guarded(
    Permission.DIGITAL_METALS_ADJUSTMENT_WRITE,
    idempotent,
    asyncHandler(controller.adminInitiateBuyOrderRefund),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/buy-orders/:orderId/invoice",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminStreamBuyOrderInvoice)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/sell-orders",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListSellOrders),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/sell-orders/:orderId",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetSellOrder)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/sell-orders/:orderId/approve",
  ...guarded(
    Permission.DIGITAL_METALS_SELL_APPROVE,
    validate({ body: digitalMetalsSellApproveBody }),
    idempotent,
    asyncHandler(controller.adminApproveSellOrder),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/sell-orders/:orderId/cancel",
  ...guarded(Permission.DIGITAL_METALS_SELL_APPROVE, idempotent, asyncHandler(controller.adminCancelSellOrder)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/customers/:customerId/bank-destinations",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminListCustomerBankDestinations)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/customers/:customerId/bank-destinations/:destinationId/verify",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_RECORD,
    validate({ body: digitalMetalsBankDestinationVerifyBody }),
    idempotent,
    asyncHandler(controller.adminVerifyBankDestination),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/customers/:customerId/bank-destinations/:destinationId/disable",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_RECORD,
    validate({ body: digitalMetalsBankDestinationDisableBody }),
    idempotent,
    asyncHandler(controller.adminDisableBankDestination),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/bank-verification/queue",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsBankVerificationQueueQuery }),
    asyncHandler(controller.adminListBankVerificationQueue),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/payables",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListPayables),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/payouts",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListPayouts),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/payouts/:payoutId",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetPayout)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_RECORD,
    validate({ body: digitalMetalsPayoutCreateBody }),
    idempotent,
    asyncHandler(controller.adminCreatePayout),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts/:payoutId/approve",
  ...guarded(Permission.DIGITAL_METALS_PAYOUT_APPROVE, idempotent, asyncHandler(controller.adminApprovePayout)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts/:payoutId/submit",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_RECORD,
    validate({ body: digitalMetalsPayoutSubmitBody }),
    idempotent,
    asyncHandler(controller.adminSubmitPayout),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts/:payoutId/record-settlement",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_APPROVE,
    validate({ body: digitalMetalsPayoutSettlementBody }),
    idempotent,
    asyncHandler(controller.adminRecordPayoutSettlement),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts/:payoutId/record-failure",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_RECORD,
    validate({ body: digitalMetalsPayoutFailureBody }),
    idempotent,
    asyncHandler(controller.adminRecordPayoutFailure),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts/:payoutId/mark-unknown",
  ...guarded(Permission.DIGITAL_METALS_PAYOUT_RECORD, idempotent, asyncHandler(controller.adminMarkPayoutUnknown)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/payouts/:payoutId/resolve-unknown",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_APPROVE,
    validate({ body: digitalMetalsPayoutResolveUnknownBody }),
    idempotent,
    asyncHandler(controller.adminResolveUnknownPayout),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/customers/:customerId/risk-holds",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminListRiskHolds)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/customers/:customerId/risk-holds",
  ...guarded(
    Permission.DIGITAL_METALS_RISK_MANAGE,
    validate({ body: digitalMetalsRiskHoldCreateBody }),
    idempotent,
    asyncHandler(controller.adminCreateRiskHold),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/risk-holds/:holdId/resolve",
  ...guarded(
    Permission.DIGITAL_METALS_RISK_MANAGE,
    validate({ body: digitalMetalsRiskHoldResolveBody }),
    idempotent,
    asyncHandler(controller.adminResolveRiskHold),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/catalogue",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminListRedemptionCatalogue)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/catalogue",
  ...guarded(
    Permission.DIGITAL_METALS_SETTINGS_WRITE,
    validate({ body: digitalMetalsRedemptionCatalogCreateBody }),
    idempotent,
    asyncHandler(controller.adminCreateRedemptionCatalogItem),
  ),
);

adminDigitalMetalsRouter.patch(
  "/digital-metals/redemption/catalogue/:itemId",
  ...guarded(Permission.DIGITAL_METALS_SETTINGS_WRITE, asyncHandler(controller.adminPatchRedemptionCatalogItem)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/orders",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListRedemptionOrders),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/orders/:orderId",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetRedemptionOrder)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/fulfilment/queue",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListRedemptionFulfilmentQueue),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/accept",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminAcceptRedemptionFulfilment),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/packing",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminRecordRedemptionPacking),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/delay",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminRecordRedemptionDelay),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/dispatch",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminDispatchRedemptionOrder),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/pickup-ready",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminMarkRedemptionPickupReady),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/pickup-code",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminIssueRedemptionPickupCode),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/complete-pickup",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminCompleteRedemptionPickup),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/complete-delivery",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminCompleteRedemptionDelivery),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/cancel",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminCancelRedemptionPreDispatch),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/investigation",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminOpenRedemptionInvestigation),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/resolve-return",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminResolveRedemptionReturn),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/fulfilment/replacement-dispatch",
  ...guarded(
    Permission.DIGITAL_METALS_REDEMPTION_FULFIL,
    validate({ body: digitalMetalsRedemptionFulfilmentVersionBody }),
    idempotent,
    asyncHandler(controller.adminDispatchRedemptionReplacement),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/charge-refunds",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ query: digitalMetalsAdminScopedOrderListQuery }),
    asyncHandler(controller.adminListRedemptionChargeRefunds),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/orders/:orderId/charge-refund",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetRedemptionChargeRefund)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/orders/:orderId/charge-refund/initiate",
  ...guarded(Permission.DIGITAL_METALS_PAYOUT_RECORD, idempotent, asyncHandler(controller.adminInitiateRedemptionChargeRefund)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/redemption/charge-refunds/:refundCaseId/record-manual",
  ...guarded(
    Permission.DIGITAL_METALS_PAYOUT_APPROVE,
    validate({ body: digitalMetalsRedemptionChargeRefundManualBody }),
    idempotent,
    asyncHandler(controller.adminRecordManualRedemptionChargeRefund),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/procurement/entries",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminListProcurementEntries)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/procurement/entries/:id",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetProcurementEntry)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/procurement/entries",
  ...guarded(
    Permission.DIGITAL_METALS_PROCUREMENT_WRITE,
    validate({ body: digitalMetalsProcurementEntryBody }),
    idempotent,
    asyncHandler(controller.adminCreateProcurementEntry),
  ),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/procurement/entries/:id/approve",
  ...guarded(Permission.DIGITAL_METALS_PROCUREMENT_APPROVE, idempotent, asyncHandler(controller.adminApproveProcurementEntry)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/hedge/live",
  ...guarded(Permission.DIGITAL_METALS_REPORT_READ, asyncHandler(controller.adminGetLiveHedgeReport)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/hedge/snapshots/close-day",
  ...guarded(
    Permission.DIGITAL_METALS_REPORT_READ,
    validate({ body: digitalMetalsHedgeCloseDayBody }),
    idempotent,
    asyncHandler(controller.adminCloseHedgeDay),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/hedge/snapshots-invalidated",
  ...guarded(Permission.DIGITAL_METALS_REPORT_READ, asyncHandler(controller.adminListInvalidatedHedgeSnapshots)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/hedge/snapshots/:businessDate",
  ...guarded(Permission.DIGITAL_METALS_REPORT_READ, asyncHandler(controller.adminGetHedgeSnapshot)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/payouts/:payoutId/receipt.pdf",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminPayoutReceipt)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/orders/:orderId/charge-receipt.pdf",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminRedemptionChargeReceipt)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/redemption/orders/:orderId/handover-receipt.pdf",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminPhysicalHandoverReceipt)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/documents/request",
  ...guarded(
    Permission.DIGITAL_METALS_READ,
    validate({ body: digitalMetalsDocumentRequestBody }),
    idempotent,
    asyncHandler(controller.adminRequestDigitalMetalDocument),
  ),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/documents/by-subject",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminFindDigitalMetalDocumentBySubject)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/documents/:artifactId",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetDigitalMetalDocument)),
);

adminDigitalMetalsRouter.get(
  "/digital-metals/documents/:artifactId/download-url",
  ...guarded(Permission.DIGITAL_METALS_READ, asyncHandler(controller.adminGetDigitalMetalDocumentDownloadUrl)),
);

adminDigitalMetalsRouter.post(
  "/digital-metals/documents/:artifactId/retry",
  ...guarded(Permission.DIGITAL_METALS_READ, idempotent, asyncHandler(controller.adminRetryDigitalMetalDocument)),
);
