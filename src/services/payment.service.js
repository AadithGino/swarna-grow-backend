import { AuditEntityType, LedgerEntryType, LinkStatus, ManualPaymentMode, PaymentIntentStatus, PaymentMode, PaymentSource, PaymentStatus, ValueBasis } from "../constants/enums.js";
import { LedgerEntry, OutboxEvent, Payment, PaymentIntent, PaymentLink, Scheme, Tenant, WebhookEvent } from "../models/index.js";
import { createId } from "../lib/ids.js";
import { randomToken, sha256, unseal } from "../lib/crypto.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { moneyToWeightMg } from "../lib/money.js";
import { today } from "../lib/date.js";
import { logger } from "../config/logger.js";
import { writeAudit } from "./audit.service.js";
import { payableRange, rebuildSchemeProjection } from "./scheme.service.js";
import { currentGoldRate } from "./tenant.service.js";
import { paginate } from "../lib/pagination.js";
import { phonePeProvider } from "../integrations/phonepe.provider.js";
import { nextSequence } from "./sequence.service.js";

const sourceFor = (req) => req.baseUrl.includes("/staff") ? PaymentSource.STAFF_APP : req.baseUrl.includes("/app") ? PaymentSource.CUSTOMER_APP : PaymentSource.PORTAL;

function checkAmount(quote, amountPaise) {
  if (!quote.payable) {
    throw errors.business("CURRENT_CYCLE_CAP_REACHED", "The current cycle's payment capacity has been fully used.", {
      targetCycle: quote.targetCycle,
      currentCycleCapPaise: quote.capPaise ?? quote.maxPayablePaise ?? 0,
      confirmedThisCyclePaise: quote.paidPaise ?? 0,
      remainingThisCyclePaise: quote.remainingPaise ?? 0,
      positionVersion: quote.positionVersion,
    });
  }
  if (amountPaise < quote.minPayablePaise) throw errors.business("AMOUNT_BELOW_MINIMUM", "The payment is below the allowed amount.", quote);
  if (amountPaise > quote.maxPayablePaise) throw errors.business("AMOUNT_ABOVE_MAXIMUM", "The payment exceeds the allowed amount.", quote);
  if (quote.paymentIncrementPaise > 1 && amountPaise % quote.paymentIncrementPaise !== 0 && !(quote.allowFinalRemainderBelowMinimum && amountPaise === quote.maxPayablePaise)) throw errors.business("AMOUNT_NOT_MULTIPLE", `The payment must be a multiple of ${quote.paymentIncrementPaise} paise.`, quote);
}

function readExpectedPositionVersion(body = {}) {
  if (body.expectedPositionVersion !== undefined) return body.expectedPositionVersion;
  if (body.positionVersion !== undefined) {
    logger.warn({ deprecatedField: "positionVersion" }, "Deprecated positionVersion used; prefer expectedPositionVersion");
    return body.positionVersion;
  }
  return undefined;
}

function assertExpectedPositionVersion(scheme, quote, body) {
  if (scheme.paymentPattern !== "FLEXIBLE") return;
  const expected = readExpectedPositionVersion(body);
  if (expected === undefined) throw errors.validation([{ field: "expectedPositionVersion", message: "expectedPositionVersion is required for flexible schemes." }]);
  if (quote?.positionVersion !== undefined && expected !== quote.positionVersion) {
    throw new AppError("PAYMENT_POSITION_CHANGED", "The payable position changed. Request a fresh quote.", 409, quote);
  }
}

