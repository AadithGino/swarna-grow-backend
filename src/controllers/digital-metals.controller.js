import { sendSuccess } from "../lib/response.js";
import * as digitalMetals from "../services/digital-metals.service.js";
import * as phase2 from "../services/digital-metals-phase2.service.js";
import * as ledger from "../services/digital-metals-ledger.service.js";
import * as phase4 from "../services/digital-metals-phase4.service.js";
import * as buyPayment from "../services/digital-metals-buy-payment.service.js";

export const adminCapability = async (req, res) =>
  sendSuccess(res, await digitalMetals.getAdminDigitalMetalsCapability(req));

export const adminWorkspace = async (req, res) =>
  sendSuccess(res, await digitalMetals.getAdminDigitalMetalsWorkspace(req));

export const customerCapability = async (req, res) =>
  sendSuccess(res, await digitalMetals.getCustomerDigitalMetalsCapability(req));

export const adminSettings = async (req, res) =>
  sendSuccess(res, await phase2.getDigitalMetalsSettings(req));

export const patchAdminSettings = async (req, res) =>
  sendSuccess(res, await phase2.patchDigitalMetalsSettings(req));

export const ratesCurrent = async (req, res) =>
  sendSuccess(res, await phase2.getDigitalMetalsRatesCurrent(req));

export const ratesHistory = async (req, res) =>
  sendSuccess(res, await phase2.listDigitalMetalsRatesHistory(req));

export const publishRate = async (req, res) =>
  sendSuccess(res, await phase2.publishDigitalMetalsRate(req), {}, 201);

export const quotePreview = async (req, res) =>
  sendSuccess(res, await phase2.previewDigitalMetalsQuote(req), {}, 201);

export const tenantPause = async (req, res) =>
  sendSuccess(res, await phase2.setTenantDigitalMetalsPause(req));

export const customerPortfolio = async (req, res) =>
  sendSuccess(res, await ledger.listCustomerPortfolio(req));

export const customerPassbook = async (req, res) =>
  sendSuccess(res, await ledger.listCustomerPassbook(req));

export const adminCustomerWallets = async (req, res) =>
  sendSuccess(res, await ledger.listAdminCustomerWallets(req));

export const adminCustomerPassbook = async (req, res) =>
  sendSuccess(res, await ledger.listAdminCustomerPassbook(req));

export const customerBuyQuote = async (req, res) =>
  sendSuccess(res, await phase4.createCustomerBuyQuote(req), {}, 201);

export const customerCreateBuyOrder = async (req, res) =>
  sendSuccess(res, await phase4.createBuyOrder(req), {}, 201);

export const customerGetBuyOrder = async (req, res) =>
  sendSuccess(res, await phase4.getCustomerBuyOrder(req));

export const customerCreateBuyPaymentIntent = async (req, res) =>
  sendSuccess(res, await phase4.createBuyOrderPaymentIntent(req), {}, 201);

export const customerGetBuyPaymentIntent = async (req, res) =>
  sendSuccess(res, await buyPayment.getBuyOrderPaymentIntent(req));

export const customerCompleteBuyTestHarnessPayment = async (req, res) =>
  sendSuccess(res, await buyPayment.completeTestHarnessBuyPayment(req));

export const adminListBuyOrders = async (req, res) =>
  sendSuccess(res, await phase4.listAdminBuyOrders(req));

export const adminGetBuyOrder = async (req, res) =>
  sendSuccess(res, await phase4.getAdminBuyOrder(req));

export const adminListPaymentExceptions = async (req, res) => {
  const svc = await import("../services/digital-metals-payment-exception.service.js");
  return sendSuccess(res, await svc.listAdminDigitalMetalPaymentExceptions(req));
};

export const adminGetBuyOrderRefund = async (req, res) => {
  const svc = await import("../services/digital-metals-payment-exception.service.js");
  return sendSuccess(res, await svc.getAdminDigitalMetalBuyOrderRefund(req));
};

export const adminInitiateBuyOrderRefund = async (req, res) => {
  const svc = await import("../services/digital-metals-payment-exception.service.js");
  return sendSuccess(res, await svc.initiateAdminDigitalMetalBuyOrderRefund(req));
};

export const customerStreamBuyOrderInvoice = async (req, res) => {
  const svc = await import("../services/digital-metals-invoice.service.js");
  return svc.streamCustomerDigitalMetalBuyInvoice(req, res);
};

export const adminStreamBuyOrderInvoice = async (req, res) => {
  const svc = await import("../services/digital-metals-invoice.service.js");
  return svc.streamAdminDigitalMetalBuyInvoice(req, res);
};

