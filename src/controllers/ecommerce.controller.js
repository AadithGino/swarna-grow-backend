import { sendList, sendSuccess } from "../lib/response.js";
import * as reporting from "../services/reporting.service.js";
import * as ecommerceWorkspaceSummary from "../services/ecommerce-workspace-summary.service.js";
import * as ecommerceAdminOrderReturns from "../services/ecommerce-admin-order-returns.service.js";
import * as ecommerce from "../services/ecommerce.service.js";
import * as ecommerceCommerce from "../services/ecommerce-commerce.service.js";
import * as ecommerceAdminCommerce from "../services/ecommerce-admin-commerce.service.js";
import * as ecommerceQuote from "../services/ecommerce-quote.service.js";
import * as ecommerceOrder from "../services/ecommerce-order.service.js";
import * as ecommercePayment from "../services/ecommerce-payment-intent.service.js";
import * as ecommerceExceptionRefund from "../services/ecommerce-payment-exception-refund.service.js";
import * as ecommerceFulfilment from "../services/ecommerce-order-fulfilment.service.js";
import * as ecommerceCodOrder from "../services/ecommerce-cod-order.service.js";
import * as ecommerceOperator from "../services/ecommerce-payment-operator.service.js";
import * as ecommerceOrderInvoice from "../services/ecommerce-order-invoice.service.js";
import * as ecommerceOrderCancellation from "../services/ecommerce-order-cancellation.service.js";
import * as ecommerceOrderDelivery from "../services/ecommerce-order-delivery.service.js";
import * as ecommerceOrderReturn from "../services/ecommerce-order-return.service.js";
import * as ecommerceAdminCustomerOrders from "../services/ecommerce-admin-customer-orders.service.js";
import * as ecommerceCodCustody from "../services/ecommerce-cod-custody.service.js";
import * as ecommerceOrderHandover from "../services/ecommerce-order-handover.service.js";

export const storeStatus = async (req, res) =>
  sendSuccess(res, await ecommerce.getStoreStatus(req));

export const listCategories = async (req, res) =>
  sendSuccess(res, await ecommerce.listCategories(req));

export const createCategory = async (req, res) =>
  sendSuccess(res, await ecommerce.createCategory(req), {}, 201);

export const getCategory = async (req, res) =>
  sendSuccess(res, await ecommerce.getCategory(req));

export const patchCategory = async (req, res) =>
  sendSuccess(res, await ecommerce.patchCategory(req));

export const archiveCategory = async (req, res) =>
  sendSuccess(res, await ecommerce.archiveCategory(req));

export const listProducts = async (req, res) =>
  sendSuccess(res, await ecommerce.listProducts(req));

export const createProduct = async (req, res) =>
  sendSuccess(res, await ecommerce.createProduct(req), {}, 201);

export const getProduct = async (req, res) =>
  sendSuccess(res, await ecommerce.getProduct(req));

export const patchProduct = async (req, res) =>
  sendSuccess(res, await ecommerce.patchProduct(req));

export const publishProduct = async (req, res) =>
  sendSuccess(res, await ecommerce.publishProduct(req));

export const archiveProduct = async (req, res) =>
  sendSuccess(res, await ecommerce.archiveProduct(req));

export const previewProductPrice = async (req, res) =>
  sendSuccess(res, await ecommerce.previewProductPrice(req));

export const setGoldRate = async (req, res) =>
  sendSuccess(res, await ecommerce.setEcommerceGoldRate(req), {}, 201);

export const goldRateHistory = async (req, res) =>
  sendSuccess(res, await ecommerce.listEcommerceGoldRates(req));

export const goldRatesCurrent = async (req, res) =>
  sendSuccess(res, await ecommerce.getEcommerceGoldRatesCurrent(req));

export const taxSettings = async (req, res) =>
  sendSuccess(res, await ecommerce.getTaxSettings(req));

export const putTaxSettings = async (req, res) =>
  sendSuccess(res, await ecommerce.putTaxSettings(req));

export const shopAvailability = async (req, res) =>
  sendSuccess(res, await ecommerce.shopAvailability(req));

export const shopCategories = async (req, res) =>
  sendSuccess(res, await ecommerce.shopListCategories(req));

export const shopStorePolicies = async (req, res) =>
  sendSuccess(res, await ecommerce.shopGetStorePolicies(req));

export const shopProducts = async (req, res) =>
  sendSuccess(res, await ecommerce.shopListProducts(req));

export const shopProduct = async (req, res) =>
  sendSuccess(res, await ecommerce.shopGetProduct(req));

export const shopListAddresses = async (req, res) =>
  sendSuccess(res, await ecommerceCommerce.listCustomerAddresses(req));

export const shopCreateAddress = async (req, res) =>
  sendSuccess(res, await ecommerceCommerce.createCustomerAddress(req), {}, 201);

export const shopPatchAddress = async (req, res) =>
  sendSuccess(res, await ecommerceCommerce.patchCustomerAddress(req));

