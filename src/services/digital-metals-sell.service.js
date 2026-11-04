import { AppError, errors } from "../lib/app-error.js";
import {
  buildSellQuotePayload,
  CALCULATION_VERSION,
} from "../lib/digital-metals-quote-engine.js";
import { presentDigitalMetalsAccessState } from "../lib/digital-metals-access.js";
import { createId } from "../lib/ids.js";
import { withTransaction } from "../lib/transaction.js";
import {
  assertTenantTaxAndTerms,
  computeTaxProfileFingerprint,
  DEFAULT_DIGITAL_METAL_ASSETS,
  resolveAssetReadiness,
  assertQuoteAssetReadiness,
} from "../lib/digital-metals-readiness.js";
import { attachSubscriptionCatalogPlan } from "../lib/subscription-plan-for-tenant.js";
import { plainLanguageSellOrderStatus } from "../lib/plain-language-labels.js";
import {
  buildPermittedSellOrderActions,
  deriveSellPaymentDisplayState,
} from "../lib/digital-metals-sell-payment-state.js";
import {
  buildDigitalMetalSellSummary,
  sellSummaryForJournalMetadata,
} from "../lib/digital-metals-sell-summary.js";
import {
  hashDigitalMetalsOrderBody,
  resolveCustomerBoundIdempotencyReplay,
} from "../lib/digital-metals-customer-idempotency.js";
import {
  Customer,
  DigitalMetalBankDestination,
  DigitalMetalPayable,
  DigitalMetalPayout,
  DigitalMetalQuote,
  DigitalMetalReservation,
  DigitalMetalSellOrder,
  DigitalMetalTermsPublication,
  Tenant,
} from "../models/index.js";
import {
  assertQuotePrerequisites,
  latestSettings,
  loadNextFutureRate,
} from "./digital-metals-phase2.service.js";
import { assertTenantOwnsCustomerScope } from "./digital-metals.service.js";
import { applyAdminCustomerScopeFilter, assertAdminCustomerInScope } from "../lib/digital-metals-admin-scope.js";
import { paginateByIdCursor } from "../lib/digital-metals-customer-order-access.js";
import {
  commitReservation,
  reserveWalletQuantity,
} from "./digital-metals-ledger.service.js";
import {
  assertCustomerCanPlaceSell,
  assertCustomerCanPlaceSellInSession,
} from "./digital-metals-risk-hold.service.js";
import { maybePauseAfterDigitalMetalSellDebitForTests } from "../lib/digital-metals-sell-finalize-test-hooks.js";
import {
  cancelAndReleaseSellOrder,
  expireSellOrderById,
  expireStaleSellOrdersForTenant,
} from "./digital-metals-sell-maintenance.service.js";
import { enqueueSellExecutedNotice } from "../lib/digital-metals-customer-notice.js";

async function loadTenant(req) {
  return req.tenant ?? attachSubscriptionCatalogPlan(await Tenant.findById(req.auth.tenantId).lean());
}

function assertNewSellAllowed(tenant) {
  const access = presentDigitalMetalsAccessState(tenant);
  if (!access.active) {
    throw new AppError(
      access.paused ? "DIGITAL_METALS_PAUSED" : "DIGITAL_METALS_DISABLED",
      access.paused ? "Digital metals trading is paused." : "Digital metals is not available.",
      403,
    );
  }
}

function mapAdminCustomerBrief(customer) {
  if (!customer) return null;
  return {
    id: customer._id,
    name: customer.name,
    mobile: customer.mobile,
    email: customer.email ?? null,
    customerNumber: customer.customerNumber,
    branchId: customer.branchId ?? null,
  };
}

function mapPayableBrief(payable) {
  if (!payable) return null;
  return {
    id: payable._id,
    status: payable.status,
    amountPaise: payable.amountPaise,
    outstandingPaise: payable.outstandingPaise,
    settledAt: payable.settledAt ?? null,
    settlementMethod: payable.settlementMethod ?? null,
  };
}

