import {
  AuditEntityType,
  EcommerceCheckoutTaxPresentation,
  EcommerceStockPolicy,
} from "../constants/enums.js";
import { createId } from "../lib/ids.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { assertEcommerceCatalogWrite } from "../lib/ecommerce-access.js";
import {
  loadInventoryAvailability,
  sanitizeInventoryQuantity,
  sumActiveReservations,
} from "../lib/ecommerce-inventory.js";
import {
  deriveDeliveryConfigured,
  mapFulfilmentSettings,
  normalizePincodes,
} from "../lib/ecommerce-fulfilment.js";
import { evaluateCheckoutTaxReadiness, mapCheckoutReadiness } from "../lib/ecommerce-checkout-tax.js";
import { clampPendingPaymentWindowMinutes } from "../lib/ecommerce-pending-payment-policy.js";
import {
  Branch,
  EcommerceFulfilmentSettings,
  EcommerceInventory,
  EcommerceInventoryAdjustment,
  EcommerceProduct,
} from "../models/index.js";
import { writeAudit } from "./audit.service.js";
import { loadTaxSettings } from "./ecommerce.service.js";

function enforceVersion(doc, expectedVersion) {
  if (expectedVersion == null) return;
  if (Number(doc.version ?? 0) !== Number(expectedVersion)) {
    throw errors.conflict("VERSION_CONFLICT", "Record changed elsewhere. Refresh and retry.");
  }
}

async function loadOrCreateFulfilmentSettings(tenantId, session) {
  let row = await EcommerceFulfilmentSettings.findOne({ tenantId }).session(session);
  if (!row) {
    row = (
      await EcommerceFulfilmentSettings.create(
        [{ _id: createId("eful"), tenantId }],
        { session },
      )
    )[0];
  }
  return row;
}

async function assertProductOwned(tenantId, productId, session) {
  const product = await EcommerceProduct.findOne({ _id: productId, tenantId })
    .session(session)
    .lean();
  if (!product) throw errors.notFound("Product");
  return product;
}

function mapInventoryRow(product, inventory, availability) {
  return {
    productId: product._id,
    productName: product.name,
    sku: product.sku ?? "",
    status: product.status,
    stockPolicy: availability.stockPolicy,
    quantityOnHand: availability.quantityOnHand,
    reservedQuantity: availability.reservedQuantity,
    availableQuantity: availability.availableQuantity,
    inventoryId: inventory?._id ?? null,
    version: inventory?.version ?? 0,
  };
}

export async function listAdminInventory(req) {
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.productId) filter._id = req.query.productId;
  if (req.query.q) {
    filter.name = { $regex: String(req.query.q).trim(), $options: "i" };
  }
  const products = await EcommerceProduct.find(filter)
    .sort({ updatedAt: -1 })
    .limit(Math.min(Number(req.query.limit) || 50, 100))
    .lean();
  const productIds = products.map((p) => p._id);
  const inventories = productIds.length
    ? await EcommerceInventory.find({
      tenantId: req.auth.tenantId,
      productId: { $in: productIds },
    }).lean()
    : [];
  const invByProduct = new Map(inventories.map((i) => [i.productId, i]));
  const items = [];
  for (const product of products) {
    const availability = await loadInventoryAvailability(req.auth.tenantId, product._id);
    items.push(
      mapInventoryRow(product, invByProduct.get(product._id), availability),
    );
  }
  return { items };
}

export async function getAdminInventoryProduct(req) {
  const product = await assertProductOwned(req.auth.tenantId, req.params.productId);
  const inventory = await EcommerceInventory.findOne({
    tenantId: req.auth.tenantId,
    productId: product._id,
  }).lean();
  const availability = await loadInventoryAvailability(req.auth.tenantId, product._id);
  return mapInventoryRow(product, inventory, availability);
}

