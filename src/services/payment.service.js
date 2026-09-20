import {
  AuditEntityType,
  CashAdjustmentDirection,
  CashHandoverStatus,
  LedgerEntryType,
  LinkStatus,
  ManualPaymentMode,
  PAYMENT_MODE_LABELS,
  PAYMENT_MODE_ORDER,
  PaymentIntentStatus,
  PaymentMode,
  PaymentSource,
  PaymentStatus,
  SchemeStatus,
  TenantRole,
  ValueBasis,
} from "../constants/enums.js";
import {
  CashAdjustment,
  CashHandover,
  Customer,
  LedgerEntry,
  OutboxEvent,
  Payment,
  PaymentIntent,
  PaymentLink,
  Scheme,
  Tenant,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import { randomToken, sha256 } from "../lib/crypto.js";
import { errors, AppError } from "../lib/app-error.js";
import { paymentGoldAccrualDto } from "../lib/payment-gold-dto.js";
import { gatewayTxFaultCheckpoint } from "../lib/gateway-tx-faults.js";
import { withTransaction } from "../lib/transaction.js";
import { applyWeightPrecisionMg, decimalRoundingMode, moneyToWeightMg } from "../lib/money.js";
import { today } from "../lib/date.js";
import { env } from "../config/env.js";
import { logger } from "../config/logger.js";
import { writeAudit } from "./audit.service.js";
import {
  assertStaffCanAccessScheme,
  payableRange,
  rebuildSchemeProjection,
} from "./scheme.service.js";
import { currentGoldRate } from "./tenant.service.js";
import { paginate } from "../lib/pagination.js";
import { phonePeProvider } from "../integrations/phonepe.provider.js";
import { nextSequence } from "./sequence.service.js";
import { dateMatch, searchRegex } from "../lib/query-filters.js";
import {
  paymentListScope,
  resolvePaymentBranchId,
} from "../lib/payment-scope.js";
import { moneyRef } from "../lib/money.js";
import { assertCustomerPaymentsEnabled } from "../lib/customer-app-access.js";
import { cashBalance } from "./cash.service.js";
import {
  branchDto,
  loadBranchMap,
  loadUserMap,
  userDto,
} from "../lib/relation-maps.js";

function fillPaymentModes(modeRows) {
  const includeLegacy = modeRows.some(
    (row) => row._id === PaymentMode.LEGACY_ONLINE,
  );
  const order = PAYMENT_MODE_ORDER.filter(
    (mode) => mode !== PaymentMode.LEGACY_ONLINE || includeLegacy,
  );
  return order.map((mode) => {
    const row = modeRows.find((item) => item._id === mode);
    return {
      mode,
      label: PAYMENT_MODE_LABELS[mode] ?? mode,
      count: row?.count ?? 0,
      amount: moneyRef(row?.amountPaise ?? 0),
    };
  });
}

async function paymentListSummary(req, filters, query) {
  const match = { ...(await paymentListScope(req)), ...filters };
  const modeMatch = { ...match };
  if (!filters.status) modeMatch.status = PaymentStatus.SUCCESS;

  const [totals, byStatus, byModeAgg] = await Promise.all([
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalAmountPaise: { $sum: "$amountPaise" },
        },
      },
    ]),
    Payment.aggregate([
      { $match: match },
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          amountPaise: { $sum: "$amountPaise" },
        },
      },
    ]),
    Payment.aggregate([
      { $match: modeMatch },
      {
        $group: {
          _id: "$mode",
          count: { $sum: 1 },
          amountPaise: { $sum: "$amountPaise" },
        },
      },
    ]),
  ]);

  const statusRow = (status) =>
    byStatus.find((row) => row._id === status) ?? {
      count: 0,
      amountPaise: 0,
    };
  const success = statusRow(PaymentStatus.SUCCESS);
  const pending = statusRow(PaymentStatus.PENDING);
  const failed = statusRow(PaymentStatus.FAILED);
  const reversed = statusRow(PaymentStatus.REVERSED);
  const byMode = fillPaymentModes(byModeAgg);

  const summary = {
    count: totals[0]?.count ?? 0,
    successfulCount: success.count,
    pendingCount: pending.count,
    failedCount: failed.count,
    reversedCount: reversed.count,
    totalAmount: moneyRef(totals[0]?.totalAmountPaise ?? 0),
    successfulAmount: moneyRef(success.amountPaise),
    reversedAmount: moneyRef(reversed.amountPaise),
    averageSuccessfulPayment:
      success.count > 0
        ? moneyRef(Math.round(success.amountPaise / success.count))
        : moneyRef(0),
    byMode,
    byStatus: [
      PaymentStatus.SUCCESS,
      PaymentStatus.PENDING,
      PaymentStatus.FAILED,
      PaymentStatus.REVERSED,
    ].map((status) => {
      const row = statusRow(status);
      return {
        status,
        count: row.count,
        amount: moneyRef(row.amountPaise),
      };
    }),
  };

  const includeCharts =
    query.includeCharts === "true" || query.includeCharts === true;
  if (includeCharts) {
    const modeSeries = byMode
      .filter((row) => row.count > 0)
      .map((row) => ({
        x: row.label,
        y: row.amount.amountPaise,
        yDisplay: row.amount.amountDisplay,
        modeKey: row.mode,
      }));
    summary.charts = {
      modeDistribution: {
        chartType: "donut",
        title: "Filtered payments by mode",
        yAxis: { type: "currency", label: "Amount" },
        series: [{ key: "PAYMENT_MODE", name: "Amount", data: modeSeries }],
      },
    };
  }

  return summary;
}

const sourceFor = (req) =>
  req.baseUrl.includes("/staff")
    ? PaymentSource.STAFF_APP
    : req.baseUrl.includes("/app")
      ? PaymentSource.CUSTOMER_APP
      : PaymentSource.PORTAL;

function checkAmount(quote, amountPaise) {
  if (!quote.payable) {
    throw errors.business(
      "CURRENT_CYCLE_CAP_REACHED",
      "The current cycle's payment capacity has been fully used.",
      {
        targetCycle: quote.targetCycle,
        currentCycleCapPaise: quote.capPaise ?? quote.maxPayablePaise ?? 0,
        confirmedThisCyclePaise: quote.paidPaise ?? 0,
        remainingThisCyclePaise: quote.remainingPaise ?? 0,
        positionVersion: quote.positionVersion,
      },
    );
  }
  if (amountPaise < quote.minPayablePaise)
    throw errors.business(
      "AMOUNT_BELOW_MINIMUM",
      "The payment is below the allowed amount.",
      quote,
    );
  if (amountPaise > quote.maxPayablePaise)
    throw errors.business(
      "AMOUNT_ABOVE_MAXIMUM",
      "The payment exceeds the allowed amount.",
      quote,
    );
  if (
    quote.maxPaymentPerTransactionPaise != null &&
    amountPaise > quote.maxPaymentPerTransactionPaise
  ) {
    throw errors.business(
      "AMOUNT_ABOVE_MAXIMUM",
      "The payment exceeds the per-transaction limit for this plan.",
      quote,
    );
  }
  if (
    quote.paymentIncrementPaise > 1 &&
    amountPaise % quote.paymentIncrementPaise !== 0 &&
    !(
      quote.allowFinalRemainderBelowMinimum &&
      amountPaise === quote.maxPayablePaise
    )
  ) {
    throw errors.business(
      "AMOUNT_NOT_MULTIPLE",
      `The payment must be a multiple of ${quote.paymentIncrementPaise} paise.`,
      quote,
    );
  }
}