function mapBankDestinationBrief(row) {
  if (!row) return null;
  return {
    id: row._id ?? row.destinationId ?? null,
    accountHolderName: row.accountHolderName,
    accountLast4: row.accountLast4,
    ifsc: row.ifsc,
    bankName: row.bankName ?? "",
    status: row.status ?? row.verificationStatus ?? null,
    verifiedAt: row.verifiedAt ?? null,
  };
}

async function resolveSellOrderBankDestination(tenantId, customerId, order) {
  if (order.payableId) {
    const payout = await DigitalMetalPayout.findOne({ tenantId, payableId: order.payableId })
      .sort({ createdAt: -1 })
      .lean();
    if (payout?.destinationSnapshot) {
      return mapBankDestinationBrief(payout.destinationSnapshot);
    }
  }
  if (!order.bankDestinationId) return null;
  const dest = await DigitalMetalBankDestination.findOne({
    _id: order.bankDestinationId,
    tenantId,
    customerId,
  }).lean();
  return mapBankDestinationBrief(dest);
}

export function mapSellOrderDto(order, extras = {}) {
  const bankDestination = extras.bankDestination ?? null;
  const sellSummary =
    extras.sellSummary ?? buildDigitalMetalSellSummary(order, bankDestination);
  const payable = extras.payable ?? null;
  const payouts = extras.payouts ?? [];
  const paymentDisplay = deriveSellPaymentDisplayState({
    sellStatus: order.status,
    payable,
    payouts,
  });
  return {
    id: order._id,
    customerId: order.customerId,
    status: order.status,
    displayStatusLabel: plainLanguageSellOrderStatus(order.status),
    paymentDisplayState: paymentDisplay,
    permittedActions: buildPermittedSellOrderActions(order, paymentDisplay),
    metal: order.metal,
    finenessPpm: order.finenessPpm,
    quantityUg: String(order.quantityUg),
    settlementPaise: order.settlementPaise,
    quoteExpiresAt: order.quoteExpiresAt,
    approvalExpiresAt: order.approvalExpiresAt ?? null,
    confirmedAt: order.confirmedAt ?? null,
    executedAt: order.executedAt ?? null,
    payableId: order.payableId ?? null,
    bankDestinationId: order.bankDestinationId ?? null,
    payoutMethod: order.payoutMethod ?? "BANK",
    assisted: order.assisted
      ? {
          channel: order.assisted.channel ?? "COUNTER",
          byUserId: order.assisted.byUserId ?? null,
          recordedAt: order.assisted.recordedAt ?? null,
        }
      : null,
    snapshot: order.snapshot ?? null,
    createdAt: order.createdAt ?? null,
    updatedAt: order.updatedAt ?? null,
    version: order.version ?? 1,
    ...extras,
    sellSummary,
  };
}

/** Read the obligation on every accepted result; execution does not imply payment. */
async function acceptedSellDto(order, session = null) {
  const row = order.toObject ? order.toObject() : order;
  const payable = row.payableId
    ? await DigitalMetalPayable.findOne({ _id: row.payableId, tenantId: row.tenantId, sellOrderId: row._id }).session(session).lean()
    : null;
  if (row.status === "PAYABLE_OPEN" && !payable) {
    throw errors.conflict("SELL_PAYABLE_MISSING", "The sale needs financial review before continuing.");
  }
  const payouts = payable
    ? await DigitalMetalPayout.find({ tenantId: row.tenantId, payableId: payable._id }).session(session).lean()
    : [];
  return mapSellOrderDto(row, { payable: mapPayableBrief(payable), payouts, payableOpen: row.status === "PAYABLE_OPEN" });
}

function assertConfirmationBankMatches(order, destinationId) {
  if (String(order.bankDestinationId ?? "") !== String(destinationId ?? "")) {
    throw errors.conflict("SELL_DESTINATION_MISMATCH", "This sale was confirmed for a different bank account.");
  }
}

/**
 * @param {object} req  customer-bound request
 * @param {{ quoteSource?: "CUSTOMER" | "ASSISTED", createdBySubject?: string }} [opts]
 */
