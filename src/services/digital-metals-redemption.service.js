import { AppError, errors } from "../lib/app-error.js";
import {
  buildRedemptionChargePayload,
  CALCULATION_VERSION,
  isRateStale,
} from "../lib/digital-metals-quote-engine.js";
import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import {
  assertQuoteAssetReadiness,
  assertTenantTaxAndTerms,
  computeTaxProfileFingerprint,
  DEFAULT_DIGITAL_METAL_ASSETS,
  resolveAssetReadiness,
} from "../lib/digital-metals-readiness.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import { DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS } from "../models/digital-metals.models.js";
import {
  Branch,
  Customer,
  DigitalMetalQuote,
  DigitalMetalRedemptionCatalogItem,
  DigitalMetalRedemptionOrder,
  DigitalMetalTermsPublication,
  Tenant,
} from "../models/index.js";
import {
  assertQuotePrerequisites,
  latestSettings,
  loadNextFutureRate,
} from "./digital-metals-phase2.service.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { reserveWalletQuantity, releaseReservation } from "./digital-metals-ledger.service.js";
import {
  assertCustomerCanPlaceRedemption,
  assertCustomerCanPlaceRedemptionInSession,
} from "./digital-metals-risk-hold.service.js";
import { expireStaleRedemptionOrdersForTenant } from "./digital-metals-redemption-maintenance.service.js";
import { mapAdminCustomerBrief } from "../lib/digital-metals-admin-customer-brief.js";
import { applyAdminCustomerScopeFilter } from "../lib/digital-metals-admin-scope.js";
import { paginateByIdCursor } from "../lib/digital-metals-customer-order-access.js";
import { snapshotCustomerDeliveryAddress } from "../lib/customer-delivery-address.js";
import { resolveRedemptionDeliveryAddress } from "./digital-metals-delivery-address.service.js";

async function loadTenant(req) {
  return req.tenant ?? attachSubscriptionCatalogPlan(await Tenant.findById(req.auth.tenantId).lean());
}

function assertNewRedemptionAllowed(tenant) {
  const access = presentDigitalMetalsAccessState(tenant);
  if (!access.active) {
    throw new AppError(
      access.paused ? "DIGITAL_METALS_PAUSED" : "DIGITAL_METALS_DISABLED",
      access.paused ? "Digital metals trading is paused." : "Digital metals is not available.",
      403,
    );
  }
}

function mapCatalogItem(row) {
  return {
    id: row._id,
    sku: row.sku,
    label: row.label,
    metal: row.metal,
    finenessPpm: row.finenessPpm,
    unitQuantityUg: String(row.unitQuantityUg),
    mintingRule: row.mintingRule,
    mintingPercentBase: row.mintingPercentBase,
    deliveryFlatPaise: row.deliveryFlatPaise,
    deliveryWaiveAboveTotalChargePaise: row.deliveryWaiveAboveTotalChargePaise,
    packagingPaise: row.packagingPaise,
    taxLines: row.taxLines ?? [],
    leadTimeDays: row.leadTimeDays,
    pickupEnabled: row.pickupEnabled,
    deliveryEnabled: row.deliveryEnabled,
    active: row.active,
    imageUploadIds: row.imageUploadIds ?? [],
    version: row.version ?? 1,
  };
}

export function mapRedemptionOrder(row, extras = {}) {
  const snap = row.snapshot ?? {};
  return {
    id: row._id,
    status: row.status,
    customerId: row.customerId,
    metal: row.metal,
    finenessPpm: row.finenessPpm,
    quantityUg: String(row.quantityUg),
    unitCount: row.unitCount,
    chargeTotalPaise: row.chargeTotalPaise,
    fulfilmentMode: row.fulfilmentMode,
    pickupBranchId: row.pickupBranchId,
    pickupBranchLabel: snap.pickupBranchLabel ?? null,
    catalogueItemId: row.catalogueItemId ?? null,
    deliveryAddressSnapshot: row.deliveryAddressSnapshot ?? null,
    snapshot: row.snapshot ?? null,
    quoteExpiresAt: row.quoteExpiresAt,
    chargePaymentExpiresAt: row.chargePaymentExpiresAt,
    chargePaidAt: row.chargePaidAt ?? null,
    createdAt: row.createdAt ?? null,
    updatedAt: row.updatedAt ?? null,
    version: row.version ?? 1,
    ...extras,
  };
}