function readExpectedPositionVersion(body = {}) {
  if (body.expectedPositionVersion !== undefined)
    return body.expectedPositionVersion;
  if (body.positionVersion !== undefined) {
    logger.warn(
      { deprecatedField: "positionVersion" },
      "Deprecated positionVersion used; prefer expectedPositionVersion",
    );
    return body.positionVersion;
  }
  return undefined;
}

function assertExpectedPositionVersion(scheme, quote, body) {
  if (scheme.paymentPattern !== "FLEXIBLE") return;
  const expected = readExpectedPositionVersion(body);
  if (expected === undefined)
    throw errors.validation([
      {
        field: "expectedPositionVersion",
        message: "expectedPositionVersion is required for flexible schemes.",
      },
    ]);
  if (
    quote?.positionVersion !== undefined &&
    expected !== quote.positionVersion
  ) {
    throw new AppError(
      "PAYMENT_POSITION_CHANGED",
      "The payable position changed. Request a fresh quote.",
      409,
      quote,
    );
  }
}

async function assertMaxPaymentsPerCycle({ scheme, targetCycle, session }) {
  const maxPayments =
    scheme.planSnapshot?.flexibleRules?.flexiblePhase?.maxPaymentsPerCycle;
  if (!maxPayments || scheme.paymentPattern !== "FLEXIBLE") return;
  const confirmed = await Payment.countDocuments({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    targetCycle,
    status: PaymentStatus.SUCCESS,
  }).session(session);
  const openIntents = await PaymentIntent.countDocuments({
    tenantId: scheme.tenantId,
    schemeId: scheme._id,
    targetCycle,
    status: PaymentIntentStatus.PENDING,
    reservationExpiresAt: { $gt: new Date() },
  }).session(session);
  if (confirmed + openIntents >= maxPayments)
    throw errors.business(
      "PAYMENT_COUNT_LIMIT_REACHED",
      "The maximum number of payments for this cycle has been reached.",
    );
}

/** Allocates inside the caller Mongo session — rolled back if the payment transaction aborts (no gapless guarantee across failed txns). */
async function nextReceipt(tenantId, session) {
  const year = new Date().getFullYear();
  const number = await nextSequence(tenantId, `receipt:${year}`, session);
  return `RCP-${year}-${String(number).padStart(7, "0")}`;
}
async function gatewayCredentials(tenantId) {
  const tenant = await Tenant.findById(tenantId)
    .select("+integrationSecrets")
    .lean();
  const { resolvePhonePeCredentials } = await import("../integrations/phonepe.provider.js");
  return resolvePhonePeCredentials(tenant) ?? {};
}

/** In mock provider mode, simulate webhook completion when the customer polls status. */
export async function maybeCompleteMockGatewayPayment({ tenantId, link, intent, payment }) {
  if (env.PROVIDER_MODE !== "mock" || !payment || payment.status !== PaymentStatus.PENDING) {
    return payment;
  }
  const source = intent ?? link;
  if (!source) return payment;

  const { finalizeGatewaySuccess } = await import("./finalize-gateway-success.service.js");
  const reference = intent?._id ?? link?._id;
  const providerTransactionId = payment.providerTransactionId ?? `mock_${payment._id}`;
  await finalizeGatewaySuccess({
    tenantId,
    reference,
    transactionId: providerTransactionId,
    amountPaise: source.amountPaise,
    providerPayload: { mode: "mock", simulated: true },
    webhookEventId: `mock_${payment._id}`,
    intent,
    link,
  });

  return Payment.findById(payment._id).lean();
}

export async function recordPayment(req, override = {}) {
  if (
    !override.gateway &&
    !Object.values(ManualPaymentMode).includes(req.body.mode)
  )
    throw new AppError(
      "MANUAL_GATEWAY_PAYMENT_NOT_ALLOWED",
      "Online gateway and legacy modes cannot be recorded manually.",
      422,
    );
  if (override.session) {
    return recordPaymentInSession(override.session, req, override);
  }
  return withTransaction((session) => recordPaymentInSession(session, req, override));
}