export async function createCustomerSellQuote(req, opts = {}) {
  assertNewSellAllowed(await loadTenant(req));
  await assertCustomerCanPlaceSell(req.auth.tenantId, req.auth.id);
  const tenant = await loadTenant(req);
  const { metal, finenessPpm, quantityUg } = req.body;
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

  const core = buildSellQuotePayload({
    quantityUg,
    sellRatePerGramPaise: rate.customerSellRatePerGramPaise,
    sellFeeRule: settings.sellFee,
    taxLines: settings.taxLines,
  });
  const ttlSeconds = settings.sellQuoteTtlSeconds ?? 900;
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
  const termsContentHash = tenant.operations.digitalMetalsTermsContentHash;
  const snapshot = {
    ...core,
    metalQuantityUg: String(core.quantityUg),
    feeLines: core.feePaise ? [{ code: "SELL_FEE", amountPaise: core.feePaise }] : [],
    taxLines: core.taxLines ?? [],
    settlementPaise: core.settlementPaise,
    rateSnapshot: {
      sellRatePerGramPaise: rate.customerSellRatePerGramPaise,
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
    quoteSource: opts.quoteSource ?? "CUSTOMER",
    side: "SELL",
    metal,
    finenessPpm,
    inputMode: "QUANTITY_UG",
    snapshot,
    expiresAt,
    settingsVersionId: settings._id,
    rateVersionId: rate._id,
    termsVersion: tenant.operations.digitalMetalsTermsVersion,
    calculationVersion: CALCULATION_VERSION,
    taxProfileFingerprint: taxFingerprint,
    termsContentHash,
    createdBySubject: opts.createdBySubject ?? req.auth.id,
  });

  return {
    quoteId: quote._id,
    expiresAt: quote.expiresAt,
    side: "SELL",
    metal,
    finenessPpm,
    ...snapshot,
  };
}

/**
 * @param {object} req  customer-bound request
 * @param {{ assisted?: object, payoutMethod?: "BANK" | "CASH", bankDestinationId?: string | null, finalizeImmediately?: boolean }} [opts]  counter sells use ASSISTED quotes
 */