async function attachCustomersToRedemptionDtos(tenantId, rows) {
  const customerIds = [...new Set(rows.map((r) => r.customerId).filter(Boolean))];
  const customers = customerIds.length
    ? await Customer.find({ tenantId, _id: { $in: customerIds } }).lean()
    : [];
  const byId = new Map(customers.map((c) => [c._id, c]));
  return rows.map((row) => ({
    ...row,
    customer: mapAdminCustomerBrief(byId.get(row.customerId)),
  }));
}

export async function listCustomerRedemptionCatalogue(req) {
  const items = await DigitalMetalRedemptionCatalogItem.find({
    tenantId: req.auth.tenantId,
    active: true,
  })
    .sort({ label: 1 })
    .lean();
  return { items: items.map(mapCatalogItem) };
}

export async function listAdminRedemptionCatalogue(req) {
  const items = await DigitalMetalRedemptionCatalogItem.find({ tenantId: req.auth.tenantId })
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();
  return { items: items.map(mapCatalogItem) };
}

export async function createAdminRedemptionCatalogItem(req) {
  const pickupEnabled = req.body.pickupEnabled !== false;
  const deliveryEnabled = req.body.deliveryEnabled !== false;
  if (!pickupEnabled && !deliveryEnabled) {
    throw new AppError(
      "VALIDATION_FAILED",
      "At least one fulfilment method (pickup or delivery) must be enabled.",
      422,
    );
  }
  const row = await DigitalMetalRedemptionCatalogItem.create({
    _id: createId("dmrci"),
    tenantId: req.auth.tenantId,
    sku: String(req.body.sku).trim().toUpperCase(),
    label: String(req.body.label).trim(),
    metal: req.body.metal,
    finenessPpm: Number(req.body.finenessPpm),
    unitQuantityUg: Number(req.body.unitQuantityUg),
    mintingRule: req.body.mintingRule ?? { type: "FLAT_INR", amountPaise: 0 },
    mintingPercentBase: req.body.mintingPercentBase ?? "FIXED_DENOMINATION",
    deliveryFlatPaise: Number(req.body.deliveryFlatPaise ?? 0),
    deliveryWaiveAboveTotalChargePaise: req.body.deliveryWaiveAboveTotalChargePaise ?? null,
    packagingPaise: Number(req.body.packagingPaise ?? 0),
    taxLines: req.body.taxLines ?? [],
    leadTimeDays: Number(req.body.leadTimeDays ?? 3),
    pickupEnabled,
    deliveryEnabled,
    active: req.body.active !== false,
    imageUploadIds: (req.body.imageUploadIds ?? []).slice(0, 10),
  });
  return mapCatalogItem(row.toObject());
}

export async function patchAdminRedemptionCatalogItem(req) {
  const row = await DigitalMetalRedemptionCatalogItem.findOne({
    _id: req.params.itemId,
    tenantId: req.auth.tenantId,
  });
  if (!row) throw errors.notFound("Catalogue item");
  const fields = [
    "label",
    "active",
    "leadTimeDays",
    "pickupEnabled",
    "deliveryEnabled",
    "deliveryFlatPaise",
    "packagingPaise",
    "mintingRule",
    "taxLines",
    "imageUploadIds",
  ];
  for (const f of fields) {
    if (req.body[f] !== undefined) row[f] = req.body[f];
  }
  const pickupEnabled = row.pickupEnabled !== false;
  const deliveryEnabled = row.deliveryEnabled !== false;
  if (!pickupEnabled && !deliveryEnabled) {
    throw new AppError(
      "VALIDATION_FAILED",
      "At least one fulfilment method (pickup or delivery) must be enabled.",
      422,
    );
  }
  row.version = (row.version ?? 1) + 1;
  await row.save();
  return mapCatalogItem(row.toObject());
}

