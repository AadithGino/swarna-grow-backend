import { AppError, errors } from "../lib/app-error.js";
import {
  buildBuyQuotePayload,
  CALCULATION_VERSION,
} from "../lib/digital-metals-quote-engine.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import {
  assertTenantTaxAndTerms,
  computeTaxProfileFingerprint,
  DEFAULT_DIGITAL_METAL_ASSETS,
  resolveAssetReadiness,
  assertQuoteAssetReadiness,
} from "../lib/digital-metals-readiness.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import {
  Customer,
  DigitalMetalBuyOrder,
  DigitalMetalBuyPaymentAttempt,
  DigitalMetalQuote,
  DigitalMetalTermsPublication,
  Tenant,
} from "../models/index.js";
import {
  assertQuotePrerequisites,
  latestSettings,
  loadNextFutureRate,
} from "./digital-metals-phase2.service.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { applyAdminBuyOrderBranchFilter } from "../lib/digital-metals-admin-scope.js";
import { paginateByIdCursor } from "../lib/digital-metals-customer-order-access.js";
import { mapBuyOrderStatusDto } from "./digital-metals-buy-finalize.service.js";
import { initiateDigitalMetalBuyPaymentAttempt } from "./digital-metals-buy-payment.service.js";

async function loadTenant(req) {
  return req.tenant ?? attachSubscriptionCatalogPlan(await Tenant.findById(req.auth.tenantId).lean());
}

function assertNewBuyAllowed(tenant) {
  const access = presentDigitalMetalsAccessState(tenant);
  if (!access.active) {
    throw new AppError(
      access.paused ? "DIGITAL_METALS_PAUSED" : "DIGITAL_METALS_DISABLED",
      access.paused ? "Digital metals trading is paused." : "Digital metals is not available.",
      403,
    );
  }
}

async function buildCustomerBuyQuote(req) {
  assertNewBuyAllowed(await loadTenant(req));
  const tenant = await loadTenant(req);
  const { metal, finenessPpm } = req.body;
  const { settings, rate } = await assertQuotePrerequisites(
    tenant,
    req.auth.tenantId,
    metal,
    finenessPpm,
  );
  assertQuoteAssetReadiness(
    resolveAssetReadiness({
      settings,
      effectiveRate: rate,
      futureRate: await loadNextFutureRate(req.auth.tenantId, metal, finenessPpm),
      metal,
      finenessPpm,
    }),
  );
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

  const core = buildBuyQuotePayload({
    inputMode: req.body.inputMode,
    budgetPaise: req.body.budgetPaise,
    quantityUg: req.body.quantityUg,
    buyRatePerGramPaise: rate.customerBuyRatePerGramPaise,
    buyFeeRule: settings.buyFee,
    taxLines: settings.taxLines,
  });
  const ttlSeconds = settings.quoteTtlSeconds ?? 900;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const termsContentHash = tenant.operations.digitalMetalsTermsContentHash;
  const snapshot = {
    ...core,
    metalQuantityUg: String(core.quantityUg),
    feeLines: core.feePaise ? [{ code: "BUY_FEE", amountPaise: core.feePaise }] : [],
    taxLines: core.taxLines ?? [],
    totalPayablePaise: core.totalPayablePaise,
    budgetRemainderPaise: core.budgetRemainderPaise ?? 0,
    rateSnapshot: {
      buyRatePerGramPaise: rate.customerBuyRatePerGramPaise,
      rateVersionId: rate._id,
    },
    settingsVersion: settings.version,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    termsContentHash,
    taxProfileFingerprint: taxFingerprint,
    calculationVersion: CALCULATION_VERSION,
  };

  const quote = await DigitalMetalQuote.create({
    _id: createId("dmq"),
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    quoteSource: "CUSTOMER",
    side: "BUY",
    metal,
    finenessPpm,
    inputMode: req.body.inputMode,
    snapshot,
    expiresAt,
    settingsVersionId: settings._id,
    rateVersionId: rate._id,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    termsContentHash,
    taxProfileFingerprint: taxFingerprint,
    calculationVersion: CALCULATION_VERSION,
    createdBySubject: req.auth.id,
  });

  return {
    quoteId: quote._id,
    expiresAt: quote.expiresAt,
    metal,
    finenessPpm,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    termsContentHash,
    ...snapshot,
  };
}

export async function createCustomerBuyQuote(req) {
  return buildCustomerBuyQuote(req);
}