export async function createSellOrder(req, opts = {}) {
  const idempotencyKey = String(req.headers["x-idempotency-key"] ?? "").trim();
  if (!idempotencyKey) {
    throw errors.validation([{ field: "x-idempotency-key", message: "Idempotency key is required." }]);
  }
  const bodyHash = hashDigitalMetalsOrderBody(opts.assisted ? {
    ...req.body,
    assistedPayout: { method: opts.payoutMethod ?? "BANK", bankDestinationId: opts.bankDestinationId ?? null },
  } : req.body);
  const existing = await DigitalMetalSellOrder.findOne({
    tenantId: req.auth.tenantId,
    idempotencyKey,
  }).lean();
  const replayExisting = resolveCustomerBoundIdempotencyReplay({
    order: existing,
    customerId: req.auth.id,
    body: req.body,
    bodyHash: opts.assisted && existing?.creationBodyHash === hashDigitalMetalsOrderBody(req.body)
      ? existing.creationBodyHash : bodyHash,
  });
  if (replayExisting) {
    if (opts.assisted && (replayExisting.payoutMethod !== (opts.payoutMethod ?? "BANK")
      || (replayExisting.bankDestinationId && replayExisting.bankDestinationId !== (opts.bankDestinationId ?? null)))) {
      throw errors.conflict("IDEMPOTENCY_KEY_REUSED", "This counter sale used a different payment destination.");
    }
    if (replayExisting.status === "PAYABLE_OPEN") return acceptedSellDto(replayExisting);
    if (opts.finalizeImmediately) return finalizeReservedSellOrder(req, {
      orderId: replayExisting._id, bankDestinationId: opts.bankDestinationId ?? null,
      approvedByUserId: opts.assisted?.byUserId ?? null,
    });
    return mapSellOrderDto(replayExisting);
  }

  assertNewSellAllowed(await loadTenant(req));
  await assertCustomerCanPlaceSell(req.auth.tenantId, req.auth.id);
  const tenant = await loadTenant(req);
  const quote = await DigitalMetalQuote.findOne({
    _id: req.body.quoteId,
    tenantId: req.auth.tenantId,
    side: "SELL",
    quoteSource: opts.assisted ? "ASSISTED" : "CUSTOMER",
    customerId: req.auth.id,
  }).lean();
  if (!quote) throw errors.notFound("Quote");
  if (quote.consumedAt) throw new AppError("QUOTE_ALREADY_USED", "Quote was already accepted.", 409);
  if (new Date(quote.expiresAt).getTime() < Date.now()) {
    throw new AppError("QUOTE_EXPIRED", "Sell quote has expired.", 409);
  }
  const termsHash = tenant.operations.digitalMetalsTermsContentHash;
  if (
    req.body.termsContentHashAccepted !== termsHash
    || req.body.termsVersionAccepted !== tenant.operations.digitalMetalsTermsVersion
  ) {
    throw errors.validation([{ field: "termsContentHashAccepted", message: "Terms hash mismatch." }]);
  }

  const customer = await Customer.findOne({ _id: req.auth.id, tenantId: req.auth.tenantId }).lean();
  if (!customer) throw errors.notFound("Customer");
  const settings = await latestSettings(req.auth.tenantId, quote.metal, quote.finenessPpm);
  const snap = quote.snapshot ?? {};
  const quantityUg = Number(snap.quantityUg ?? snap.metalQuantityUg);
  const settlementPaise = Number(snap.settlementPaise);
  const reserveKey = `${idempotencyKey}:reserve`;

  const orderId = createId("dmso");
  let order;
  try {
    order = await withTransaction(async (session) => {
    const pendingOrder = {
      _id: orderId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
      metal: quote.metal,
      finenessPpm: quote.finenessPpm,
      quantityUg,
      settlementPaise,
      snapshot: snap,
      confirmedAt: null,
      executedAt: null,
    };
    const reserved = await reserveWalletQuantity(session, {
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
      metal: quote.metal,
      finenessPpm: quote.finenessPpm,
      quantityUg,
      purpose: "SELL",
      idempotencyKey: reserveKey,
      holdingPeriodDays: settings.holdingPeriodDays ?? 0,
      journalReferenceType: "SELL",
      journalReferenceId: orderId,
      metadata: sellSummaryForJournalMetadata(pendingOrder),
    });
    const row = (
      await DigitalMetalSellOrder.create(
        [
          {
            _id: orderId,
            tenantId: req.auth.tenantId,
            customerId: req.auth.id,
            branchId: customer.branchId ?? null,
            quoteId: quote._id,
            reservationId: reserved.reservation._id,
            status: "RESERVED",
            snapshot: snap,
            metal: quote.metal,
            finenessPpm: quote.finenessPpm,
            quantityUg,
            settlementPaise,
            quoteExpiresAt: quote.expiresAt,
            termsVersion: req.body.termsVersionAccepted,
            termsContentHash: req.body.termsContentHashAccepted,
            termsAcceptedAt: new Date(),
            idempotencyKey,
            creationBodyHash: bodyHash,
            ...(opts.assisted
              ? { assisted: opts.assisted, payoutMethod: opts.payoutMethod ?? "BANK" }
              : {}),
          },
        ],
        { session },
      )
    )[0];
    const claimedQuote = await DigitalMetalQuote.updateOne(
      { _id: quote._id, tenantId: req.auth.tenantId, consumedAt: null, expiresAt: { $gt: new Date() } },
      { $set: { consumedAt: new Date(), consumedByOrderId: orderId } },
      { session },
    );
    if (claimedQuote.modifiedCount !== 1) {
      throw errors.conflict("QUOTE_ALREADY_USED", "Quote expired or was already accepted.");
    }
    if (opts.finalizeImmediately) {
      row.bankDestinationId = opts.bankDestinationId ?? null;
      row.confirmedAt = new Date();
      return executeSellOrderInSession(session, row, { approvedByUserId: opts.assisted?.byUserId ?? null });
    }
    return row.toObject();
    });
  } catch (err) {
    if (err?.code === 11000) {
      const dup = await DigitalMetalSellOrder.findOne({
        tenantId: req.auth.tenantId,
        idempotencyKey,
      }).lean();
      const replayDup = resolveCustomerBoundIdempotencyReplay({
        order: dup,
        customerId: req.auth.id,
        body: req.body,
        bodyHash,
      });
      if (replayDup) return replayDup.status === "PAYABLE_OPEN" ? acceptedSellDto(replayDup) : mapSellOrderDto(replayDup);
    }
    throw err;
  }

  return order.status === "PAYABLE_OPEN" ? acceptedSellDto(order) : mapSellOrderDto(order);
}