export async function patchAdminInventoryProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    const product = await assertProductOwned(
      req.auth.tenantId,
      req.params.productId,
      session,
    );
    const policy = req.body.stockPolicy ?? EcommerceStockPolicy.MADE_TO_ORDER;
    if (!Object.values(EcommerceStockPolicy).includes(policy)) {
      throw errors.validation([{ field: "stockPolicy", message: "Invalid stock policy." }]);
    }
    let row = await EcommerceInventory.findOne({
      tenantId: req.auth.tenantId,
      productId: product._id,
    }).session(session);
    if (!row) {
      row = (
        await EcommerceInventory.create(
          [
            {
              _id: createId("einv"),
              tenantId: req.auth.tenantId,
              productId: product._id,
              stockPolicy: policy,
              quantityOnHand: policy === EcommerceStockPolicy.QUANTITY_TRACKED ? 0 : null,
              reservedQuantity: 0,
            },
          ],
          { session },
        )
      )[0];
    } else {
      enforceVersion(row, req.body.expectedVersion);
    }
    row.stockPolicy = policy;
    if (policy === EcommerceStockPolicy.MADE_TO_ORDER) {
      row.quantityOnHand = null;
      row.reservedQuantity = 0;
    } else if (row.quantityOnHand == null) {
      row.quantityOnHand = 0;
    }
    if (req.body.quantityOnHand != null && policy === EcommerceStockPolicy.QUANTITY_TRACKED) {
      const nextOnHand = sanitizeInventoryQuantity(req.body.quantityOnHand);
      const reserved = await sumActiveReservations(req.auth.tenantId, product._id, session);
      if (nextOnHand - reserved < 0) {
        throw new AppError(
          "VALIDATION_FAILED",
          "On-hand quantity cannot fall below active reservations.",
          422,
          { reserved },
        );
      }
      row.quantityOnHand = nextOnHand;
    }
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: "ECOMMERCE_INVENTORY_UPDATED",
      entityType: AuditEntityType.ECOMMERCE_INVENTORY,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    const availability = await loadInventoryAvailability(req.auth.tenantId, product._id, session);
    return mapInventoryRow(product, row.toObject(), availability);
  });
}

export async function adjustAdminInventoryProduct(req) {
  assertEcommerceCatalogWrite(req.tenant);
  const delta = Number(req.body.deltaQuantity);
  if (!Number.isInteger(delta) || delta === 0) {
    throw errors.validation([{ field: "deltaQuantity", message: "Provide a non-zero integer adjustment." }]);
  }
  return withTransaction(async (session) => {
    const product = await assertProductOwned(
      req.auth.tenantId,
      req.params.productId,
      session,
    );
    let row = await EcommerceInventory.findOne({
      tenantId: req.auth.tenantId,
      productId: product._id,
    }).session(session);
    if (!row || row.stockPolicy !== EcommerceStockPolicy.QUANTITY_TRACKED) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Adjustments apply only to quantity-tracked products.",
        422,
      );
    }
    enforceVersion(row, req.body.expectedVersion);
    const before = row.quantityOnHand ?? 0;
    const after = before + delta;
    if (after < 0) {
      throw new AppError("VALIDATION_FAILED", "Adjustment would make on-hand quantity negative.", 422);
    }
    const reserved = await sumActiveReservations(req.auth.tenantId, product._id, session);
    if (after - reserved < 0) {
      throw new AppError(
        "VALIDATION_FAILED",
        "Adjustment would make available quantity negative.",
        422,
        { reserved },
      );
    }
    const updated = await EcommerceInventory.findOneAndUpdate(
      { _id: row._id, tenantId: req.auth.tenantId, version: row.version },
      { $inc: { quantityOnHand: delta, version: 1 } },
      { new: true, session },
    );
    if (!updated) {
      throw errors.conflict("VERSION_CONFLICT", "Inventory changed elsewhere. Refresh and retry.");
    }
    await EcommerceInventoryAdjustment.create(
      [
        {
          _id: createId("einvadj"),
          tenantId: req.auth.tenantId,
          productId: product._id,
          inventoryId: updated._id,
          deltaQuantity: delta,
          quantityOnHandBefore: before,
          quantityOnHandAfter: updated.quantityOnHand,
          reason: String(req.body.reason ?? "").trim().slice(0, 500),
          actorUserId: req.auth.id,
        },
      ],
      { session },
    );
    await writeAudit({
      req,
      action: "ECOMMERCE_INVENTORY_ADJUSTED",
      entityType: AuditEntityType.ECOMMERCE_INVENTORY,
      entityId: updated._id,
      changes: [{ field: "quantityOnHand", from: before, to: updated.quantityOnHand }],
      session,
    });
    const availability = await loadInventoryAvailability(req.auth.tenantId, product._id, session);
    return mapInventoryRow(product, updated.toObject(), availability);
  });
}

