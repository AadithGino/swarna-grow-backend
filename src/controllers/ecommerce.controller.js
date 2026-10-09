import { sendSuccess } from "../lib/response.js";
import * as ecommerce from "../services/ecommerce.service.js";
import * as ecommerceCommerce from "../services/ecommerce-commerce.service.js";
import * as ecommerceAdminCommerce from "../services/ecommerce-admin-commerce.service.js";
import * as ecommerceQuote from "../services/ecommerce-quote.service.js";
import * as ecommerceOrder from "../services/ecommerce-order.service.js";
import * as ecommercePayment from "../services/ecommerce-payment-intent.service.js";
import * as ecommerceExceptionRefund from "../services/ecommerce-payment-exception-refund.service.js";
import * as ecommerceFulfilment from "../services/ecommerce-order-fulfilment.service.js";
import * as ecommerceOperator from "../services/ecommerce-payment-operator.service.js";

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

export const shopListOrders = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.listCustomerOrders(req));

export const shopGetOrder = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.getCustomerOrder(req));

export const shopCancelOrder = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.cancelCustomerOrder(req));

export const shopCreateOrderPaymentIntent = async (req, res) => {
  const result = await ecommercePayment.createEcommercePaymentIntent(req);
  sendSuccess(res, result, {}, result.created ? 201 : 200);
};

export const shopGetOrderPaymentIntent = async (req, res) =>
  sendSuccess(res, { paymentIntent: await ecommercePayment.getEcommercePaymentIntent(req) });

export const listOrders = async (req, res) =>
  sendSuccess(res, await ecommerceOrder.listAdminOrders(req));

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