export const customerSellQuote = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.createCustomerSellQuote(req), {}, 201);
};

export const customerCreateSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.createSellOrder(req), {}, 201);
};

export const customerConfirmSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.confirmSellOrder(req));
};

export const customerCancelSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.cancelSellOrder(req));
};

export const customerGetSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.getCustomerSellOrder(req));
};

export const customerGetSellOrderPayoutStatus = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.getCustomerPayoutStatusForSellOrder(req));
};

export const customerListBankDestinations = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.listCustomerBankDestinations(req));
};

export const customerCreateBankDestination = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.createCustomerBankDestination(req), {}, 201);
};

export const customerPatchBankDestination = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.patchCustomerBankDestination(req));
};

export const adminListSellOrders = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.listAdminSellOrders(req));
};

export const adminGetSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.getAdminSellOrder(req));
};

export const adminApproveSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.adminApproveSellOrder(req));
};

export const adminCancelSellOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-sell.service.js");
  return sendSuccess(res, await svc.cancelSellOrder(req));
};

export const adminListCustomerBankDestinations = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.listAdminCustomerBankDestinations(req));
};

export const adminVerifyBankDestination = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.adminVerifyBankDestination(req));
};

export const adminDisableBankDestination = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.adminDisableBankDestination(req));
};

export const adminListBankVerificationQueue = async (req, res) => {
  const svc = await import("../services/digital-metals-bank-destination.service.js");
  return sendSuccess(res, await svc.listAdminBankVerificationQueue(req));
};

export const customerListBuyOrders = async (req, res) => {
  const svc = await import("../services/digital-metals-customer-orders.service.js");
  return sendSuccess(res, await svc.listCustomerBuyOrders(req));
};

export const customerListSellOrders = async (req, res) => {
  const svc = await import("../services/digital-metals-customer-orders.service.js");
  return sendSuccess(res, await svc.listCustomerSellOrders(req));
};

export const customerListRedemptionOrders = async (req, res) => {
  const svc = await import("../services/digital-metals-customer-orders.service.js");
  return sendSuccess(res, await svc.listCustomerRedemptionOrders(req));
};

export const customerOpenOrdersSummary = async (req, res) => {
  const svc = await import("../services/digital-metals-customer-orders.service.js");
  return sendSuccess(res, await svc.listCustomerOpenOrdersSummary(req));
};

export const adminListPayables = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.listAdminPayables(req));
};

export const adminListPayouts = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.listAdminPayouts(req));
};

export const adminCreatePayout = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.createPayoutInstruction(req), {}, 201);
};

export const adminApprovePayout = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.approvePayout(req));
};

export const adminSubmitPayout = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.submitPayout(req));
};

export const adminRecordPayoutSettlement = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.recordPayoutSettlement(req));
};

export const adminRecordPayoutFailure = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.recordPayoutFailure(req));
};

export const adminMarkPayoutUnknown = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.markPayoutUnknown(req));
};

export const adminResolveUnknownPayout = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.resolveUnknownPayout(req));
};

export const adminCreateRiskHold = async (req, res) => {
  const svc = await import("../services/digital-metals-risk-hold.service.js");
  return sendSuccess(res, await svc.createCustomerRiskHold(req), {}, 201);
};

export const adminResolveRiskHold = async (req, res) => {
  const svc = await import("../services/digital-metals-risk-hold.service.js");
  return sendSuccess(res, await svc.resolveCustomerRiskHold(req));
};

export const adminListRiskHolds = async (req, res) => {
  const svc = await import("../services/digital-metals-risk-hold.service.js");
  return sendSuccess(res, await svc.listAdminCustomerRiskHolds(req));
};

export const adminGetPayout = async (req, res) => {
  const svc = await import("../services/digital-metals-payout.service.js");
  return sendSuccess(res, await svc.getAdminPayout(req));
};

export const customerListDigitalMetalsDeliveryAddresses = async (req, res) => {
  const svc = await import("../services/digital-metals-delivery-address.service.js");
  return sendSuccess(res, await svc.listCustomerDigitalMetalsDeliveryAddresses(req));
};

export const customerCreateDigitalMetalsDeliveryAddress = async (req, res) => {
  const svc = await import("../services/digital-metals-delivery-address.service.js");
  return sendSuccess(res, await svc.createCustomerDigitalMetalsDeliveryAddress(req), {}, 201);
};

export const customerRedemptionCatalogue = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.listCustomerRedemptionCatalogue(req));
};

export const customerRedemptionQuote = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.createCustomerRedemptionQuote(req), {}, 201);
};