async function assertMaxPaymentsPerCycle({ scheme, targetCycle, session }) {
  const maxPayments = scheme.planSnapshot?.flexibleRules?.flexiblePhase?.maxPaymentsPerCycle;
  if (!maxPayments || scheme.paymentPattern !== "FLEXIBLE") return;
  const confirmed = await Payment.countDocuments({ tenantId: scheme.tenantId, schemeId: scheme._id, targetCycle, status: PaymentStatus.SUCCESS }).session(session);
  const openIntents = await PaymentIntent.countDocuments({ tenantId: scheme.tenantId, schemeId: scheme._id, targetCycle, status: PaymentIntentStatus.PENDING, reservationExpiresAt: { $gt: new Date() } }).session(session);
  if (confirmed + openIntents >= maxPayments) throw errors.business("PAYMENT_COUNT_LIMIT_REACHED", "The maximum number of payments for this cycle has been reached.");
}

async function nextReceipt(tenantId, session) { const number = await nextSequence(tenantId, `receipt:${new Date().getFullYear()}`, session); return `RCP-${new Date().getFullYear()}-${String(number).padStart(7, "0")}`; }
async function gatewayCredentials(tenantId) { const tenant = await Tenant.findById(tenantId).select("+integrationSecrets").lean(); const config = tenant?.integrationSecrets?.phonepe; return config ? { merchantId: config.merchantId, saltKey: config.saltKey ? unseal(config.saltKey) : undefined, saltIndex: config.saltIndex } : {}; }