async function recordPaymentInSession(session, req, override) {
    const scheme = await Scheme.findOne({
      _id: req.body.schemeId,
      tenantId: req.auth.tenantId,
    }).session(session);
    if (!scheme) throw errors.notFound("Scheme");
    await assertStaffCanAccessScheme(req, scheme, session);
    const customerRow = await Customer.findOne({
      _id: scheme.customerId,
      tenantId: scheme.tenantId,
    })
      .select("branchId")
      .session(session)
      .lean();
    const paymentBranchId = resolvePaymentBranchId(req, scheme, customerRow);
    let quote;
    try {
      quote = await payableRange(req, scheme.toObject());
    } catch (error) {
      if (!override.lateSuccess) throw error;
      quote = null;
    }
    req.body.targetCycle ??= quote?.targetCycle;
    if (quote) {
      try {
        checkAmount(quote, req.body.amountPaise);
      } catch (error) {
        if (!override.lateSuccess) throw error;
        quote = null;
      }
    }
    if (
      quote?.payable &&
      !override.gateway &&
      scheme.paymentPattern === "FLEXIBLE"
    ) {
      const pending = await PaymentIntent.aggregate([
        {
          $match: {
            tenantId: scheme.tenantId,
            schemeId: scheme._id,
            targetCycle: req.body.targetCycle,
            status: PaymentIntentStatus.PENDING,
            reservationExpiresAt: { $gt: new Date() },
          },
        },
        {
          $group: {
            _id: null,
            amountPaise: { $sum: "$amountPaise" },
            intentIds: { $push: "$_id" },
          },
        },
      ]).session(session);
      if (
        (pending[0]?.amountPaise ?? 0) + req.body.amountPaise >
        quote.maxPayablePaise
      )
        throw errors.business(
          "PAYMENT_CONFIRMATION_PENDING",
          "A pending online payment is reserving part of this cycle's allowance.",
          {
            blockingIntentIds: pending[0]?.intentIds ?? [],
            reservedPaise: pending[0]?.amountPaise ?? 0,
          },
        );
    }
    if (
      !override.lateSuccess &&
      quote?.expectedVersion &&
      req.body.expectedVersion &&
      quote.expectedVersion !== req.body.expectedVersion
    )
      throw new AppError(
        "VERSION_CONFLICT",
        "The payable position changed. Refresh and try again.",
        409,
      );
    if (!override.lateSuccess && quote)
      assertExpectedPositionVersion(scheme, quote, req.body);
    if (!override.lateSuccess && quote && scheme.paymentPattern === "FLEXIBLE")
      await assertMaxPaymentsPerCycle({
        scheme,
        targetCycle: req.body.targetCycle,
        session,
      });
    let rate;
    let weightMg = 0;
    if (scheme.valueBasis === ValueBasis.GOLD_WEIGHT) {
      const goldRules = scheme.planSnapshot?.goldRules ?? {};
      rate = await currentGoldRate(
        {
          tenantId: scheme.tenantId,
          branchId: paymentBranchId ?? scheme.branchId,
        },
        today(),
      );
      if (!rate && goldRules.blockPaymentIfRateNotSet !== false) {
        throw errors.business(
          "GOLD_RATE_NOT_SET",
          "Today's gold rate must be set before accepting this payment.",
        );
      }
      if (rate) {
        const rounding = decimalRoundingMode(goldRules.weightRoundingMode);
        weightMg = moneyToWeightMg(req.body.amountPaise, rate.ratePerGramPaise, rounding);
        weightMg = applyWeightPrecisionMg(weightMg, goldRules.weightPrecisionMg, rounding);
      }
    }
    let payment;
    if (override.existingPaymentId) {
      payment = await Payment.findOne({
        _id: override.existingPaymentId,
        tenantId: scheme.tenantId,
        status: {
          $in: override.lateSuccess
            ? [PaymentStatus.PENDING, PaymentStatus.FAILED]
            : [PaymentStatus.PENDING],
        },
      }).session(session);
      if (!payment)
        throw new AppError(
          "PAYMENT_ALREADY_RECORDED",
          "This gateway attempt is no longer pending.",
          409,
        );
      // PERF(audit): single counter per tenant/year serializes concurrent payments under load — see audit doc
      payment.receiptNumber = await nextReceipt(scheme.tenantId, session);
      payment.status = quote
        ? PaymentStatus.SUCCESS
        : PaymentStatus.UNALLOCATED_PENDING_REVIEW;
      payment.allocatedAmountPaise = quote ? req.body.amountPaise : 0;
      payment.weightMg = weightMg;
      payment.ratePerGramPaise = rate?.ratePerGramPaise ?? 0;
      payment.targetCycle = req.body.targetCycle;
      if (override.providerTransactionId)
        payment.providerTransactionId = override.providerTransactionId;
      payment.providerPayload = override.providerPayload;
      payment.paidAt = override.paidAt ?? new Date();
      payment.isLateSuccess = Boolean(override.lateSuccess);
      payment.lateSuccessDetectedVia = override.lateSuccessDetectedVia;
      payment.gatewayCompletedAt = override.gatewayCompletedAt;
      payment.delayMinutes = override.lateSuccess
        ? Math.max(
            0,
            Math.floor(
              ((override.paidAt ?? new Date()) - payment.createdAt) / 60_000,
            ),
          )
        : 0;
      payment.requiresReview = !quote;
      payment.reviewReason = !quote
        ? "NO_PAYABLE_POSITION_AVAILABLE"
        : undefined;
      await payment.save({ session });
      gatewayTxFaultCheckpoint("recordPayment:payment-saved");
    } else {
      const paymentDoc = {
        _id: createId("payment"),
        tenantId: scheme.tenantId,
        branchId: paymentBranchId,
        schemeId: scheme._id,
        customerId: scheme.customerId,
        receiptNumber: await nextReceipt(scheme.tenantId, session),
        amountPaise: req.body.amountPaise,
        allocatedAmountPaise: req.body.amountPaise,
        weightMg,
        ratePerGramPaise: rate?.ratePerGramPaise ?? 0,
        mode: override.gateway ? PaymentMode.ONLINE_GATEWAY : req.body.mode,
        status: PaymentStatus.SUCCESS,
        source: override.source ?? sourceFor(req),
        reference: req.body.reference ?? undefined,
        remarks: req.body.remarks ?? undefined,
        collectedBy: req.auth.id,
        targetCycle: req.body.targetCycle ?? undefined,
        providerPayload: override.providerPayload,
        paidAt: override.paidAt ?? new Date(),
      };
      if (override.providerTransactionId)
        paymentDoc.providerTransactionId = override.providerTransactionId;
      payment = (await Payment.create([paymentDoc], { session }))[0];
      gatewayTxFaultCheckpoint("recordPayment:payment-saved");
    }
    const type = !quote
      ? LedgerEntryType.UNALLOCATED_PAYMENT
      : scheme.paymentPattern === "FLEXIBLE" &&
          scheme.flexiblePhase === "FLEXIBLE"
        ? LedgerEntryType.FREE_WINDOW_PAYMENT
        : LedgerEntryType.INSTALLMENT_PAYMENT;
    const sequence = await nextSequence(
      scheme.tenantId,
      `ledger:${scheme._id}`,
      session,
    );
    await LedgerEntry.create(
      [
        {
          _id: createId("ledger"),
          tenantId: scheme.tenantId,
          branchId: paymentBranchId,
          schemeId: scheme._id,
          customerId: scheme.customerId,
          paymentId: payment._id,
          type,
          sequence,
          amountPaise: payment.amountPaise,
          weightMg,
          ratePerGramPaise: rate?.ratePerGramPaise ?? 0,
          cycle: req.body.targetCycle,
          actorType: override.actorType ?? "USER",
          actorId: req.auth.id,
          description: "Scheme contribution",
        },
      ],
      { session },
    );
    gatewayTxFaultCheckpoint("recordPayment:ledger-created");
    if (quote && scheme.paymentPattern === "FIXED") {
      let remaining = payment.amountPaise;
      for (const installment of scheme.installments) {
        if (remaining <= 0 || ["PAID", "WAIVED"].includes(installment.status))
          continue;
        const allocation = Math.min(
          installment.amountPaise - installment.paidPaise,
          remaining,
        );
        installment.paidPaise += allocation;
        remaining -= allocation;
        installment.status =
          installment.paidPaise === installment.amountPaise
            ? "PAID"
            : "PARTIALLY_PAID";
      }
      if (
        scheme.status === SchemeStatus.DEFAULTED &&
        !(scheme.installments ?? []).some((row) => row.status === "OVERDUE")
      ) {
        scheme.status = SchemeStatus.ACTIVE;
      }
    } else if (quote) {
      const cycleKey =
        req.body.targetCycle ?? new Date().toISOString().slice(0, 7);
      const cycle = scheme.cycles.find((row) => row.cycle === cycleKey);
      if (cycle) {
        cycle.paidPaise += payment.amountPaise;
        cycle.remainingPaise = Math.max(0, cycle.capPaise - cycle.paidPaise);
        cycle.status =
          cycle.remainingPaise === 0 && cycle.capPaise > 0
            ? "PAID"
            : "PARTIALLY_PAID";
      }
      scheme.positionVersion += 1;
    }
    scheme.version += 1;
    await scheme.save({ session });
    gatewayTxFaultCheckpoint("recordPayment:scheme-saved");
    await OutboxEvent.create(
      [
        {
          tenantId: scheme.tenantId,
          topic: "payment.succeeded",
          key: payment._id,
          payload: {
            paymentId: payment._id,
            customerId: scheme.customerId,
            schemeId: scheme._id,
            branchId: payment.branchId ?? scheme.branchId,
          },
        },
      ],
      { session },
    );
    gatewayTxFaultCheckpoint("recordPayment:outbox-created");
    const auditEventId = await writeAudit({
      req,
      action: "PAYMENT_RECORDED",
      entityType: AuditEntityType.PAYMENT,
      entityId: payment._id,
      after: payment.toObject(),
      actorType: override.actorType,
      session,
    });
    gatewayTxFaultCheckpoint("recordPayment:audit-written");
    return {
      ...payment.toObject(),
      auditEventId,
      schemeVersion: scheme.version,
      positionVersion: scheme.positionVersion,
    };
}
export async function listPayments(req) {
  const filters = {};
  for (const key of [
    "status",
    "mode",
    "source",
    "schemeId",
    "customerId",
    "collectedBy",
  ])
    if (req.query[key]) filters[key] = req.query[key];
  if (req.auth?.role === TenantRole.COLLECTION_AGENT && !filters.collectedBy) {
    filters.collectedBy = req.auth.id;
  }
  if (
    String(req.originalUrl ?? "").includes("/cash/collections") &&
    !filters.mode
  ) {
    filters.mode = PaymentMode.CASH;
  }
  if (req.query.isLateSuccess === "true" || req.query.isLateSuccess === true)
    filters.isLateSuccess = true;
  Object.assign(filters, dateMatch("paidAt", req.query));
  const scope = await paymentListScope(req);

  const pattern = searchRegex(req.query.q);
  if (pattern) {
    const matchedCustomers = await Customer.find({
      tenantId: req.auth.tenantId,
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
      $or: [
        { name: pattern },
        { mobile: pattern },
        { customerNumber: pattern },
      ],
    })
      .select("_id")
      .lean();
    filters.$or = [
      { receiptNumber: pattern },
      { customerId: { $in: matchedCustomers.map((row) => row._id) } },
    ];
  }

  const result = await paginate(Payment, {
    scope,
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: req.query.sort ?? "paidAt:desc",
  });
  const includeSummary =
    req.query.includeSummary === "true" || req.query.includeSummary === true;
  if (includeSummary) {
    result.meta = {
      ...result.meta,
      summary: await paymentListSummary(req, filters, req.query),
    };
  }
  if (!result.data.length) return result;
  result.data = await enrichPaymentRows(req.auth.tenantId, result.data);
  return result;
}