export const shopGetCart = async (req, res) =>
  sendSuccess(res, await ecommerceCommerce.getCustomerCart(req));

export const shopPutCart = async (req, res) =>
  sendSuccess(res, await ecommerceCommerce.putCustomerCart(req));

export const shopFulfilmentOptions = async (req, res) =>
  sendSuccess(res, await ecommerceCommerce.shopFulfilmentOptions(req));

export const shopCreateQuote = async (req, res) => {
  const result = await ecommerceQuote.createCustomerQuote(req);
  sendSuccess(res, result.quote, {}, result.created ? 201 : 200);
};

export const shopGetQuote = async (req, res) =>
  sendSuccess(res, await ecommerceQuote.getCustomerQuote(req));

export const shopCancelQuote = async (req, res) =>
  sendSuccess(res, await ecommerceQuote.cancelCustomerQuote(req));

export const shopCreateOrder = async (req, res) => {
  const result = await ecommerceOrder.createCustomerOrder(req);
  sendSuccess(res, result.order, {}, result.created ? 201 : 200);
};

export const shopListOrders = async (req, res) => {
  const result = await ecommerceOrder.listCustomerOrders(req);
  return sendList(res, { data: result.items, meta: result.meta });
};

export const shopGetOrder = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.getCustomerOrder(req));

export const shopOrderInvoicePdf = async (req, res) =>
  ecommerceOrderInvoice.streamCustomerOrderInvoice(req, res);

export const adminOrderInvoicePdf = async (req, res) =>
  ecommerceOrderInvoice.streamAdminOrderInvoice(req, res);

export const shopCancelOrder = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.cancelCustomerOrder(req));

export const shopGetOrderCancellation = async (req, res) =>
  sendSuccess(res, await ecommerceOrderCancellation.getCustomerOrderCancellation(req));

export const shopCreateCancellationRequest = async (req, res) => {
  const result = await ecommerceOrderCancellation.createCustomerCancellationRequest(req);
  sendSuccess(res, result, {}, result.created ? 201 : 200);
};

export const shopCreateReturnRequest = async (req, res) => {
  const result = await ecommerceOrderReturn.createCustomerReturnRequest(req);
  sendSuccess(res, result, {}, result.created ? 201 : 200);
};

export const shopGetOrderReturn = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.getCustomerOrderReturn(req));

export const patchOrderDeliveryTracking = async (req, res) =>
  sendSuccess(res, await ecommerceOrderDelivery.patchAdminOrderDeliveryTracking(req));

export const listReturnRequests = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.listAdminReturnRequests(req));

export const decideReturnRequest = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.decideAdminReturnRequest(req));

export const recordReturnReceived = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.recordAdminReturnReceived(req));

export const recordReturnInspection = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.recordAdminReturnInspection(req));

export const resolveReturnRequest = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.resolveAdminReturnRequest(req));

export const createReturnRefundCase = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.createAdminReturnRefundCase(req));

export const recordReturnManualRefund = async (req, res) =>
  sendSuccess(res, await ecommerceOrderReturn.recordAdminReturnManualRefund(req));

export const listCancellationRequests = async (req, res) =>
  sendSuccess(res, await ecommerceOrderCancellation.listAdminCancellationRequests(req));

export const getOrderCancellation = async (req, res) =>
  sendSuccess(res, await ecommerceOrderCancellation.getAdminOrderCancellation(req));

export const decideOrderCancellation = async (req, res) =>
  sendSuccess(res, await ecommerceOrderCancellation.decideAdminCancellationRequest(req));

export const adminInitiateOrderCancellation = async (req, res) =>
  sendSuccess(res, await ecommerceOrderCancellation.adminInitiateCancellation(req));

export const recordOrderCodCancellationManualRefund = async (req, res) =>
  sendSuccess(res, await ecommerceOrderCancellation.recordCodCancellationManualRefund(req));

export const shopCreateOrderPaymentIntent = async (req, res) => {
  const result = await ecommercePayment.createEcommercePaymentIntent(req);
  sendSuccess(res, result, {}, result.created ? 201 : 200);
};

export const shopGetOrderPaymentIntent = async (req, res) =>
  sendSuccess(res, { paymentIntent: await ecommercePayment.getEcommercePaymentIntent(req) });

export const shopCompleteTestHarnessPayment = async (req, res) => {
  const { completeTestHarnessShopPayment } = await import(
    "../services/ecommerce-test-payment-completion.service.js"
  );
  sendSuccess(res, await completeTestHarnessShopPayment(req));
};

export const listOrders = async (req, res) => {
  const result = await ecommerceOrder.listAdminOrders(req);
  return sendList(res, { data: result.items, meta: result.meta });
};

export const getEcommerceWorkspaceSummary = async (req, res) =>
  sendSuccess(res, await ecommerceWorkspaceSummary.getEcommerceWorkspaceSummary(req));