export const customerCreateRedemptionOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.createRedemptionOrder(req), {}, 201);
};

export const customerGetRedemptionOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.getCustomerRedemptionOrder(req));
};

export const customerCancelRedemptionOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.cancelRedemptionOrder(req));
};

export const customerCreateRedemptionPaymentIntent = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-payment.service.js");
  return sendSuccess(res, await svc.initiateRedemptionChargePayment(req), {}, 201);
};

export const customerCompleteRedemptionTestHarnessPayment = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-payment.service.js");
  return sendSuccess(res, await svc.completeRedemptionChargeTestHarnessPayment(req));
};

export const adminListRedemptionCatalogue = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.listAdminRedemptionCatalogue(req));
};

export const adminCreateRedemptionCatalogItem = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.createAdminRedemptionCatalogItem(req), {}, 201);
};

export const adminPatchRedemptionCatalogItem = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.patchAdminRedemptionCatalogItem(req));
};

export const adminListRedemptionOrders = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.listAdminRedemptionOrders(req));
};

export const adminGetRedemptionOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption.service.js");
  return sendSuccess(res, await svc.getAdminRedemptionOrder(req));
};

export const adminListRedemptionFulfilmentQueue = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.listAdminFulfilmentQueue(req));
};

export const adminAcceptRedemptionFulfilment = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.acceptFulfilment(req));
};

export const adminRecordRedemptionPacking = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.recordPacking(req));
};

export const adminRecordRedemptionDelay = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.recordProductionDelay(req));
};

export const adminDispatchRedemptionOrder = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.dispatchRedemptionOrder(req));
};

export const adminMarkRedemptionPickupReady = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.markPickupReady(req));
};

export const adminIssueRedemptionPickupCode = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.issuePickupCode(req));
};

export const adminCompleteRedemptionPickup = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.completePickupHandover(req));
};

export const adminCompleteRedemptionDelivery = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.completeDeliveryHandover(req));
};

export const adminCancelRedemptionPreDispatch = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.cancelPreDispatch(req));
};

export const adminOpenRedemptionInvestigation = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.openInvestigation(req));
};

export const adminResolveRedemptionReturn = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.resolveVerifiedReturn(req));
};

export const adminDispatchRedemptionReplacement = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.dispatchReplacementShipment(req));
};

export const adminListRedemptionChargeRefunds = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-refund.service.js");
  return sendSuccess(res, await svc.listAdminRedemptionChargeRefunds(req));
};

export const adminGetRedemptionChargeRefund = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-refund.service.js");
  return sendSuccess(res, await svc.getAdminRedemptionOrderChargeRefund(req));
};

export const adminInitiateRedemptionChargeRefund = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-refund.service.js");
  return sendSuccess(res, await svc.initiateAdminRedemptionChargeRefund(req));
};

export const adminRecordManualRedemptionChargeRefund = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-refund.service.js");
  return sendSuccess(res, await svc.recordManualRedemptionChargeRefund(req));
};

export const customerRedemptionFulfilmentProgress = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.getCustomerFulfilmentProgress(req));
};

export const customerRedemptionPickupReveal = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-fulfilment.service.js");
  return sendSuccess(res, await svc.customerRevealPickupCode(req));
};

export const customerPollRedemptionChargePayment = async (req, res) => {
  const svc = await import("../services/digital-metals-redemption-charge-payment.service.js");
  return sendSuccess(res, await svc.pollRedemptionChargePayment(req));
};

export const adminCreateProcurementEntry = async (req, res) => {
  const svc = await import("../services/digital-metals-procurement.service.js");
  return sendSuccess(res, await svc.createProcurementEntry(req), 201);
};

export const adminApproveProcurementEntry = async (req, res) => {
  const svc = await import("../services/digital-metals-procurement.service.js");
  return sendSuccess(res, await svc.approveProcurementEntry(req));
};

export const adminListProcurementEntries = async (req, res) => {
  const svc = await import("../services/digital-metals-procurement.service.js");
  return sendSuccess(res, await svc.listProcurementEntries(req));
};

export const adminGetProcurementEntry = async (req, res) => {
  const svc = await import("../services/digital-metals-procurement.service.js");
  return sendSuccess(res, await svc.getProcurementEntry(req));
};

export const adminGetLiveHedgeReport = async (req, res) => {
  const svc = await import("../services/digital-metals-hedge.service.js");
  return sendSuccess(res, await svc.getLiveHedgeReport(req));
};