async function enrichPaymentRows(tenantId, rows) {
  if (!rows.length) return [];
  const customerIds = [
    ...new Set(rows.map((row) => row.customerId).filter(Boolean)),
  ];
  const schemeIds = [
    ...new Set(rows.map((row) => row.schemeId).filter(Boolean)),
  ];
  const branchIds = [
    ...new Set(rows.map((row) => row.branchId).filter(Boolean)),
  ];
  const staffIds = [
    ...new Set(rows.map((row) => row.collectedBy).filter(Boolean)),
  ];
  const [customers, schemes, branchMap, staffMap] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } })
      .select("_id name mobile customerNumber")
      .lean(),
    Scheme.find({ _id: { $in: schemeIds } })
      .select(
        "_id enrollmentNumber planSnapshot paymentPattern valueBasis status",
      )
      .lean(),
    loadBranchMap(tenantId, branchIds),
    loadUserMap(staffIds),
  ]);
  const customerMap = new Map(customers.map((row) => [row._id, row]));
  const schemeMap = new Map(schemes.map((row) => [row._id, row]));
  return rows.map((row) => {
    const customer = customerMap.get(row.customerId);
    const scheme = schemeMap.get(row.schemeId);
    const collector = staffMap.get(row.collectedBy);
    return {
      ...row,
      amount: { amountPaise: row.amountPaise },
      goldAccrual: paymentGoldAccrualDto(row),
      customer: customer
        ? {
            _id: customer._id,
            id: customer._id,
            name: customer.name,
            mobile: customer.mobile,
            customerNumber: customer.customerNumber,
          }
        : undefined,
      scheme: scheme
        ? {
            _id: scheme._id,
            id: scheme._id,
            enrollmentNumber: scheme.enrollmentNumber,
            planName:
              scheme.planSnapshot?.displayName ??
              scheme.planSnapshot?.name ??
              scheme.enrollmentNumber,
            paymentPattern: scheme.paymentPattern,
            valueBasis: scheme.valueBasis,
            status: scheme.status,
          }
        : undefined,
      branch: branchDto(branchMap.get(row.branchId)),
      collectedBy: userDto(collector) ?? row.collectedBy,
    };
  });
}