export async function createBuyOrder(req) {
  const tenant = await loadTenant(req);
  assertNewBuyAllowed(tenant);
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const { quoteId, termsVersionAccepted, termsContentHashAccepted } = req.body;
  const termsAcceptedAt = new Date();

  const existing = await DigitalMetalBuyOrder.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  if (existing) {
    const attempts = await DigitalMetalBuyPaymentAttempt.find({
      tenantId: req.auth.tenantId,
      orderId: existing._id,
    }).lean();
    return mapBuyOrderStatusDto(existing, attempts);
  }

  const quote = await DigitalMetalQuote.findOne({
    _id: quoteId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!quote) throw errors.notFound("Quote");
  if (quote.quoteSource !== "CUSTOMER") {
    throw new AppError("QUOTE_NOT_EXECUTABLE", "Admin preview quotes cannot be used for purchase.", 422);
  }
  if (String(quote.customerId) !== String(req.auth.id)) {
    throw errors.forbidden("This quote belongs to another customer.");
  }
  if (quote.consumedAt) {
    throw errors.conflict("QUOTE_ALREADY_USED", "Quote was already accepted.", { orderId: quote.consumedByOrderId });
  }
  if (new Date(quote.expiresAt).getTime() < Date.now()) {
    throw new AppError("QUOTE_EXPIRED", "Quote has expired. Request a new quote.", 409);
  }

  const settingsRows = await Promise.all(
    DEFAULT_DIGITAL_METAL_ASSETS.map((a) => latestSettings(req.auth.tenantId, a.metal, a.finenessPpm)),
  );
  const taxFingerprint = computeTaxProfileFingerprint(settingsRows);
  if (taxFingerprint !== quote.taxProfileFingerprint) {
    throw new AppError("TAX_CONFIG_INCOMPLETE", "Tax approval no longer matches this quote.", 422);
  }
  const publication = quote.termsVersion
    ? await DigitalMetalTermsPublication.findOne({
        tenantId: req.auth.tenantId,
        termsVersion: quote.termsVersion,
      }).lean()
    : null;
  assertTenantTaxAndTerms(tenant, { taxFingerprint, termsPublication: publication });
  if (
    String(termsVersionAccepted) !== String(quote.termsVersion)
    || String(termsContentHashAccepted) !== String(quote.termsContentHash)
  ) {
    throw new AppError("TERMS_NOT_ACCEPTED", "Customer must accept the published terms snapshot.", 422);
  }

  const customer = await Customer.findOne({ _id: req.auth.id, tenantId: req.auth.tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");

  const snapshot = quote.snapshot ?? {};
  const quantityUg = Number(snapshot.quantityUg ?? snapshot.metalQuantityUg);
  const totalPayablePaise = Number(snapshot.totalPayablePaise);
  if (!Number.isSafeInteger(quantityUg) || quantityUg <= 0) {
    throw new AppError("INVALID_QUOTE", "Quote snapshot is invalid.", 422);
  }

  const orderId = createId("dmbo");
  let order;
  try {
    order = await withTransaction(async (session) => {
      const consumed = await DigitalMetalQuote.findOneAndUpdate(
        {
          _id: quote._id,
          tenantId: req.auth.tenantId,
          consumedAt: null,
        },
        {
          $set: { consumedAt: termsAcceptedAt, consumedByOrderId: orderId },
        },
        { session, new: true },
      );
      if (!consumed) {
        throw errors.conflict("QUOTE_ALREADY_USED", "Quote was already accepted.");
      }
      const row = (
        await DigitalMetalBuyOrder.create(
          [
            {
              _id: orderId,
              tenantId: req.auth.tenantId,
              customerId: req.auth.id,
              branchId: customer.branchId ?? null,
              quoteId: quote._id,
              status: "PAYMENT_PENDING",
              snapshot,
              metal: quote.metal,
              finenessPpm: quote.finenessPpm,
              quantityUg,
              totalPayablePaise,
              quoteExpiresAt: quote.expiresAt,
              paymentAcceptanceExpiresAt: quote.expiresAt,
              termsVersion: quote.termsVersion,
              termsContentHash: quote.termsContentHash,
              taxProfileFingerprint: quote.taxProfileFingerprint,
              termsAcceptedAt,
              idempotencyKey,
              version: 1,
            },
          ],
          { session },
        )
      )[0];
      return row.toObject();
    });
  } catch (err) {
    if (err?.code === 11000) {
      const dup = await DigitalMetalBuyOrder.findOne({ tenantId: req.auth.tenantId, idempotencyKey }).lean();
      if (dup) {
        const attempts = await DigitalMetalBuyPaymentAttempt.find({
          tenantId: req.auth.tenantId,
          orderId: dup._id,
        }).lean();
        return mapBuyOrderStatusDto(dup, attempts);
      }
    }
    throw err;
  }

  return mapBuyOrderStatusDto(order, []);
}

export async function getCustomerBuyOrder(req) {
  const order = await DigitalMetalBuyOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const attempts = await DigitalMetalBuyPaymentAttempt.find({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  return mapBuyOrderStatusDto(order, attempts);
}

export async function createBuyOrderPaymentIntent(req) {
  return initiateDigitalMetalBuyPaymentAttempt(req);
}

export async function listAdminBuyOrders(req) {
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : "";
  const filter = { tenantId: req.auth.tenantId };
  if (req.query.status) filter.status = req.query.status;
  await applyAdminBuyOrderBranchFilter(req, filter);
  const idClauses = [];
  if (q && q.length >= 4) {
    idClauses.push({ _id: { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } });
  }
  if (cursor) idClauses.push({ _id: { $lt: cursor } });
  if (idClauses.length === 1) Object.assign(filter, idClauses[0]);
  else if (idClauses.length > 1) filter.$and = idClauses;
  const rows = await DigitalMetalBuyOrder.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  return { items: items.map((o) => mapBuyOrderStatusDto(o, [])), meta };
}

export async function getAdminBuyOrder(req) {
  const order = await DigitalMetalBuyOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Order");
  const customer = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  if (customer) assertTenantOwnsCustomerScope(req, customer);
  const attempts = await DigitalMetalBuyPaymentAttempt.find({
    tenantId: req.auth.tenantId,
    orderId: order._id,
  }).lean();
  return mapBuyOrderStatusDto(order, attempts);
}