/** Counter/assisted placement: accept sell immediately after reservation (payment remains on payable). */
export async function finalizeReservedSellOrder(req, { orderId, bankDestinationId = null, approvedByUserId = null }) {
  return withTransaction(async (session) => {
    const locked = await DigitalMetalSellOrder.findOne({ _id: orderId, tenantId: req.auth.tenantId }).session(session);
    if (!locked) throw errors.notFound("Sell order");
    if (req.auth.type === "CUSTOMER") {
      if (String(locked.customerId) !== String(req.auth.id)) throw errors.notFound("Sell order");
    } else await assertAdminCustomerInScope(req, locked.customerId);
    if (locked.status === "PAYABLE_OPEN") {
      assertConfirmationBankMatches(locked, bankDestinationId);
      return acceptedSellDto(locked, session);
    }
    assertNewSellAllowed(await loadTenant(req));
    if (locked.status !== "RESERVED") throw errors.conflict("INVALID_STATE", "This sell cannot be confirmed.");
    if (new Date(locked.quoteExpiresAt).getTime() <= Date.now()) {
      throw errors.conflict("QUOTE_EXPIRED", "Request a fresh sell price.");
    }
    locked.bankDestinationId = bankDestinationId;
    locked.confirmedAt = new Date();
    const executed = await executeSellOrderInSession(session, locked, { approvedByUserId });
    return acceptedSellDto(executed, session);
  });
}

/** Debit reserved metal and open INR payable (customer confirm auto-runs this; admin approve uses same path). */
async function executeSellOrderInSession(session, locked, { approvedByUserId = null } = {}) {
  await assertCustomerCanPlaceSellInSession(session, locked.tenantId, locked.customerId);
  const customer = await Customer.findOne({ _id: locked.customerId, tenantId: locked.tenantId, status: "ACTIVE" }).session(session).lean();
  if (!customer) throw errors.conflict("CUSTOMER_NOT_ACTIVE", "This customer cannot sell digital metal.");
  const reserveKey = `${locked.idempotencyKey}:reserve`;
  const reservation = await DigitalMetalReservation.findOne({
    _id: locked.reservationId, tenantId: locked.tenantId, customerId: locked.customerId,
    idempotencyKey: reserveKey, status: "ACTIVE", purpose: "SELL", quantityUg: locked.quantityUg,
  }).session(session).lean();
  if (!reservation) throw errors.conflict("RESERVATION_INACTIVE", "Sell reservation is not active or does not match the sale.");
  if ((locked.payoutMethod ?? "BANK") === "BANK") {
    const destination = await DigitalMetalBankDestination.findOne({
      _id: locked.bankDestinationId, tenantId: locked.tenantId, customerId: locked.customerId, status: "ACTIVE",
    }).session(session).lean();
    if (!destination) throw errors.conflict("BANK_DESTINATION_NOT_VERIFIED", "Choose a verified bank account before confirming the sale.");
  }
  const bankDestination = await resolveSellOrderBankDestination(
    locked.tenantId,
    locked.customerId,
    locked.toObject ? locked.toObject() : locked,
  );
  await commitReservation(session, locked.tenantId, reserveKey, `sell-debit:${locked._id}`, {
    referenceType: "SELL",
    referenceId: locked._id,
    metadata: sellSummaryForJournalMetadata(
      locked.toObject ? locked.toObject() : locked,
      bankDestination,
    ),
  });
  await maybePauseAfterDigitalMetalSellDebitForTests();
  const payableId = createId("dmpaybl");
  await DigitalMetalPayable.create(
    [
      {
        _id: payableId,
        tenantId: locked.tenantId,
        customerId: locked.customerId,
        sellOrderId: locked._id,
        amountPaise: locked.settlementPaise,
        outstandingPaise: locked.settlementPaise,
        status: "OPEN",
      },
    ],
    { session },
  );
  locked.status = "PAYABLE_OPEN";
  locked.executedAt = new Date();
  locked.approvedByUserId = approvedByUserId;
  locked.payableId = payableId;
  locked.approvalExpiresAt = null;
  locked.version = (locked.version ?? 1) + 1;
  await locked.save({ session });
  await enqueueSellExecutedNotice(session, {
    tenantId: locked.tenantId,
    orderId: locked._id,
    customerId: locked.customerId,
    eventAt: locked.executedAt,
  });
  return locked.toObject();
}