export async function getPayment(req) {
  const filters = { _id: req.params.paymentId };
  if (req.auth?.role === TenantRole.COLLECTION_AGENT) {
    filters.collectedBy = req.auth.id;
  }
  const scope = await paymentListScope(req);
  const row = await Payment.findOne({ ...scope, ...filters }).lean();
  if (!row) throw errors.notFound("Payment");
  const [payment] = await enrichPaymentRows(req.auth.tenantId, [row]);
  return payment;
}
export async function reversePayment(req) {
  return withTransaction(async (session) => {
    const payment = await Payment.findOne({
      _id: req.params.paymentId,
      ...req.scope,
    }).session(session);
    if (!payment) throw errors.notFound("Payment");
    if (payment.status !== PaymentStatus.SUCCESS)
      throw errors.business(
        "REVERSAL_NOT_ALLOWED",
        "Only successful payments can be reversed.",
      );
    const tenant = await Tenant.findById(payment.tenantId)
      .select("operations")
      .session(session)
      .lean();
    const windowHours = Number(tenant?.operations?.paymentReversalWindowHours ?? 48);
    const paidAtMs = payment.paidAt ? new Date(payment.paidAt).getTime() : 0;
    if (paidAtMs && Date.now() - paidAtMs > windowHours * 3_600_000) {
      throw errors.business(
        "REVERSAL_WINDOW_EXPIRED",
        `Payments can only be reversed within ${windowHours} hours.`,
        { windowHours, paidAt: payment.paidAt },
      );
    }
    const scheme = await Scheme.findById(payment.schemeId).session(session);
    const sequence = await nextSequence(
      payment.tenantId,
      `ledger:${payment.schemeId}`,
      session,
    );
    await LedgerEntry.create(
      [
        {
          _id: createId("ledger"),
          tenantId: payment.tenantId,
          branchId: payment.branchId,
          schemeId: payment.schemeId,
          customerId: payment.customerId,
          paymentId: payment._id,
          type: LedgerEntryType.REVERSAL,
          sequence,
          amountPaise: payment.amountPaise,
          weightMg: payment.weightMg,
          ratePerGramPaise: payment.ratePerGramPaise,
          cycle: payment.targetCycle,
          actorType: "USER",
          actorId: req.auth.id,
          reversalOf: payment._id,
          description: req.body.reason,
        },
      ],
      { session },
    );
    payment.status = PaymentStatus.REVERSED;
    payment.reversedAt = new Date();
    payment.reversedBy = req.auth.id;
    payment.reversalReason = req.body.reason;
    await payment.save({ session });
    const entries = await LedgerEntry.find({
      tenantId: payment.tenantId,
      schemeId: payment.schemeId,
    })
      .sort({ sequence: 1 })
      .session(session)
      .lean();
    rebuildSchemeProjection(scheme, entries);
    scheme.version += 1;
    await scheme.save({ session });
    let cashAdjustmentId;
    if (payment.mode === PaymentMode.CASH && payment.collectedBy) {
      const balance = await cashBalance({
        tenantId: payment.tenantId,
        branchId: payment.branchId,
        staffId: payment.collectedBy,
      }, session);
      const inHandAfter = balance.cashInHandPaise - payment.amountPaise;
      if (inHandAfter < 0 && balance.handedOverPaise > 0) {
        const handoverExists = await CashHandover.exists({
          tenantId: payment.tenantId,
          staffId: payment.collectedBy,
          ...(payment.branchId ? { branchId: payment.branchId } : {}),
          status: { $in: [CashHandoverStatus.ACCEPTED, CashHandoverStatus.DISCREPANCY] },
          submittedAt: { $gte: payment.paidAt },
        }).session(session);
        if (handoverExists) {
          cashAdjustmentId = createId("cad");
          await CashAdjustment.create([{
            _id: cashAdjustmentId,
            tenantId: payment.tenantId,
            branchId: payment.branchId,
            staffId: payment.collectedBy,
            direction: CashAdjustmentDirection.CREDIT,
            amountPaise: payment.amountPaise,
            reason: `REVERSAL_AFTER_HANDOVER_ACCEPTED payment:${payment._id}`,
            createdBy: req.auth.id,
          }], { session });
        }
      }
    }
    const auditEventId = await writeAudit({
      req,
      action: "PAYMENT_REVERSED",
      entityType: AuditEntityType.PAYMENT,
      entityId: payment._id,
      after: payment.toObject(),
      metadata: cashAdjustmentId ? { cashAdjustmentId } : undefined,
      session,
    });
    return { id: payment._id, status: payment.status, auditEventId, cashAdjustmentId };
  });
}
export async function createPaymentLink(req) {
  const token = randomToken(32);
  const expiresAt = new Date(
    Date.now() + Number(req.body.expiresInMinutes ?? 1440) * 60_000,
  );
  return withTransaction(async (session) => {
    const scheme = await Scheme.findOne({
      _id: req.body.schemeId,
      ...req.scope,
    }).session(session);
    if (!scheme) throw errors.notFound("Scheme");
    const quote = await payableRange(req, scheme.toObject());
    const targetCycle = req.body.targetCycle ?? quote.targetCycle;
    let intent;
    let positionVersion = quote.positionVersion;
    if (scheme.paymentPattern === "FLEXIBLE") {
      assertExpectedPositionVersion(scheme, quote, req.body);
      await assertMaxPaymentsPerCycle({ scheme, targetCycle, session });
      const reservations = await PaymentIntent.aggregate([
        {
          $match: {
            tenantId: scheme.tenantId,
            schemeId: scheme._id,
            targetCycle,
            status: PaymentIntentStatus.PENDING,
            reservationExpiresAt: { $gt: new Date() },
          },
        },
        { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } },
      ]).session(session);
      const available = {
        ...quote,
        maxPayablePaise: Math.max(
          0,
          quote.maxPayablePaise - (reservations[0]?.amountPaise ?? 0),
        ),
      };
      checkAmount(available, req.body.amountPaise);
      scheme.positionVersion += 1;
      scheme.version += 1;
      positionVersion = scheme.positionVersion;
      await scheme.save({ session });
      intent = (
        await PaymentIntent.create(
          [
            {
              _id: createId("paymentIntent"),
              tenantId: scheme.tenantId,
              branchId: scheme.branchId,
              schemeId: scheme._id,
              customerId: scheme.customerId,
              targetCycle,
              amountPaise: req.body.amountPaise,
              positionVersion,
              reservationExpiresAt: expiresAt,
            },
          ],
          { session },
        )
      )[0];
    } else checkAmount(quote, req.body.amountPaise);
    const link = (
      await PaymentLink.create(
        [
          {
            _id: createId("paymentLink"),
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            tokenHash: sha256(token),
            amountPaise: req.body.amountPaise,
            targetCycle,
            paymentIntentId: intent?._id,
            positionVersion,
            expiresAt,
            createdBy: req.auth.id,
          },
        ],
        { session },
      )
    )[0];
    return {
      id: link._id,
      token,
      url: `/pay/${token}`,
      status: link.status,
      expiresAt: link.expiresAt,
      paymentIntentId: intent?._id,
      positionVersion,
    };
  });
}
export async function getPublicLink(token, markOpened = true) {
  const link = await PaymentLink.findOne({ tokenHash: sha256(token) });
  if (!link || link.expiresAt < new Date())
    throw new AppError(
      "PAYMENT_LINK_EXPIRED",
      "This payment link has expired.",
      410,
    );
  if (markOpened && link.status === LinkStatus.CREATED) {
    link.status = LinkStatus.OPENED;
    link.openedAt = new Date();
    await link.save();
  }
  return link;
}
async function renewFlexibleLinkReservation(link) {
  return withTransaction(async (session) => {
    const scheme = await Scheme.findById(link.schemeId).session(session);
    if (!scheme) throw errors.notFound("Scheme");
    const fakeReq = {
      auth: { tenantId: link.tenantId },
      query: { targetCycle: link.targetCycle },
      body: { targetCycle: link.targetCycle },
    };
    const quote = await payableRange(fakeReq, scheme.toObject());
    const reservations = await PaymentIntent.aggregate([
      {
        $match: {
          tenantId: link.tenantId,
          schemeId: link.schemeId,
          targetCycle: link.targetCycle,
          status: PaymentIntentStatus.PENDING,
          reservationExpiresAt: { $gt: new Date() },
        },
      },
      { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } },
    ]).session(session);
    checkAmount(
      {
        ...quote,
        maxPayablePaise: Math.max(
          0,
          quote.maxPayablePaise - (reservations[0]?.amountPaise ?? 0),
        ),
      },
      link.amountPaise,
    );
    scheme.positionVersion += 1;
    scheme.version += 1;
    await scheme.save({ session });
    const intent = (
      await PaymentIntent.create(
        [
          {
            _id: createId("paymentIntent"),
            tenantId: link.tenantId,
            branchId: link.branchId,
            schemeId: link.schemeId,
            customerId: link.customerId,
            targetCycle: link.targetCycle,
            amountPaise: link.amountPaise,
            positionVersion: scheme.positionVersion,
            reservationExpiresAt: link.expiresAt,
          },
        ],
        { session },
      )
    )[0];
    link.paymentIntentId = intent._id;
    link.positionVersion = scheme.positionVersion;
    link.paymentId = null;
    await link.save({ session });
    return link;
  });
}
function isPaymentLinkClaim(paymentId) {
  return paymentId && String(paymentId).startsWith("CLAIMING-");
}

