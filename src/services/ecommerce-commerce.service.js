import { createId } from "../lib/ids.js";
import { errors } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceOperational } from "../lib/ecommerce-access.js";
import {
  loadInventoryAvailability,
  mapPublicAvailability,
} from "../lib/ecommerce-inventory.js";
import {
  customerFulfilmentOptions,
  mapFulfilmentSettings,
} from "../lib/ecommerce-fulfilment.js";
import { mapCheckoutReadiness } from "../lib/ecommerce-checkout-tax.js";
import {
  Branch,
  EcommerceCart,
  EcommerceCustomerAddress,
  EcommerceFulfilmentSettings,
  EcommerceProduct,
} from "../models/index.js";
import { EcommerceProductStatus, EcommerceStockPolicy } from "../constants/enums.js";
import { loadTaxSettings } from "./ecommerce.service.js";

function mapAddress(row) {
  return {
    id: row._id,
    label: row.label,
    recipientName: row.recipientName ?? "",
    mobile: row.mobile ?? "",
    line1: row.line1,
    line2: row.line2 ?? "",
    city: row.city,
    state: row.state,
    pincode: row.pincode,
    isDefault: row.isDefault === true,
    version: row.version ?? 1,
  };
}

export async function listCustomerAddresses(req) {
  assertEcommerceOperational(req.tenant);
  const rows = await EcommerceCustomerAddress.find({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  })
    .sort({ isDefault: -1, updatedAt: -1 })
    .lean();
  return { items: rows.map(mapAddress) };
}

export async function createCustomerAddress(req) {
  assertEcommerceOperational(req.tenant);
  return withTransaction(async (session) => {
    if (req.body.isDefault === true) {
      await EcommerceCustomerAddress.updateMany(
        { tenantId: req.auth.tenantId, customerId: req.auth.id },
        { $set: { isDefault: false } },
        { session },
      );
    }
    const row = (
      await EcommerceCustomerAddress.create(
        [
          {
            _id: createId("eaddr"),
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            label: req.body.label ?? "Home",
            recipientName: req.body.recipientName ?? "",
            mobile: req.body.mobile ?? "",
            line1: req.body.line1,
            line2: req.body.line2 ?? "",
            city: req.body.city,
            state: req.body.state,
            pincode: req.body.pincode,
            isDefault: req.body.isDefault === true,
          },
        ],
        { session },
      )
    )[0];
    return mapAddress(row.toObject());
  });
}