export async function createCustomerRedemptionQuote(req) {
  assertNewRedemptionAllowed(await loadTenant(req));
  await assertCustomerCanPlaceRedemption(req.auth.tenantId, req.auth.id);
  const tenant = await loadTenant(req);
  const item = await DigitalMetalRedemptionCatalogItem.findOne({
    _id: req.body.catalogueItemId,
    tenantId: req.auth.tenantId,
    active: true,
  }).lean();
  if (!item) throw new AppError("CATALOGUE_ITEM_DISABLED", "Denomination is not available.", 409);
  if (item.metal !== req.body.metal || item.finenessPpm !== Number(req.body.finenessPpm)) {
    throw errors.validation([{ field: "metal", message: "Metal/purity mismatch with catalogue item." }]);
  }
  const fulfilmentMode = req.body.fulfilmentMode;
  if (fulfilmentMode === "PICKUP" && !item.pickupEnabled) {
    throw new AppError("FULFILMENT_UNAVAILABLE", "Pickup is not offered for this item.", 409);
  }
  if (fulfilmentMode === "DELIVERY" && !item.deliveryEnabled) {
    throw new AppError("FULFILMENT_UNAVAILABLE", "Delivery is not offered for this item.", 409);
  }
  let pickupBranchId = null;
  let pickupBranchLabel = null;
  let deliveryAddressSnapshot = null;
  if (fulfilmentMode === "PICKUP") {
    pickupBranchId = String(req.body.pickupBranchId ?? "").trim();
    const branch = await Branch.findOne({
      _id: pickupBranchId,
      tenantId: req.auth.tenantId,
      active: true,
    }).lean();
    if (!branch) throw errors.notFound("Branch");
    pickupBranchLabel = branch.name ?? branch.code ?? pickupBranchId;
  } else if (fulfilmentMode === "DELIVERY") {
    const deliveryAddressId = String(req.body.deliveryAddressId ?? "").trim();
    const address = await resolveRedemptionDeliveryAddress(req, deliveryAddressId);
    deliveryAddressSnapshot = snapshotCustomerDeliveryAddress(address);
  }

  const { settings, rate } = await assertQuotePrerequisites(
    tenant,
    req.auth.tenantId,
    item.metal,
    item.finenessPpm,
  );
  assertQuoteAssetReadiness(
    resolveAssetReadiness({
      settings,
      effectiveRate: rate,
      futureRate: await loadNextFutureRate(req.auth.tenantId, item.metal, item.finenessPpm),
      metal: item.metal,
      finenessPpm: item.finenessPpm,
    }),
  );
  if (isRateStale(rate, settings.rateMaxAgeSeconds ?? DEFAULT_DIGITAL_METAL_RATE_MAX_AGE_SECONDS)) {
    throw new AppError("STALE_RATE", "Rate is stale; refresh and retry.", 409);
  }

  const metalValuePaisePerUnit = Math.round(
    (item.unitQuantityUg * rate.customerBuyRatePerGramPaise) / 1_000_000,
  );
  const taxLines = item.taxLines?.length ? item.taxLines : settings.taxLines;
  const core = buildRedemptionChargePayload({
    unitCount: req.body.unitCount,
    unitQuantityUg: item.unitQuantityUg,
    mintingRule: item.mintingRule,
    mintingPercentBase: item.mintingPercentBase,
    metalValuePaisePerUnit,
    packagingPaisePerUnit: item.packagingPaise,
    deliveryFlatPaise: item.deliveryFlatPaise,
    deliveryWaiveAboveTotalChargePaise: item.deliveryWaiveAboveTotalChargePaise,
    fulfilmentMode,
    taxLines,
  });

  const settingsRows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) => latestSettings(req.auth.tenantId, a.metal, a.finenessPpm)),
  );
  const taxFingerprint = computeTaxProfileFingerprint(settingsRows);
  const publication = tenant?.operations?.digitalMetalsTermsVersion
    ? await DigitalMetalTermsPublication.findOne({
        tenantId: req.auth.tenantId,
        termsVersion: tenant.operations.digitalMetalsTermsVersion,
      }).lean()
    : null;
  assertTenantTaxAndTerms(tenant, { taxFingerprint, termsPublication: publication });

  const ttlSeconds = settings.quoteTtlSeconds ?? 900;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const snapshot = {
    ...core,
    catalogueItemId: item._id,
    catalogueVersion: item.version ?? 1,
    fulfilmentMode,
    pickupBranchId,
    pickupBranchLabel,
    deliveryAddressId: deliveryAddressSnapshot?.id ?? null,
    deliveryAddressSnapshot,
    rateVersionId: rate._id,
    settingsVersionId: settings._id,
  };

  const quote = await DigitalMetalQuote.create({
    _id: createId("dmq"),
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    quoteSource: "CUSTOMER",
    side: "REDEMPTION",
    metal: item.metal,
    finenessPpm: item.finenessPpm,
    inputMode: "QUANTITY_UG",
    snapshot,
    expiresAt,
    settingsVersionId: settings._id,
    rateVersionId: rate._id,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    calculationVersion: CALCULATION_VERSION,
    taxProfileFingerprint: taxFingerprint,
    termsContentHash: tenant.operations.digitalMetalsTermsContentHash,
    createdBySubject: req.auth.id,
  });

  return {
    quoteId: quote._id,
    expiresAt: quote.expiresAt,
    ...snapshot,
    termsVersion: quote.termsVersion,
    termsContentHash: quote.termsContentHash,
    quantityReservedPreviewUg: String(core.quantityUg),
  };
}