export async function confirmSellOrder(req) {
  const destinationId = String(req.body.bankDestinationId ?? "").trim();
  if (!destinationId) {
    throw errors.validation([{ field: "bankDestinationId", message: "Required." }]);
  }
  await expireStaleSellOrdersForTenant(req.auth.tenantId, req.params.orderId);

  return withTransaction(async (session) => {
    const fresh = await DigitalMetalSellOrder.findOne({
      _id: req.params.orderId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    })
      .session(session)
      .lean();
    if (!fresh) throw errors.notFound("Sell order");
    if (fresh.status === "EXPIRED" || fresh.status === "CANCELLED") {
      throw new AppError("QUOTE_EXPIRED", "Sell quote window expired.", 409);
    }
    if (fresh.status === "PAYABLE_OPEN") {
      assertConfirmationBankMatches(fresh, destinationId);
      return acceptedSellDto(fresh, session);
    }
    assertNewSellAllowed(await loadTenant(req));
    if (fresh.status === "PENDING_APPROVAL") {
      const legacy = await DigitalMetalSellOrder.findOne({
        _id: fresh._id,
        tenantId: fresh.tenantId,
        status: "PENDING_APPROVAL",
      }).session(session);
      if (!legacy) throw errors.conflict("STATE_RACE", "Sell order changed during confirmation.");
      if (!legacy.bankDestinationId) {
        legacy.bankDestinationId = destinationId;
        legacy.confirmedAt = legacy.confirmedAt ?? new Date();
      }
      assertConfirmationBankMatches(legacy, destinationId);
      const executed = await executeSellOrderInSession(session, legacy, { approvedByUserId: null });
      return acceptedSellDto(executed, session);
    }
    if (fresh.status !== "RESERVED") {
      throw new AppError("INVALID_STATE", "Order is not awaiting confirmation.", 409, { status: fresh.status });
    }
    if (new Date(fresh.quoteExpiresAt).getTime() < Date.now()) {
      throw new AppError("QUOTE_EXPIRED", "Sell quote has expired.", 409);
    }
    const reserveKey = `${fresh.idempotencyKey}:reserve`;
    const reservation = await DigitalMetalReservation.findOne({
      tenantId: fresh.tenantId,
      idempotencyKey: reserveKey,
      status: "ACTIVE",
    })
      .session(session)
      .lean();
    if (!reservation) {
      throw new AppError("RESERVATION_INACTIVE", "Sell reservation is not active.", 409);
    }
    const updated = await DigitalMetalSellOrder.findOneAndUpdate(
      {
        _id: fresh._id,
        tenantId: fresh.tenantId,
        customerId: req.auth.id,
        status: "RESERVED",
        version: fresh.version,
      },
      {
        $set: {
          bankDestinationId: destinationId,
          confirmedAt: new Date(),
        },
        $inc: { version: 1 },
      },
      { session, new: true },
    );
    if (!updated) {
      const latest = await DigitalMetalSellOrder.findById(fresh._id).session(session).lean();
      if (latest?.status === "PAYABLE_OPEN") {
        assertConfirmationBankMatches(latest, destinationId);
        return acceptedSellDto(latest, session);
      }
      if (latest?.status === "EXPIRED" || latest?.status === "CANCELLED") {
        throw new AppError("QUOTE_EXPIRED", "Sell quote window expired.", 409);
      }
      throw errors.conflict("STATE_RACE", "Sell order changed during confirmation.");
    }
    const executed = await executeSellOrderInSession(session, updated, { approvedByUserId: null });
    return acceptedSellDto(executed, session);
  });
}