async function validatePickupBranches(tenantId, branchIds, session) {
  if (!branchIds.length) return [];
  const rows = await Branch.find({
    tenantId,
    _id: { $in: branchIds },
    active: { $ne: false },
  })
    .session(session)
    .lean();
  if (rows.length !== branchIds.length) {
    throw errors.validation([{ field: "pickupBranchIds", message: "One or more branches are invalid." }]);
  }
  return rows;
}

export async function getAdminFulfilmentSettings(req) {
  const row = await loadOrCreateFulfilmentSettings(req.auth.tenantId);
  const taxSettings = await loadTaxSettings(req.auth.tenantId);
  const mapped = mapFulfilmentSettings(row.toObject());
  return {
    ...mapped,
    checkoutReadiness: mapCheckoutReadiness(taxSettings, row.toObject()),
  };
}

export async function putAdminFulfilmentSettings(req) {
  assertEcommerceCatalogWrite(req.tenant);
  return withTransaction(async (session) => {
    const row = await loadOrCreateFulfilmentSettings(req.auth.tenantId, session);
    enforceVersion(row, req.body.expectedVersion);
    const patch = { ...req.body };
    delete patch.expectedVersion;
    if (patch.pickupBranchIds) {
      patch.pickupBranchIds = [...new Set(patch.pickupBranchIds.map(String))];
      await validatePickupBranches(req.auth.tenantId, patch.pickupBranchIds, session);
    }
    if (patch.serviceablePincodes) {
      patch.serviceablePincodes = normalizePincodes(patch.serviceablePincodes);
    }
    if (patch.deliveryChargePaise != null) {
      patch.deliveryChargePaise = sanitizeInventoryQuantity(patch.deliveryChargePaise);
    }
    if (patch.pendingPaymentWindowMinutes != null) {
      patch.pendingPaymentWindowMinutes = clampPendingPaymentWindowMinutes(
        patch.pendingPaymentWindowMinutes,
      );
    }
    if (patch.checkoutTaxConfig) {
      const cfg = { ...(row.checkoutTaxConfig?.toObject?.() ?? row.checkoutTaxConfig ?? {}), ...patch.checkoutTaxConfig };
      if (cfg.componentLines) {
        cfg.componentLines = cfg.componentLines.map((line) => ({
          componentKey: String(line.componentKey ?? "").trim(),
          label: String(line.label ?? "").trim(),
          rateBps: Number(line.rateBps),
        }));
      }
      if (cfg.componentRules) {
        cfg.componentRules = cfg.componentRules.map((rule) => ({
          supplyCase: rule.supplyCase,
          componentLines: (rule.componentLines ?? []).map((line) => ({
            componentKey: String(line.componentKey ?? "").trim(),
            label: String(line.label ?? "").trim(),
            rateBps: Number(line.rateBps),
          })),
        }));
      }
      if (cfg.supportedDestinationStates) {
        cfg.supportedDestinationStates = cfg.supportedDestinationStates.map((s) => String(s).trim());
      }
      if (cfg.sellerGstin) cfg.sellerGstin = String(cfg.sellerGstin).trim().toUpperCase();
      if (cfg.accountantApprovedAt) {
        cfg.accountantApprovedAt = new Date(cfg.accountantApprovedAt);
      }
      patch.checkoutTaxConfig = cfg;
    }
    Object.assign(row, patch);
    if (row.deliveryEnabled && !deriveDeliveryConfigured(row)) {
      row.deliveryEnabled = false;
    }
    row.version += 1;
    await row.save({ session });
    await writeAudit({
      req,
      action: "ECOMMERCE_FULFILMENT_SETTINGS_UPDATED",
      entityType: AuditEntityType.ECOMMERCE_FULFILMENT_SETTINGS,
      entityId: row._id,
      after: row.toObject(),
      session,
    });
    const taxSettings = await loadTaxSettings(req.auth.tenantId);
    const mapped = mapFulfilmentSettings(row.toObject());
    return {
      ...mapped,
      checkoutReadiness: mapCheckoutReadiness(taxSettings, row.toObject()),
    };
  });
}

export { evaluateCheckoutTaxReadiness, EcommerceCheckoutTaxPresentation };