function assertRedirectUrlAllowed(redirectUrl, tenant) {
  const allowedOrigins = new Set(env.corsOrigins);
  const brandingUrl = tenant?.branding?.websiteUrl;
  if (brandingUrl) {
    try { allowedOrigins.add(new URL(brandingUrl).origin); } catch { /* ignore invalid branding url */ }
  }
  let origin;
  try { origin = new URL(redirectUrl).origin; } catch {
    throw errors.validation([{ field: "redirectUrl", message: "redirectUrl must be a valid absolute URL." }]);
  }
  if (!allowedOrigins.has(origin)) {
    throw errors.validation([{ field: "redirectUrl", message: "redirectUrl origin is not allowed for this jeweller." }]);
  }
}

function customerCheckoutPreference() {
  return {
    preferUpiIntentOnly: env.PHONEPE_UPI_INTENT_ONLY === true,
    upiApps: env.PHONEPE_UPI_APPS,
    upiFlows: env.PHONEPE_UPI_FLOWS,
  };
}

export async function initiatePublicPayment(req) {
  let link = await getPublicLink(req.params.linkToken, false);
  const tenant = await Tenant.findById(link.tenantId).select("operations branding").lean();
  assertCustomerPaymentsEnabled(tenant);
  assertRedirectUrlAllowed(req.body.redirectUrl, tenant);
  if (link.paymentId && !isPaymentLinkClaim(link.paymentId)) {
    const existing = await Payment.findById(link.paymentId).lean();
    if (
      [
        PaymentStatus.PENDING,
        PaymentStatus.SUCCESS,
        PaymentStatus.UNALLOCATED_PENDING_REVIEW,
      ].includes(existing?.status)
    )
      return {
        paymentLinkId: link._id,
        paymentId: existing?._id,
        status: existing?.status,
      };
    if (link.paymentIntentId) link = await renewFlexibleLinkReservation(link);
  }
  const claimMarker = `CLAIMING-${createId("payment")}`;
  const claimExpiresAt = new Date(Date.now() + 5 * 60_000);
  const claimed = await PaymentLink.findOneAndUpdate(
    {
      _id: link._id,
      $and: [
        { $or: [{ paymentId: null }, { paymentId: { $exists: false } }] },
        {
          $or: [
            { initiationClaimToken: null },
            { initiationClaimToken: { $exists: false } },
            { initiationClaimExpiresAt: { $lte: new Date() } },
          ],
        },
      ],
    },
    { $set: { initiationClaimToken: claimMarker, initiationClaimExpiresAt: claimExpiresAt } },
    { new: true },
  );
  if (!claimed) {
    const current = await PaymentLink.findById(link._id).lean();
    if (current?.paymentId && !isPaymentLinkClaim(current.paymentId)) {
      const existing = await Payment.findById(current.paymentId).lean();
      return {
        paymentLinkId: current._id,
        paymentId: existing?._id,
        status: existing?.status,
      };
    }
    throw errors.business("PAYMENT_LINK_BUSY", "Another payment attempt is already in progress for this link.");
  }
  link = claimed;
  try {
    const provider = await phonePeProvider.createPayment({
      merchantOrderId: link._id,
      amountPaise: link.amountPaise,
      redirectUrl: req.body.redirectUrl,
      credentials: await gatewayCredentials(link.tenantId),
      tenantId: link.tenantId,
      ...customerCheckoutPreference(),
    });
    const pending = await Payment.create({
      _id: createId("payment"),
      tenantId: link.tenantId,
      branchId: link.branchId,
      schemeId: link.schemeId,
      customerId: link.customerId,
      receiptNumber: `PENDING-${link._id}`,
      amountPaise: link.amountPaise,
      targetCycle: link.targetCycle,
      mode: PaymentMode.ONLINE_GATEWAY,
      status: PaymentStatus.PENDING,
      source: PaymentSource.CUSTOMER_APP,
      providerTransactionId: provider.providerOrderId,
      paidAt: new Date(),
    });
    const committed = await PaymentLink.updateOne(
      { _id: link._id, initiationClaimToken: claimMarker },
      {
        $set: { paymentId: pending._id },
        $unset: { initiationClaimToken: "", initiationClaimExpiresAt: "" },
      },
    );
    if (committed.modifiedCount !== 1) {
      await Payment.deleteOne({ _id: pending._id, status: PaymentStatus.PENDING });
      throw errors.business("PAYMENT_LINK_CLAIM_LOST", "The payment-link claim expired before initiation completed.");
    }
    if (link.paymentIntentId) {
      await PaymentIntent.updateOne(
        { _id: link.paymentIntentId, status: PaymentIntentStatus.PENDING },
        {
          $set: {
            paymentId: pending._id,
            providerOrderId: provider.providerOrderId,
          },
        },
      );
    }
    return {
      paymentLinkId: link._id,
      paymentIntentId: link.paymentIntentId,
      paymentId: pending._id,
      ...provider,
    };
  } catch (error) {
    await PaymentLink.updateOne(
      { _id: link._id, initiationClaimToken: claimMarker },
      { $unset: { initiationClaimToken: "", initiationClaimExpiresAt: "" } },
    );
    throw error;
  }
}
export async function createPaymentIntent(req) {
  let reserved;
  await withTransaction(async (session) => {
    const scheme = await Scheme.findOne({
      _id: req.params.schemeId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!scheme) throw errors.notFound("Scheme");
    if (scheme.paymentPattern !== "FLEXIBLE")
      throw errors.business(
        "PAYMENT_INTENT_NOT_APPLICABLE",
        "Payment intents apply only to flexible schemes.",
      );
    const quote = await payableRange(req, scheme.toObject());
    const targetCycle = req.body.targetCycle ?? quote.targetCycle;
    assertExpectedPositionVersion(scheme, quote, req.body);
    await assertMaxPaymentsPerCycle({ scheme, targetCycle, session });
    const reservations = await PaymentIntent.aggregate([
      {
        $match: {
          tenantId: scheme.tenantId,
          schemeId: scheme._id,
          targetCycle,
          status: PaymentIntentStatus.PENDING,
          reservationExpiresAt: { $gt: new Date() },
        },
      },
      { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } },
    ]).session(session);
    const reservedPaise = reservations[0]?.amountPaise ?? 0;
    const availableQuote = {
      ...quote,
      maxPayablePaise: Math.max(0, quote.maxPayablePaise - reservedPaise),
      reservedPaise,
    };
    checkAmount(availableQuote, req.body.amountPaise);
    scheme.positionVersion += 1;
    scheme.version += 1;
    await scheme.save({ session });
    const intent = (
      await PaymentIntent.create(
        [
          {
            _id: createId("paymentIntent"),
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            targetCycle,
            amountPaise: req.body.amountPaise,
            positionVersion: scheme.positionVersion,
            reservationExpiresAt: new Date(Date.now() + 30 * 60_000),
          },
        ],
        { session },
      )
    )[0];
    const pending = (
      await Payment.create(
        [
          {
            _id: createId("payment"),
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            receiptNumber: `PENDING-${intent._id}`,
            amountPaise: intent.amountPaise,
            targetCycle,
            mode: PaymentMode.ONLINE_GATEWAY,
            status: PaymentStatus.PENDING,
            source: PaymentSource.CUSTOMER_APP,
            paidAt: new Date(),
          },
        ],
        { session },
      )
    )[0];
    intent.paymentId = pending._id;
    await intent.save({ session });
    reserved = {
      intent: intent.toObject(),
      paymentId: pending._id,
      tenantId: scheme.tenantId,
    };
  });
  try {
    const tenant = await Tenant.findById(reserved.tenantId).select("operations branding").lean();
    assertCustomerPaymentsEnabled(tenant);
    assertRedirectUrlAllowed(req.body.redirectUrl, tenant);
    const provider = await phonePeProvider.createPayment({
      merchantOrderId: reserved.intent._id,
      amountPaise: reserved.intent.amountPaise,
      redirectUrl: req.body.redirectUrl,
      credentials: await gatewayCredentials(reserved.tenantId),
      tenantId: reserved.tenantId,
      ...customerCheckoutPreference(),
    });
    await Promise.all([
      PaymentIntent.updateOne(
        { _id: reserved.intent._id, status: PaymentIntentStatus.PENDING },
        { $set: { providerOrderId: provider.providerOrderId } },
      ),
      Payment.updateOne(
        { _id: reserved.paymentId, status: PaymentStatus.PENDING },
        { $set: { providerTransactionId: provider.providerOrderId } },
      ),
    ]);
    return {
      ...reserved.intent,
      paymentId: reserved.paymentId,
      providerOrderId: provider.providerOrderId,
      redirectUrl: provider.redirectUrl,
    };
  } catch (error) {
    await withTransaction(async (session) => {
      await PaymentIntent.updateOne(
        { _id: reserved.intent._id, status: PaymentIntentStatus.PENDING },
        { $set: { status: PaymentIntentStatus.FAILED }, $inc: { version: 1 } },
        { session },
      );
      await Payment.updateOne(
        { _id: reserved.paymentId, status: PaymentStatus.PENDING },
        {
          $set: {
            status: PaymentStatus.FAILED,
            providerPayload: { initiationError: error.message },
          },
        },
        { session },
      );
      await Scheme.updateOne(
        { _id: reserved.intent.schemeId },
        { $inc: { positionVersion: 1, version: 1 } },
        { session },
      );
    });
    throw error;
  }
}