export async function recordPayment(req, override = {}) {
  if (!override.gateway && !Object.values(ManualPaymentMode).includes(req.body.mode)) throw new AppError("MANUAL_GATEWAY_PAYMENT_NOT_ALLOWED", "Online gateway and legacy modes cannot be recorded manually.", 422);
  return withTransaction(async (session) => {
    const scheme = await Scheme.findOne({ _id: req.body.schemeId, ...req.scope }).session(session); if (!scheme) throw errors.notFound("Scheme");
    let quote; try { quote = await payableRange(req, scheme.toObject()); } catch (error) { if (!override.lateSuccess) throw error; quote = null; }
    req.body.targetCycle ??= quote?.targetCycle;
    if (quote) { try { checkAmount(quote, req.body.amountPaise); } catch (error) { if (!override.lateSuccess) throw error; quote = null; } }
    if (quote?.payable && !override.gateway && scheme.paymentPattern === "FLEXIBLE") {
      const pending = await PaymentIntent.aggregate([{ $match: { tenantId: scheme.tenantId, schemeId: scheme._id, targetCycle: req.body.targetCycle, status: PaymentIntentStatus.PENDING, reservationExpiresAt: { $gt: new Date() } } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" }, intentIds: { $push: "$_id" } } }]).session(session);
      if ((pending[0]?.amountPaise ?? 0) + req.body.amountPaise > quote.maxPayablePaise) throw errors.business("PAYMENT_CONFIRMATION_PENDING", "A pending online payment is reserving part of this cycle's allowance.", { blockingIntentIds: pending[0]?.intentIds ?? [], reservedPaise: pending[0]?.amountPaise ?? 0 });
    }
    if (!override.lateSuccess && quote?.expectedVersion && req.body.expectedVersion && quote.expectedVersion !== req.body.expectedVersion) throw new AppError("VERSION_CONFLICT", "The payable position changed. Refresh and try again.", 409);
    if (!override.lateSuccess && quote) assertExpectedPositionVersion(scheme, quote, req.body);
    if (!override.lateSuccess && quote && scheme.paymentPattern === "FLEXIBLE") await assertMaxPaymentsPerCycle({ scheme, targetCycle: req.body.targetCycle, session });
    let rate; let weightMg = 0;
    if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT) { rate = await currentGoldRate({ tenantId: scheme.tenantId, branchId: scheme.branchId }, today()); if (!rate) throw errors.business("GOLD_RATE_NOT_SET", "Today's gold rate must be set before accepting this payment."); weightMg = moneyToWeightMg(req.body.amountPaise, rate.ratePerGramPaise); }
    let payment;
    if (override.existingPaymentId) {
      payment = await Payment.findOne({ _id: override.existingPaymentId, tenantId: scheme.tenantId, status: { $in: override.lateSuccess ? [PaymentStatus.PENDING, PaymentStatus.FAILED] : [PaymentStatus.PENDING] } }).session(session);
      if (!payment) throw new AppError("PAYMENT_ALREADY_RECORDED", "This gateway attempt is no longer pending.", 409);
      payment.receiptNumber = await nextReceipt(scheme.tenantId, session); payment.status = quote ? PaymentStatus.SUCCESS : PaymentStatus.UNALLOCATED_PENDING_REVIEW; payment.allocatedAmountPaise = quote ? req.body.amountPaise : 0; payment.weightMg = weightMg; payment.ratePerGramPaise = rate?.ratePerGramPaise ?? 0; payment.targetCycle = req.body.targetCycle; payment.providerTransactionId = override.providerTransactionId; payment.providerPayload = override.providerPayload; payment.paidAt = override.paidAt ?? new Date(); payment.isLateSuccess = Boolean(override.lateSuccess); payment.lateSuccessDetectedVia = override.lateSuccessDetectedVia; payment.gatewayCompletedAt = override.gatewayCompletedAt; payment.delayMinutes = override.lateSuccess ? Math.max(0, Math.floor(((override.paidAt ?? new Date()) - payment.createdAt) / 60_000)) : 0; payment.requiresReview = !quote; payment.reviewReason = !quote ? "NO_PAYABLE_POSITION_AVAILABLE" : undefined; await payment.save({ session });
    } else payment = (await Payment.create([{ _id: createId("payment"), tenantId: scheme.tenantId, branchId: scheme.branchId, schemeId: scheme._id, customerId: scheme.customerId, receiptNumber: await nextReceipt(scheme.tenantId, session), amountPaise: req.body.amountPaise, allocatedAmountPaise: req.body.amountPaise, weightMg, ratePerGramPaise: rate?.ratePerGramPaise ?? 0, mode: override.gateway ? PaymentMode.ONLINE_GATEWAY : req.body.mode, status: PaymentStatus.SUCCESS, source: override.source ?? sourceFor(req), reference: req.body.reference, remarks: req.body.remarks, collectedBy: req.auth.id, targetCycle: req.body.targetCycle, providerTransactionId: override.providerTransactionId, providerPayload: override.providerPayload, paidAt: override.paidAt ?? new Date() }], { session }))[0];
    const type = !quote ? LedgerEntryType.UNALLOCATED_PAYMENT : scheme.paymentPattern === "FLEXIBLE" && scheme.flexiblePhase === "FLEXIBLE" ? LedgerEntryType.FREE_WINDOW_PAYMENT : LedgerEntryType.INSTALLMENT_PAYMENT;
    const sequence = await LedgerEntry.countDocuments({ tenantId: scheme.tenantId, schemeId: scheme._id }).session(session) + 1;
    await LedgerEntry.create([{ _id: createId("ledger"), tenantId: scheme.tenantId, branchId: scheme.branchId, schemeId: scheme._id, customerId: scheme.customerId, paymentId: payment._id, type, sequence, amountPaise: payment.amountPaise, weightMg, ratePerGramPaise: rate?.ratePerGramPaise ?? 0, cycle: req.body.targetCycle, actorType: override.actorType ?? "USER", actorId: req.auth.id, description: "Scheme contribution" }], { session });
    if (quote && scheme.paymentPattern === "FIXED") { let remaining = payment.amountPaise; for (const installment of scheme.installments) { if (remaining <= 0 || ["PAID", "WAIVED"].includes(installment.status)) continue; const allocation = Math.min(installment.amountPaise - installment.paidPaise, remaining); installment.paidPaise += allocation; remaining -= allocation; installment.status = installment.paidPaise === installment.amountPaise ? "PAID" : "PARTIALLY_PAID"; } }
    else if (quote) { const cycleKey = req.body.targetCycle ?? new Date().toISOString().slice(0, 7); const cycle = scheme.cycles.find((row) => row.cycle === cycleKey); if (cycle) { cycle.paidPaise += payment.amountPaise; cycle.remainingPaise = Math.max(0, cycle.capPaise - cycle.paidPaise); cycle.status = cycle.remainingPaise === 0 && cycle.capPaise > 0 ? "PAID" : "PARTIALLY_PAID"; } scheme.positionVersion += 1; }
    scheme.version += 1; await scheme.save({ session });
    await OutboxEvent.create([{ tenantId: scheme.tenantId, topic: "payment.succeeded", key: payment._id, payload: { paymentId: payment._id, customerId: scheme.customerId, schemeId: scheme._id } }], { session });
    const auditEventId = await writeAudit({ req, action: "PAYMENT_RECORDED", entityType: AuditEntityType.PAYMENT, entityId: payment._id, after: payment.toObject(), actorType: override.actorType, session }); return { ...payment.toObject(), auditEventId, schemeVersion: scheme.version, positionVersion: scheme.positionVersion };
  });
}
export async function listPayments(req) { const filters = {}; for (const key of ["status", "mode", "source", "schemeId", "customerId", "collectedBy"]) if (req.query[key]) filters[key] = req.query[key]; return paginate(Payment, { scope: req.scope, filters, cursor: req.query.cursor, limit: req.query.limit, sort: req.query.sort ?? "paidAt:desc" }); }
export async function reversePayment(req) { return withTransaction(async (session) => { const payment = await Payment.findOne({ _id: req.params.paymentId, ...req.scope }).session(session); if (!payment) throw errors.notFound("Payment"); if (payment.status !== PaymentStatus.SUCCESS) throw errors.business("REVERSAL_NOT_ALLOWED", "Only successful payments can be reversed."); const scheme = await Scheme.findById(payment.schemeId).session(session); const sequence = await LedgerEntry.countDocuments({ tenantId: payment.tenantId, schemeId: payment.schemeId }).session(session) + 1; await LedgerEntry.create([{ _id: createId("ledger"), tenantId: payment.tenantId, branchId: payment.branchId, schemeId: payment.schemeId, customerId: payment.customerId, paymentId: payment._id, type: LedgerEntryType.REVERSAL, sequence, amountPaise: payment.amountPaise, weightMg: payment.weightMg, ratePerGramPaise: payment.ratePerGramPaise, cycle: payment.targetCycle, actorType: "USER", actorId: req.auth.id, reversalOf: payment._id, description: req.body.reason }], { session }); payment.status = PaymentStatus.REVERSED; payment.reversedAt = new Date(); payment.reversedBy = req.auth.id; payment.reversalReason = req.body.reason; await payment.save({ session }); const entries = await LedgerEntry.find({ tenantId: payment.tenantId, schemeId: payment.schemeId }).sort({ sequence: 1 }).session(session).lean(); rebuildSchemeProjection(scheme, entries); scheme.version += 1; await scheme.save({ session }); const auditEventId = await writeAudit({ req, action: "PAYMENT_REVERSED", entityType: AuditEntityType.PAYMENT, entityId: payment._id, after: payment.toObject(), session }); return { id: payment._id, status: payment.status, auditEventId }; }); }
export async function createPaymentLink(req) { const token = randomToken(32); const expiresAt = new Date(Date.now() + Number(req.body.expiresInMinutes ?? 1440) * 60_000); return withTransaction(async (session) => { const scheme = await Scheme.findOne({ _id: req.body.schemeId, ...req.scope }).session(session); if (!scheme) throw errors.notFound("Scheme"); const quote = await payableRange(req, scheme.toObject()); const targetCycle = req.body.targetCycle ?? quote.targetCycle; let intent; let positionVersion = quote.positionVersion; if (scheme.paymentPattern === "FLEXIBLE") { assertExpectedPositionVersion(scheme, quote, req.body); await assertMaxPaymentsPerCycle({ scheme, targetCycle, session }); const reservations = await PaymentIntent.aggregate([{ $match: { tenantId: scheme.tenantId, schemeId: scheme._id, targetCycle, status: PaymentIntentStatus.PENDING, reservationExpiresAt: { $gt: new Date() } } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }]).session(session); const available = { ...quote, maxPayablePaise: Math.max(0, quote.maxPayablePaise - (reservations[0]?.amountPaise ?? 0)) }; checkAmount(available, req.body.amountPaise); scheme.positionVersion += 1; scheme.version += 1; positionVersion = scheme.positionVersion; await scheme.save({ session }); intent = (await PaymentIntent.create([{ _id: createId("paymentIntent"), tenantId: scheme.tenantId, branchId: scheme.branchId, schemeId: scheme._id, customerId: scheme.customerId, targetCycle, amountPaise: req.body.amountPaise, positionVersion, reservationExpiresAt: expiresAt }], { session }))[0]; } else checkAmount(quote, req.body.amountPaise); const link = (await PaymentLink.create([{ _id: createId("paymentLink"), tenantId: scheme.tenantId, branchId: scheme.branchId, schemeId: scheme._id, customerId: scheme.customerId, tokenHash: sha256(token), amountPaise: req.body.amountPaise, targetCycle, paymentIntentId: intent?._id, positionVersion, expiresAt, createdBy: req.auth.id }], { session }))[0]; return { id: link._id, token, url: `/pay/${token}`, status: link.status, expiresAt: link.expiresAt, paymentIntentId: intent?._id, positionVersion }; }); }
export async function getPublicLink(token, markOpened = true) { const link = await PaymentLink.findOne({ tokenHash: sha256(token) }); if (!link || link.expiresAt < new Date()) throw new AppError("PAYMENT_LINK_EXPIRED", "This payment link has expired.", 410); if (markOpened && link.status === LinkStatus.CREATED) { link.status = LinkStatus.OPENED; link.openedAt = new Date(); await link.save(); } return link; }
async function renewFlexibleLinkReservation(link) { return withTransaction(async (session) => { const scheme = await Scheme.findById(link.schemeId).session(session); if (!scheme) throw errors.notFound("Scheme"); const fakeReq = { auth: { tenantId: link.tenantId }, query: { targetCycle: link.targetCycle }, body: { targetCycle: link.targetCycle } }; const quote = await payableRange(fakeReq, scheme.toObject()); const reservations = await PaymentIntent.aggregate([{ $match: { tenantId: link.tenantId, schemeId: link.schemeId, targetCycle: link.targetCycle, status: PaymentIntentStatus.PENDING, reservationExpiresAt: { $gt: new Date() } } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }]).session(session); checkAmount({ ...quote, maxPayablePaise: Math.max(0, quote.maxPayablePaise - (reservations[0]?.amountPaise ?? 0)) }, link.amountPaise); scheme.positionVersion += 1; scheme.version += 1; await scheme.save({ session }); const intent = (await PaymentIntent.create([{ _id: createId("paymentIntent"), tenantId: link.tenantId, branchId: link.branchId, schemeId: link.schemeId, customerId: link.customerId, targetCycle: link.targetCycle, amountPaise: link.amountPaise, positionVersion: scheme.positionVersion, reservationExpiresAt: link.expiresAt }], { session }))[0]; link.paymentIntentId = intent._id; link.positionVersion = scheme.positionVersion; link.paymentId = null; await link.save({ session }); return link; }); }
export async function initiatePublicPayment(req) {
  let link = await getPublicLink(req.params.linkToken, false);
  if (link.paymentId) { const existing = await Payment.findById(link.paymentId).lean(); if ([PaymentStatus.PENDING, PaymentStatus.SUCCESS, PaymentStatus.UNALLOCATED_PENDING_REVIEW].includes(existing?.status)) return { paymentLinkId: link._id, paymentId: existing?._id, status: existing?.status }; if (link.paymentIntentId) link = await renewFlexibleLinkReservation(link); }
  const provider = await phonePeProvider.createPayment({ merchantTransactionId: link._id, amountPaise: link.amountPaise, redirectUrl: req.body.redirectUrl, callbackUrl: `/api/v1/webhooks/phonepe/${link.tenantId}`, mobile: req.body.mobile, credentials: await gatewayCredentials(link.tenantId) });
  const pending = await Payment.create({ _id: createId("payment"), tenantId: link.tenantId, branchId: link.branchId, schemeId: link.schemeId, customerId: link.customerId, receiptNumber: `PENDING-${link._id}`, amountPaise: link.amountPaise, targetCycle: link.targetCycle, mode: PaymentMode.ONLINE_GATEWAY, status: PaymentStatus.PENDING, source: PaymentSource.CUSTOMER_APP, providerTransactionId: provider.providerOrderId, paidAt: new Date() });
  link.paymentId = pending._id; await link.save(); if (link.paymentIntentId) await PaymentIntent.updateOne({ _id: link.paymentIntentId, status: PaymentIntentStatus.PENDING }, { $set: { paymentId: pending._id, providerOrderId: provider.providerOrderId } }); return { paymentLinkId: link._id, paymentIntentId: link.paymentIntentId, paymentId: pending._id, ...provider };
}
export async function createPaymentIntent(req) {
  let reserved;
  await withTransaction(async (session) => {
    const scheme = await Scheme.findOne({ _id: req.params.schemeId, tenantId: req.auth.tenantId, customerId: req.auth.id }).session(session); if (!scheme) throw errors.notFound("Scheme");
    if (scheme.paymentPattern !== "FLEXIBLE") throw errors.business("PAYMENT_INTENT_NOT_APPLICABLE", "Payment intents apply only to flexible schemes.");
    const quote = await payableRange(req, scheme.toObject()); const targetCycle = req.body.targetCycle ?? quote.targetCycle;
    assertExpectedPositionVersion(scheme, quote, req.body);
    await assertMaxPaymentsPerCycle({ scheme, targetCycle, session });
    const reservations = await PaymentIntent.aggregate([{ $match: { tenantId: scheme.tenantId, schemeId: scheme._id, targetCycle, status: PaymentIntentStatus.PENDING, reservationExpiresAt: { $gt: new Date() } } }, { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } }]).session(session);
    const reservedPaise = reservations[0]?.amountPaise ?? 0;
    const availableQuote = { ...quote, maxPayablePaise: Math.max(0, quote.maxPayablePaise - reservedPaise), reservedPaise };
    checkAmount(availableQuote, req.body.amountPaise);
    scheme.positionVersion += 1; scheme.version += 1; await scheme.save({ session });
    const intent = (await PaymentIntent.create([{ _id: createId("paymentIntent"), tenantId: scheme.tenantId, branchId: scheme.branchId, schemeId: scheme._id, customerId: scheme.customerId, targetCycle, amountPaise: req.body.amountPaise, positionVersion: scheme.positionVersion, reservationExpiresAt: new Date(Date.now() + 30 * 60_000) }], { session }))[0];
    const pending = (await Payment.create([{ _id: createId("payment"), tenantId: scheme.tenantId, branchId: scheme.branchId, schemeId: scheme._id, customerId: scheme.customerId, receiptNumber: `PENDING-${intent._id}`, amountPaise: intent.amountPaise, targetCycle, mode: PaymentMode.ONLINE_GATEWAY, status: PaymentStatus.PENDING, source: PaymentSource.CUSTOMER_APP, paidAt: new Date() }], { session }))[0];
    intent.paymentId = pending._id; await intent.save({ session }); reserved = { intent: intent.toObject(), paymentId: pending._id, tenantId: scheme.tenantId };
  });
  try { const provider = await phonePeProvider.createPayment({ merchantTransactionId: reserved.intent._id, amountPaise: reserved.intent.amountPaise, redirectUrl: req.body.redirectUrl, callbackUrl: `/api/v1/webhooks/phonepe/${reserved.tenantId}`, mobile: req.body.mobile, credentials: await gatewayCredentials(reserved.tenantId) }); await Promise.all([PaymentIntent.updateOne({ _id: reserved.intent._id, status: PaymentIntentStatus.PENDING }, { $set: { providerOrderId: provider.providerOrderId } }), Payment.updateOne({ _id: reserved.paymentId, status: PaymentStatus.PENDING }, { $set: { providerTransactionId: provider.providerOrderId } })]); return { ...reserved.intent, paymentId: reserved.paymentId, providerOrderId: provider.providerOrderId, redirectUrl: provider.redirectUrl }; } catch (error) { await withTransaction(async (session) => { await PaymentIntent.updateOne({ _id: reserved.intent._id, status: PaymentIntentStatus.PENDING }, { $set: { status: PaymentIntentStatus.FAILED }, $inc: { version: 1 } }, { session }); await Payment.updateOne({ _id: reserved.paymentId, status: PaymentStatus.PENDING }, { $set: { status: PaymentStatus.FAILED, providerPayload: { initiationError: error.message } } }, { session }); await Scheme.updateOne({ _id: reserved.intent.schemeId }, { $inc: { positionVersion: 1, version: 1 } }, { session }); }); throw error; }
}
export async function cancelPaymentIntent(req) { return withTransaction(async (session) => { const intent = await PaymentIntent.findOne({ _id: req.params.intentId, tenantId: req.auth.tenantId, customerId: req.auth.id }).session(session); if (!intent) throw errors.notFound("Payment intent"); if (intent.status !== PaymentIntentStatus.PENDING) throw new AppError("PAYMENT_INTENT_NOT_PENDING", "Only a pending payment intent can be cancelled.", 409); const scheme = await Scheme.findById(intent.schemeId).session(session); const expected = readExpectedPositionVersion(req.body); if (expected != null && expected !== scheme.positionVersion) throw new AppError("PAYMENT_POSITION_CHANGED", "The payable position changed. Request a fresh quote.", 409); intent.status = PaymentIntentStatus.CANCELLED; intent.version += 1; await intent.save({ session }); await Payment.updateOne({ _id: intent.paymentId, status: PaymentStatus.PENDING }, { $set: { status: PaymentStatus.FAILED, providerPayload: { cancellationReason: "CUSTOMER_CANCELLED" } } }, { session }); scheme.positionVersion += 1; scheme.version += 1; await scheme.save({ session }); return { ...intent.toObject(), positionVersion: scheme.positionVersion }; }); }
export async function cancelPaymentLink(req) { return withTransaction(async (session) => { const link = await PaymentLink.findOne({ _id: req.params.linkId, ...req.scope, status: { $in: [LinkStatus.CREATED, LinkStatus.SENT, LinkStatus.OPENED] } }).session(session); if (!link) throw errors.business("PAYMENT_LINK_NOT_CANCELLABLE", "This payment link cannot be cancelled."); link.status = LinkStatus.CANCELLED; await link.save({ session }); if (link.paymentIntentId) { const intent = await PaymentIntent.findOneAndUpdate({ _id: link.paymentIntentId, status: PaymentIntentStatus.PENDING }, { $set: { status: PaymentIntentStatus.CANCELLED }, $inc: { version: 1 } }, { new: true, session }); if (intent) await Scheme.updateOne({ _id: link.schemeId }, { $inc: { positionVersion: 1, version: 1 } }, { session }); } if (link.paymentId) await Payment.updateOne({ _id: link.paymentId, status: PaymentStatus.PENDING }, { $set: { status: PaymentStatus.FAILED, providerPayload: { cancellationReason: "LINK_CANCELLED" } } }, { session }); return link.toObject(); }); }
export async function persistWebhook({ tenantId, provider, providerEventId, signature, rawBody, payload }) { try { return await WebhookEvent.create({ _id: createId("webhook"), tenantId, provider, providerEventId, signature, rawBody, payload }); } catch (error) { if (error.code === 11000) return null; throw error; } }