export async function patchCustomerAddress(req) {
  assertEcommerceOperational(req.tenant);
  return withTransaction(async (session) => {
    const row = await EcommerceCustomerAddress.findOne({
      _id: req.params.addressId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!row) throw errors.notFound("Address");
    if (req.body.expectedVersion != null && row.version !== Number(req.body.expectedVersion)) {
      throw errors.conflict("VERSION_CONFLICT", "Address changed elsewhere.");
    }
    if (req.body.isDefault === true) {
      await EcommerceCustomerAddress.updateMany(
        { tenantId: req.auth.tenantId, customerId: req.auth.id, _id: { $ne: row._id } },
        { $set: { isDefault: false } },
        { session },
      );
    }
    const patch = { ...req.body };
    delete patch.expectedVersion;
    Object.assign(row, patch);
    row.version += 1;
    await row.save({ session });
    return mapAddress(row.toObject());
  });
}

async function loadOrCreateCart(tenantId, customerId, session) {
  let cart = await EcommerceCart.findOne({ tenantId, customerId }).session(session);
  if (!cart) {
    cart = (
      await EcommerceCart.create(
        [{ _id: createId("ecart"), tenantId, customerId, lines: [] }],
        { session },
      )
    )[0];
  }
  return cart;
}

function mapCart(cart, productMap, availabilityMap) {
  return {
    id: cart._id,
    checkoutUsable: false,
    lines: (cart.lines ?? []).map((line) => {
      const product = productMap.get(line.productId);
      const availability = availabilityMap.get(line.productId);
      return {
        productId: line.productId,
        quantity: line.quantity,
        product: product
          ? { id: product._id, name: product.name, slug: product.slug, status: product.status }
          : null,
        availability: availability ? mapPublicAvailability(availability) : null,
      };
    }),
    version: cart.version ?? 1,
  };
}

async function loadFulfilmentSettingsLean(tenantId) {
  let row = await EcommerceFulfilmentSettings.findOne({ tenantId }).lean();
  if (!row) {
    row = {
      _id: createId("eful"),
      tenantId,
      pickupEnabled: false,
      pickupBranchIds: [],
      deliveryEnabled: false,
      serviceablePincodes: [],
      checkoutTaxConfig: {},
      version: 1,
    };
  }
  return row;
}

export async function getCustomerCart(req) {
  assertEcommerceOperational(req.tenant);
  const cart = await loadOrCreateCart(req.auth.tenantId, req.auth.id);
  const productIds = (cart.lines ?? []).map((l) => l.productId);
  const products = productIds.length
    ? await EcommerceProduct.find({
      tenantId: req.auth.tenantId,
      _id: { $in: productIds },
    }).lean()
    : [];
  const productMap = new Map(products.map((p) => [p._id, p]));
  const availabilityMap = new Map();
  for (const id of productIds) {
    availabilityMap.set(id, await loadInventoryAvailability(req.auth.tenantId, id));
  }
  return mapCart(cart.toObject(), productMap, availabilityMap);
}

export async function shopFulfilmentOptions(req) {
  assertEcommerceOperational(req.tenant);
  const settings = await loadFulfilmentSettingsLean(req.auth.tenantId);
  const mapped = mapFulfilmentSettings(settings);
  const branches = mapped.pickupBranchIds.length
    ? await Branch.find({
      tenantId: req.auth.tenantId,
      _id: { $in: mapped.pickupBranchIds },
      active: { $ne: false },
    })
      .select("_id name code")
      .lean()
    : [];
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  return {
    ...customerFulfilmentOptions(settings, branches.map((b) => ({ ...b, id: b._id }))),
    checkoutReadiness: mapCheckoutReadiness(taxSettings, settings),
  };
}

export async function putCustomerCart(req) {
  assertEcommerceOperational(req.tenant);
  const lines = Array.isArray(req.body.lines) ? req.body.lines : [];
  return withTransaction(async (session) => {
    const cart = await loadOrCreateCart(req.auth.tenantId, req.auth.id, session);
    if (req.body.expectedVersion != null && cart.version !== Number(req.body.expectedVersion)) {
      throw errors.conflict("VERSION_CONFLICT", "Cart changed elsewhere.");
    }
    const normalized = [];
    for (const line of lines) {
      const productId = String(line.productId ?? "").trim();
      const quantity = Math.max(1, Math.min(99, Number(line.quantity) || 1));
      if (!productId) continue;
      const product = await EcommerceProduct.findOne({
        _id: productId,
        tenantId: req.auth.tenantId,
        status: EcommerceProductStatus.PUBLISHED,
      }).session(session);
      if (!product) {
        throw errors.validation([{ field: "lines", message: `Product ${productId} is not available.` }]);
      }
      const availability = await loadInventoryAvailability(
        req.auth.tenantId,
        productId,
        session,
      );
      if (
        availability.stockPolicy === EcommerceStockPolicy.QUANTITY_TRACKED
        && quantity > (availability.availableQuantity ?? 0)
      ) {
        throw errors.business(
          "INSUFFICIENT_STOCK",
          `Only ${availability.availableQuantity ?? 0} units available for ${product.name}.`,
          { productId, availableQuantity: availability.availableQuantity ?? 0, requested: quantity },
        );
      }
      normalized.push({ productId, quantity, addedAt: new Date() });
    }
    cart.lines = normalized;
    cart.version += 1;
    await cart.save({ session });
    const productMap = new Map(
      (
        await EcommerceProduct.find({
          tenantId: req.auth.tenantId,
          _id: { $in: normalized.map((l) => l.productId) },
        })
          .session(session)
          .lean()
      ).map((p) => [p._id, p]),
    );
    const availabilityMap = new Map();
    for (const line of normalized) {
      availabilityMap.set(
        line.productId,
        await loadInventoryAvailability(req.auth.tenantId, line.productId, session),
      );
    }
    return mapCart(cart.toObject(), productMap, availabilityMap);
  });
}