export async function createSdkPaymentIntent(req) {
  let reserved;
  await withTransaction(async (session) => {
    const scheme = await Scheme.findOne({
      _id: req.params.schemeId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!scheme) throw errors.notFound("Scheme");
    if (scheme.paymentPattern !== "FLEXIBLE")
      throw errors.business(
        "PAYMENT_INTENT_NOT_APPLICABLE",
        "SDK payment orders apply only to flexible schemes.",
      );
    const quote = await payableRange(req, scheme.toObject());
    const targetCycle = req.body.targetCycle ?? quote.targetCycle;
    assertExpectedPositionVersion(scheme, quote, req.body);
    await assertMaxPaymentsPerCycle({ scheme, targetCycle, session });
    const reservations = await PaymentIntent.aggregate([
      {
        $match: {
          tenantId: scheme.tenantId,
          schemeId: scheme._id,
          targetCycle,
          status: PaymentIntentStatus.PENDING,
          reservationExpiresAt: { $gt: new Date() },
        },
      },
      { $group: { _id: null, amountPaise: { $sum: "$amountPaise" } } },
    ]).session(session);
    const reservedPaise = reservations[0]?.amountPaise ?? 0;
    const availableQuote = {
      ...quote,
      maxPayablePaise: Math.max(0, quote.maxPayablePaise - reservedPaise),
      reservedPaise,
    };
    checkAmount(availableQuote, req.body.amountPaise);
    scheme.positionVersion += 1;
    scheme.version += 1;
    await scheme.save({ session });
    const intent = (
      await PaymentIntent.create(
        [
          {
            _id: createId("paymentIntent"),
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            targetCycle,
            amountPaise: req.body.amountPaise,
            positionVersion: scheme.positionVersion,
            reservationExpiresAt: new Date(Date.now() + 30 * 60_000),
          },
        ],
        { session },
      )
    )[0];
    const pending = (
      await Payment.create(
        [
          {
            _id: createId("payment"),
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            schemeId: scheme._id,
            customerId: scheme.customerId,
            receiptNumber: `PENDING-${intent._id}`,
            amountPaise: intent.amountPaise,
            targetCycle,
            mode: PaymentMode.ONLINE_GATEWAY,
            status: PaymentStatus.PENDING,
            source: PaymentSource.CUSTOMER_APP,
            paidAt: new Date(),
          },
        ],
        { session },
      )
    )[0];
    intent.paymentId = pending._id;
    await intent.save({ session });
    reserved = {
      intent: intent.toObject(),
      paymentId: pending._id,
      tenantId: scheme.tenantId,
    };
  });
  try {
    const tenant = await Tenant.findById(reserved.tenantId).select("operations branding").lean();
    assertCustomerPaymentsEnabled(tenant);
    assertRedirectUrlAllowed(req.body.redirectUrl, tenant);
    const provider = await phonePeProvider.createSdkOrder({
      merchantOrderId: reserved.intent._id,
      amountPaise: reserved.intent.amountPaise,
      redirectUrl: req.body.redirectUrl,
      credentials: await gatewayCredentials(reserved.tenantId),
      tenantId: reserved.tenantId,
    });
    await Promise.all([
      PaymentIntent.updateOne(
        { _id: reserved.intent._id, status: PaymentIntentStatus.PENDING },
        { $set: { providerOrderId: provider.providerOrderId } },
      ),
      Payment.updateOne(
        { _id: reserved.paymentId, status: PaymentStatus.PENDING },
        { $set: { providerTransactionId: provider.providerOrderId } },
      ),
    ]);
    return {
      ...reserved.intent,
      paymentId: reserved.paymentId,
      providerOrderId: provider.providerOrderId,
      merchantOrderId: reserved.intent._id,
      token: provider.token,
      status: provider.status,
    };
  } catch (error) {
    await withTransaction(async (session) => {
      await PaymentIntent.updateOne(
        { _id: reserved.intent._id, status: PaymentIntentStatus.PENDING },
        { $set: { status: PaymentIntentStatus.FAILED }, $inc: { version: 1 } },
        { session },
      );
      await Payment.updateOne(
        { _id: reserved.paymentId, status: PaymentStatus.PENDING },
        {
          $set: {
            status: PaymentStatus.FAILED,
            providerPayload: { initiationError: error.message },
          },
        },
        { session },
      );
      await Scheme.updateOne(
        { _id: reserved.intent.schemeId },
        { $inc: { positionVersion: 1, version: 1 } },
        { session },
      );
    });
    throw error;
  }
}

export async function cancelPaymentIntent(req) {
  return withTransaction(async (session) => {
    const intent = await PaymentIntent.findOne({
      _id: req.params.intentId,
      tenantId: req.auth.tenantId,
      customerId: req.auth.id,
    }).session(session);
    if (!intent) throw errors.notFound("Payment intent");
    if (intent.status !== PaymentIntentStatus.PENDING)
      throw new AppError(
        "PAYMENT_INTENT_NOT_PENDING",
        "Only a pending payment intent can be cancelled.",
        409,
      );
    const scheme = await Scheme.findById(intent.schemeId).session(session);
    const expected = readExpectedPositionVersion(req.body);
    if (expected != null && expected !== scheme.positionVersion)
      throw new AppError(
        "PAYMENT_POSITION_CHANGED",
        "The payable position changed. Request a fresh quote.",
        409,
      );
    intent.status = PaymentIntentStatus.CANCELLED;
    intent.version += 1;
    await intent.save({ session });
    await Payment.updateOne(
      { _id: intent.paymentId, status: PaymentStatus.PENDING },
      {
        $set: {
          status: PaymentStatus.FAILED,
          providerPayload: { cancellationReason: "CUSTOMER_CANCELLED" },
        },
      },
      { session },
    );
    scheme.positionVersion += 1;
    scheme.version += 1;
    await scheme.save({ session });
    return { ...intent.toObject(), positionVersion: scheme.positionVersion };
  });
}
export async function cancelPaymentLink(req) {
  return withTransaction(async (session) => {
    const link = await PaymentLink.findOne({
      _id: req.params.linkId,
      ...req.scope,
      status: { $in: [LinkStatus.CREATED, LinkStatus.SENT, LinkStatus.OPENED] },
    }).session(session);
    if (!link)
      throw errors.business(
        "PAYMENT_LINK_NOT_CANCELLABLE",
        "This payment link cannot be cancelled.",
      );
    link.status = LinkStatus.CANCELLED;
    await link.save({ session });
    if (link.paymentIntentId) {
      const intent = await PaymentIntent.findOneAndUpdate(
        { _id: link.paymentIntentId, status: PaymentIntentStatus.PENDING },
        {
          $set: { status: PaymentIntentStatus.CANCELLED },
          $inc: { version: 1 },
        },
        { new: true, session },
      );
      if (intent)
        await Scheme.updateOne(
          { _id: link.schemeId },
          { $inc: { positionVersion: 1, version: 1 } },
          { session },
        );
    }
    if (link.paymentId)
      await Payment.updateOne(
        { _id: link.paymentId, status: PaymentStatus.PENDING },
        {
          $set: {
            status: PaymentStatus.FAILED,
            providerPayload: { cancellationReason: "LINK_CANCELLED" },
          },
        },
        { session },
      );
    return link.toObject();
  });
}

export async function resendPaymentLink(req) {
  const link = await PaymentLink.findOne({
    _id: req.params.linkId,
    ...req.scope,
  }).lean();
  if (!link) throw errors.notFound("Payment link");
  if (!["CREATED", "SENT", "OPENED"].includes(link.status)) {
    throw errors.business(
      "PAYMENT_LINK_NOT_SENDABLE",
      "This payment link cannot be resent.",
    );
  }
  const customer = await Customer.findOne({
    _id: link.customerId,
    tenantId: link.tenantId,
  })
    .select("mobile whatsappOptedOutAt")
    .lean();
  if (!customer) throw errors.notFound("Customer");
  if (customer.whatsappOptedOutAt) {
    throw errors.business(
      "WHATSAPP_OPTED_OUT",
      "The customer has opted out of WhatsApp messages.",
    );
  }
  const created = await createPaymentLink({
    ...req,
    body: {
      schemeId: link.schemeId,
      amountPaise: link.amountPaise,
      targetCycle: link.targetCycle,
    },
  });
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Kolkata",
  });
  const { queueMessage } = await import("./messaging.service.js");
  const scheme = await Scheme.findById(link.schemeId)
    .select("enrollmentNumber branchId")
    .lean();
  await queueMessage(req, {
    branchId: link.branchId ?? scheme?.branchId,
    customerId: link.customerId,
    schemeId: link.schemeId,
    type: "PAYMENT_DUE",
    templateKey: "PAYMENT_DUE",
    templateParams: {
      mobile: customer.mobile,
      reminderDate: today,
      enrollmentNumber: scheme?.enrollmentNumber,
      paymentLinkToken: created.token,
    },
  });
  await PaymentLink.updateOne(
    { _id: link._id },
    { $set: { status: LinkStatus.CANCELLED } },
  );
  await PaymentLink.updateOne(
    { _id: created.id ?? created._id },
    { $set: { status: LinkStatus.SENT } },
  );
  return { id: created.id ?? created._id, queued: true };
}
/** @deprecated use persistVerifiedWebhook from webhook-event.service.js */
export async function persistWebhook(args) {
  const { persistVerifiedWebhook } = await import("./webhook-event.service.js");
  return persistVerifiedWebhook({
    tenantId: args.tenantId,
    provider: args.provider,
    providerEventId: args.providerEventId,
    signatureHeader: args.signature,
    rawBody: args.rawBody,
    payload: args.payload,
  });
}