export const adminCloseHedgeDay = async (req, res) => {
  const svc = await import("../services/digital-metals-hedge.service.js");
  return sendSuccess(res, await svc.closeHedgeDaySnapshot(req));
};

export const adminGetHedgeSnapshot = async (req, res) => {
  const svc = await import("../services/digital-metals-hedge.service.js");
  return sendSuccess(res, await svc.getHedgeSnapshot(req));
};

export const adminListInvalidatedHedgeSnapshots = async (req, res) => {
  const svc = await import("../services/digital-metals-hedge.service.js");
  return sendSuccess(res, await svc.listInvalidatedHedgeSnapshots(req));
};

export const customerMetalStatement = async (req, res) => {
  const svc = await import("../services/digital-metals-statement.service.js");
  return sendSuccess(res, await svc.buildCustomerMetalStatement(req));
};

export const customerMetalStatementPdf = async (req, res) => {
  const svc = await import("../services/digital-metals-statement.service.js");
  return svc.streamCustomerMetalStatementPdf(req, res);
};

export const customerRedemptionChargeReceipt = async (req, res) => {
  const svc = await import("../services/digital-metals-document.service.js");
  return svc.streamRedemptionChargeReceipt(req, res);
};

export const customerPhysicalHandoverReceipt = async (req, res) => {
  const svc = await import("../services/digital-metals-document.service.js");
  return svc.streamPhysicalHandoverReceipt(req, res);
};

export const customerSellAcknowledgement = async (req, res) => {
  const svc = await import("../services/digital-metals-document.service.js");
  return svc.streamSellAcknowledgement(req, res);
};

export const adminPayoutReceipt = async (req, res) => {
  const svc = await import("../services/digital-metals-document.service.js");
  return svc.streamPayoutReceipt(req, res);
};

export const adminRedemptionChargeReceipt = async (req, res) => {
  const svc = await import("../services/digital-metals-document.service.js");
  return svc.streamAdminRedemptionChargeReceipt(req, res);
};

export const adminPhysicalHandoverReceipt = async (req, res) => {
  const svc = await import("../services/digital-metals-document.service.js");
  return svc.streamAdminPhysicalHandoverReceipt(req, res);
};

export const adminRequestDigitalMetalDocument = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.requestDigitalMetalDocument(req), 202);
};

export const customerRequestDigitalMetalDocument = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.requestDigitalMetalDocument(req), 202);
};

export const adminGetDigitalMetalDocument = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.getDigitalMetalDocumentArtifact(req));
};

export const customerGetDigitalMetalDocument = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.getDigitalMetalDocumentArtifact(req));
};

export const adminFindDigitalMetalDocumentBySubject = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.findDigitalMetalDocumentBySubject(req));
};

export const customerFindDigitalMetalDocumentBySubject = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.findDigitalMetalDocumentBySubject(req));
};

export const adminGetDigitalMetalDocumentDownloadUrl = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.getDigitalMetalDocumentDownloadUrl(req));
};

export const customerGetDigitalMetalDocumentDownloadUrl = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.getDigitalMetalDocumentDownloadUrl(req));
};

export const adminRetryDigitalMetalDocument = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.retryDigitalMetalDocument(req));
};

export const customerRetryDigitalMetalDocument = async (req, res) => {
  const svc = await import("../services/digital-metals-document-artifact.service.js");
  return sendSuccess(res, await svc.retryDigitalMetalDocument(req));
};

export const platformDigitalMetalsHedgeHealth = async (req, res) => {
  const svc = await import("../services/digital-metals-hedge.service.js");
  return sendSuccess(res, await svc.getPlatformHedgeHealth(req));
};

export const adminDigitalMetalsWorkQueue = async (req, res) => {
  const svc = await import("../services/digital-metals-operations-visibility.service.js");
  return sendSuccess(res, await svc.getAdminDigitalMetalsWorkQueue(req));
};

export const adminRetryDigitalMetalsOutboxEvent = async (req, res) => {
  const svc = await import("../services/digital-metals-operations-visibility.service.js");
  return sendSuccess(res, await svc.retryAdminDigitalMetalsOutboxEvent(req));
};

export const adminRetryDigitalMetalsDocumentFromOps = async (req, res) => {
  const svc = await import("../services/digital-metals-operations-visibility.service.js");
  return sendSuccess(res, await svc.retryAdminDigitalMetalsDocumentArtifact(req));
};

export const platformDigitalMetalsOperationsSummary = async (req, res) => {
  const svc = await import("../services/digital-metals-operations-visibility.service.js");
  return sendSuccess(res, await svc.getPlatformDigitalMetalsOperationsSummary(req));
};
