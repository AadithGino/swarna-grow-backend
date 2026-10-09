import { sendSuccess } from "../lib/response.js";
import * as ecommerce from "../services/ecommerce.service.js";

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