export async function cancelSellOrder(req) {
  const filter = {
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  };
  if (req.auth.type === "CUSTOMER") filter.customerId = req.auth.id;
  const order = await DigitalMetalSellOrder.findOne(filter).lean();
  if (!order) throw errors.notFound("Sell order");
  if (req.auth.type !== "CUSTOMER") await assertAdminCustomerInScope(req, order.customerId);
  if (!["RESERVED", "PENDING_APPROVAL"].includes(order.status)) {
    throw new AppError("INVALID_STATE", "Only pre-execution sell orders can be cancelled.", 409);
  }
  await cancelAndReleaseSellOrder(order);
  const updated = await DigitalMetalSellOrder.findById(order._id).lean();
  return mapSellOrderDto(updated, { cancelled: updated.status === "CANCELLED" });
}

export async function adminApproveSellOrder(req) {
  const order = await DigitalMetalSellOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  });
  if (!order) throw errors.notFound("Sell order");
  if (req.auth.type !== "CUSTOMER") await assertAdminCustomerInScope(req, order.customerId);
  await expireStaleSellOrdersForTenant(req.auth.tenantId, order._id);
  const fresh = await DigitalMetalSellOrder.findById(order._id).lean();
  if (fresh.status === "PAYABLE_OPEN") {
    return acceptedSellDto(fresh);
  }
  if (fresh.status === "EXPIRED") throw new AppError("APPROVAL_EXPIRED", "Approval window expired.", 409);
  if (fresh.status !== "PENDING_APPROVAL") {
    throw new AppError("INVALID_STATE", "Sell order is not pending approval.", 409);
  }
  if (fresh.approvalExpiresAt && new Date(fresh.approvalExpiresAt).getTime() < Date.now()) {
    await expireSellOrderById(fresh._id, fresh.tenantId);
    throw new AppError("APPROVAL_EXPIRED", "Approval window has expired.", 409);
  }
  if (req.body.expectedVersion != null && Number(req.body.expectedVersion) !== fresh.version) {
    throw errors.conflict("VERSION_CONFLICT", "Sell order changed; refresh and retry.");
  }

  const result = await withTransaction(async (session) => {
    const locked = await DigitalMetalSellOrder.findOne({
      _id: fresh._id,
      tenantId: fresh.tenantId,
      status: "PENDING_APPROVAL",
    }).session(session);
    if (!locked) throw errors.conflict("STATE_RACE", "Sell order is no longer pending approval.");
    return executeSellOrderInSession(session, locked, { approvedByUserId: req.auth.id });
  });

  return acceptedSellDto(result);
}

export async function getCustomerSellOrder(req) {
  await expireStaleSellOrdersForTenant(req.auth.tenantId, req.params.orderId);
  const order = await DigitalMetalSellOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!order) throw errors.notFound("Sell order");
  const bankDestination = await resolveSellOrderBankDestination(
    req.auth.tenantId,
    req.auth.id,
    order,
  );
  let payable = null;
  if (order.payableId) {
    payable = await DigitalMetalPayable.findById(order.payableId).lean();
  }
  const payouts = order.payableId
    ? await DigitalMetalPayout.find({ tenantId: req.auth.tenantId, payableId: order.payableId })
        .sort({ createdAt: -1 })
        .lean()
    : [];
  return mapSellOrderDto(order, {
    payable: mapPayableBrief(payable),
    payouts,
    bankDestination,
  });
}

/** Admin list tabs use payment-oriented labels; sell order status stays PAYABLE_OPEN after payout. */
async function buildAdminSellOrderListStatusClause(tenantId, statusRaw) {
  if (!statusRaw) return null;
  const status = String(statusRaw).trim();
  if (status === "SETTLED") {
    const payables = await DigitalMetalPayable.find({ tenantId, status: "SETTLED" })
      .select("sellOrderId")
      .lean();
    const ids = payables.map((p) => p.sellOrderId).filter(Boolean);
    return ids.length ? { _id: { $in: ids } } : { _id: { $in: [] } };
  }
  if (status === "PAYABLE_OPEN") {
    const openPayables = await DigitalMetalPayable.find({
      tenantId,
      status: "OPEN",
      outstandingPaise: { $gt: 0 },
    })
      .select("sellOrderId")
      .lean();
    const owedIds = openPayables.map((p) => p.sellOrderId).filter(Boolean);
    const or = [{ status: "PAYABLE_OPEN", payableId: null }];
    if (owedIds.length) or.push({ _id: { $in: owedIds } });
    return { $or: or };
  }
  return { status };
}