export async function createRedemptionOrder(req) {
  assertNewRedemptionAllowed(await loadTenant(req));
  await assertCustomerCanPlaceRedemption(req.auth.tenantId, req.auth.id);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const existing = await DigitalMetalRedemptionOrder.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existing) return mapRedemptionOrder(existing);

  const quote = await DigitalMetalQuote.findOne({
    _id: req.body.quoteId,
    tenantId: req.auth.tenantId,
    side: "REDEMPTION",
    quoteSource: "CUSTOMER",
    customerId: req.auth.id,
  }).lean();
  if (!quote) throw errors.notFound("Quote");
  if (quote.consumedAt) throw new AppError("QUOTE_ALREADY_USED", "Quote was already accepted.", 409);
  if (new Date(quote.expiresAt).getTime() < Date.now()) {
    throw new AppError("QUOTE_EXPIRED", "Redemption quote has expired.", 409);
  }
  const snap = quote.snapshot ?? {};
  const quantityUg = Number(snap.quantityUg);
  const chargeTotalPaise = Number(snap.totalChargePaise ?? 0);
  const customer = await Customer.findOne({ _id: req.auth.id, tenantId: req.auth.tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");
  const settings = await latestSettings(req.auth.tenantId, quote.metal, quote.finenessPpm);
  const paymentWindowMs = (settings.quoteTtlSeconds ?? 900) * 1000;

  const order = await withTransaction(async (session) => {
    await assertCustomerCanPlaceRedemptionInSession(session, req.auth.tenantId, req.auth.id);
    const reserveKey = `${idempotencyKey}:reserve`;
    const reserved = await reserveWalletQuantity(session, {
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
      metal: quote.metal,
      finenessPpm: quote.finenessPpm,
      quantityUg,
      purpose: "REDEMPTION",
      idempotencyKey: reserveKey,
      holdingPeriodDays: settings.holdingPeriodDays ?? 0,
    });
    const orderId = createId("dmro");
    const chargePaymentExpiresAt = new Date(Date.now() + paymentWindowMs);
    const status = chargeTotalPaise === 0 ? "CHARGE_PAID" : "CHARGE_PENDING";
    const row = (
      await DigitalMetalRedemptionOrder.create(
        [
          {
            _id: orderId,
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            branchId: customer.branchId ?? null,
            quoteId: quote._id,
            catalogueItemId: snap.catalogueItemId,
            catalogueVersion: snap.catalogueVersion,
            reservationId: reserved.reservation._id,
            status,
            metal: quote.metal,
            finenessPpm: quote.finenessPpm,
            quantityUg,
            unitCount: snap.unitCount,
            chargeTotalPaise,
            snapshot: snap,
            fulfilmentMode: snap.fulfilmentMode,
            pickupBranchId: snap.pickupBranchId ?? null,
            deliveryAddressSnapshot: snap.deliveryAddressSnapshot ?? null,
            quoteExpiresAt: quote.expiresAt,
            chargePaymentExpiresAt,
            termsVersion: req.body.termsVersionAccepted,
            termsContentHash: req.body.termsContentHashAccepted,
            termsAcceptedAt: new Date(),
            chargePaidAt: chargeTotalPaise === 0 ? new Date() : null,
            idempotencyKey,
          },
        ],
        { session },
      )
    )[0];
    await DigitalMetalQuote.updateOne(
      { _id: quote._id, consumedAt: null },
      { $set: { consumedAt: new Date(), consumedByOrderId: orderId } },
      { session },
    );
    if (status === "CHARGE_PAID") {
      const { enqueueRedemptionCustomerNotice } = await import("../lib/digital-metals-customer-notice.js");
      await enqueueRedemptionCustomerNotice(session, {
        tenantId: req.auth.tenantId,
        orderId,
        customerId: req.auth.id,
        transition: "CHARGE_PAID",
        eventAt: row.chargePaidAt ?? new Date(),
      });
    }
    return row.toObject();
  });

  return mapRedemptionOrder(order, { zeroCharge: order.chargeTotalPaise === 0 });
}

export async function cancelRedemptionOrder(req) {
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Redemption order");
  if (order.status !== "CHARGE_PENDING") {
    throw new AppError("INVALID_STATE", "Only unpaid redemption orders can be cancelled.", 409);
  }
  await withTransaction(async (session) => {
    const locked = await DigitalMetalRedemptionOrder.findOne({
      _id: order._id,
      tenantId: order.tenantId,
      status: "CHARGE_PENDING",
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Order state changed.");
    const reserveKey = `${locked.idempotencyKey}:reserve`;
    await releaseReservation(session, locked.tenantId, reserveKey, `redemption-cancel:${locked._id}`);
    locked.status = "CANCELLED";
    await locked.save({ session });
  });
  const updated = await DigitalMetalRedemptionOrder.findById(order._id).lean();
  return mapRedemptionOrder(updated);
}

export async function getCustomerRedemptionOrder(req) {
  await expireStaleRedemptionOrdersForTenant(req.auth.tenantId, req.params.orderId);
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Redemption order");
  return mapRedemptionOrder(order);
}

export async function listAdminRedemptionOrders(req) {
  await expireStaleRedemptionOrdersForTenant(req.auth.tenantId);
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.status) filter.status = req.query.status;
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  if (cursor) filter._id = { $lt: cursor };
  const rows = await DigitalMetalRedemptionOrder.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  const mapped = items.map((o) => mapRedemptionOrder(o));
  return { items: await attachCustomersToRedemptionDtos(req.auth.tenantId, mapped), meta };
}

export async function getAdminRedemptionOrder(req) {
  const { getAdminFulfilmentOrder } = await import("./digital-metals-redemption-fulfilment.service.js");
  const fulfilmentStatuses = new Set([
    "CHARGE_PAID",
    "FULFILMENT_ACCEPTED",
    "PACKING",
    "DISPATCHED",
    "PICKUP_READY",
    "INVESTIGATION",
    "COMPLETED",
  ]);
  const order = await DigitalMetalRedemptionOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Redemption order");
  const cust = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  if (fulfilmentStatuses.has(order.status)) {
    return getAdminFulfilmentOrder(req);
  }
  const [enriched] = await attachCustomersToRedemptionDtos(req.auth.tenantId, [
    mapRedemptionOrder(order, { permittedActions: [] }),
  ]);
  return enriched;
}