export const listOrderReturns = async (req, res) =>
  sendSuccess(res, await ecommerceAdminOrderReturns.listAdminOrderReturns(req));

export const ecommerceReport = async (req, res) => {
  const result = await reporting.report(req, req.params.reportKey);
  if (result?.meta) {
    const { meta, ...data } = result;
    return sendSuccess(res, data, meta);
  }
  return sendSuccess(res, result);
};

export const getOrder = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.getAdminOrder(req));

export const listOrderPaymentAttempts = async (req, res) =>
  sendSuccess(res, await ecommercePayment.listAdminOrderPaymentAttempts(req));

export const listOrderPaymentAttemptEvents = async (req, res) =>
  sendSuccess(res, await ecommercePayment.listAdminOrderPaymentAttemptEvents(req));

export const getOrderPaymentExceptionRefund = async (req, res) =>
  sendSuccess(res, await ecommerceExceptionRefund.getAdminPaymentExceptionRefund(req));

export const initiateOrderPaymentExceptionRefund = async (req, res) =>
  sendSuccess(res, await ecommerceExceptionRefund.initiateAdminPaymentExceptionRefund(req));

export const recordOrderPaymentExceptionRefundManual = async (req, res) =>
  sendSuccess(res, await ecommerceExceptionRefund.recordAdminPaymentExceptionRefundManual(req));

export const transitionOrderFulfilment = async (req, res) =>
  sendSuccess(res, await ecommerceFulfilment.transitionAdminOrderFulfilment(req));

export const acceptCodOrder = async (req, res) =>
  sendSuccess(res, await ecommerceCodOrder.acceptAdminCodOrder(req));

export const rejectCodOrder = async (req, res) =>
  sendSuccess(res, await ecommerceCodOrder.rejectAdminCodOrder(req));

export const recordCodCollection = async (req, res) =>
  sendSuccess(res, await ecommerceCodOrder.recordAdminCodCollection(req));

export const listPaymentExceptions = async (req, res) =>
  sendSuccess(res, await ecommerceExceptionRefund.listAdminPaymentExceptions(req));

export const listOrderEvents = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.listAdminOrderEvents(req));

export const getOrderPaymentAttemptProviderStatus = async (req, res) =>
  sendSuccess(res, await ecommerceOperator.getAdminPaymentAttemptProviderStatus(req));

export const retryOrderPaymentAttemptReconcile = async (req, res) =>
  sendSuccess(res, await ecommerceOperator.retryAdminPaymentAttemptReconcile(req));

export const acknowledgeOrderPaymentAttemptOperational = async (req, res) =>
  sendSuccess(res, await ecommerceOperator.acknowledgeAdminPaymentAttemptOperational(req));

export const listInventory = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCommerce.listAdminInventory(req));

export const getInventoryProduct = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCommerce.getAdminInventoryProduct(req));

export const patchInventoryProduct = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCommerce.patchAdminInventoryProduct(req));

export const adjustInventoryProduct = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCommerce.adjustAdminInventoryProduct(req));

export const getFulfilmentSettings = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCommerce.getAdminFulfilmentSettings(req));

export const putFulfilmentSettings = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCommerce.putAdminFulfilmentSettings(req));

export const listCustomerEcommerceOrders = async (req, res) => {
  const result = await ecommerceAdminCustomerOrders.listAdminCustomerEcommerceOrders(req);
  return sendList(res, { data: result.items, meta: result.meta });
};

export const getCustomerEcommerceOrdersMeta = async (req, res) =>
  sendSuccess(res, await ecommerceAdminCustomerOrders.getAdminCustomerEcommerceOrdersMeta(req));

export const getCodCustodySummary = async (req, res) =>
  sendSuccess(res, await ecommerceCodCustody.getCodCustodyWorkspaceSummary(req));

export const listCodCustodyOrders = async (req, res) => {
  const result = await ecommerceCodCustody.listCodCustodyOrders(req);
  return sendList(res, { data: result.items, meta: result.meta });
};

export const initiateCodCustodyHandover = async (req, res) =>
  sendSuccess(res, await ecommerceCodCustody.initiateCodCustodyHandover(req));

export const acceptCodCustodyHandover = async (req, res) =>
  sendSuccess(res, await ecommerceCodCustody.acceptCodCustodyHandover(req));

export const recordCodBankDeposit = async (req, res) =>
  sendSuccess(res, await ecommerceCodCustody.recordCodBankDeposit(req));

export const issuePickupCode = async (req, res) =>
  sendSuccess(res, await ecommerceOrderHandover.issueAdminPickupCode(req));

export const recordDeliveryHandover = async (req, res) =>
  sendSuccess(res, await ecommerceOrderHandover.recordAdminDeliveryHandover(req));

export const confirmPickupHandover = async (req, res) =>
  sendSuccess(res, await ecommerceOrderHandover.confirmCustomerPickupHandover(req));