export async function listAdminSellOrders(req) {
  await expireStaleSellOrdersForTenant(req.auth.tenantId);
  const limit = Math.min(Number(req.query.limit) || 25, 100);
  const cursor = req.query.cursor ? String(req.query.cursor).trim() : null;
  const q = req.query.q ? String(req.query.q).trim().toLowerCase() : "";
  const filter = { tenantId: req.auth.tenantId };
  const andClauses = [];
  const statusClause = await buildAdminSellOrderListStatusClause(req.auth.tenantId, req.query.status);
  if (statusClause) andClauses.push(statusClause);
  await applyAdminCustomerScopeFilter(req, filter, { customerIdQuery: req.query.customerId });
  if (q && q.length >= 4) {
    andClauses.push({ _id: { $regex: `^${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` } });
  }
  if (cursor) andClauses.push({ _id: { $lt: cursor } });
  if (andClauses.length === 1) Object.assign(filter, andClauses[0]);
  else if (andClauses.length > 1) filter.$and = andClauses;
  const rows = await DigitalMetalSellOrder.find(filter).sort({ _id: -1 }).limit(limit + 1).lean();
  const { items, meta } = paginateByIdCursor(rows, limit);
  const customerIds = [...new Set(items.map((o) => o.customerId).filter(Boolean))];
  const bankIds = [...new Set(items.map((o) => o.bankDestinationId).filter(Boolean))];
  const payableIds = [...new Set(items.map((o) => o.payableId).filter(Boolean))];
  const [customers, bankRows, payableRows] = await Promise.all([
    customerIds.length
      ? Customer.find({ tenantId: req.auth.tenantId, _id: { $in: customerIds } }).lean()
      : [],
    bankIds.length
      ? DigitalMetalBankDestination.find({ tenantId: req.auth.tenantId, _id: { $in: bankIds } }).lean()
      : [],
    payableIds.length
      ? DigitalMetalPayable.find({ tenantId: req.auth.tenantId, _id: { $in: payableIds } }).lean()
      : [],
  ]);
  const customerById = new Map(customers.map((c) => [c._id, c]));
  const bankById = new Map(bankRows.map((b) => [b._id, b]));
  const payableById = new Map(payableRows.map((p) => [p._id, p]));
  return {
    items: items.map((o) =>
      mapSellOrderDto(o, {
        payable: o.payableId ? mapPayableBrief(payableById.get(o.payableId)) : null,
        customer: mapAdminCustomerBrief(customerById.get(o.customerId)),
        bankDestination: o.bankDestinationId
          ? mapBankDestinationBrief(bankById.get(o.bankDestinationId))
          : null,
      }),
    ),
    meta,
  };
}

export async function getAdminSellOrder(req) {
  await expireStaleSellOrdersForTenant(req.auth.tenantId, req.params.orderId);
  const order = await DigitalMetalSellOrder.findOne({
    _id: req.params.orderId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!order) throw errors.notFound("Sell order");
  const cust = await Customer.findOne({ _id: order.customerId, tenantId: req.auth.tenantId }).lean();
  assertTenantOwnsCustomerScope(req, cust);
  const bankDestination = await resolveSellOrderBankDestination(
    req.auth.tenantId,
    order.customerId,
    order,
  );
  const payable = order.payableId ? await DigitalMetalPayable.findById(order.payableId).lean() : null;
  const payouts = order.payableId
    ? await DigitalMetalPayout.find({ tenantId: req.auth.tenantId, payableId: order.payableId })
        .sort({ createdAt: -1 })
        .lean()
    : [];
  return mapSellOrderDto(order, {
    customer: mapAdminCustomerBrief(cust),
    bankDestination,
    payable: mapPayableBrief(payable),
    payouts,
  });
}
