import {
  Branch,
  Customer,
  Message,
  Payment,
  PaymentLink,
  Redemption,
  Scheme,
  Tenant,
} from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { moneyPaiseFromWeightMg } from "../lib/money.js";
import { mobileLookupVariants } from "../lib/mobile.js";
import { customerNotificationDedupeKey } from "../lib/customer-notification-dto.js";
import {
  customerProfileDto,
  enrichPayableRange,
  isCustomerProfileComplete,
  buildNotificationContext,
  countUnreadDedupedNotifications,
  dedupeCustomerNotificationRows,
  mapNotification,
  mapPastSchemeRow,
  paymentPollStatusDto,
  publicPayPageDto,
  tenantBrandingDto,
  tenantResolveRow,
} from "../lib/customer-app-dto.js";
import { moneyRef, weightRef, rateRef } from "../lib/money.js";
import { monthKey, today } from "../lib/date.js";
import { SchemeStatus, RedemptionStatus, PaymentStatus, ValueBasis } from "../constants/enums.js";
import * as schemes from "./scheme.service.js";
import {
  mapCustomerPaymentListItem,
  mapCustomerSchemeDetail,
  mapHomeSchemeCard,
} from "../lib/customer-scheme-detail-dto.js";
import { paginate } from "../lib/pagination.js";
import { getPublicLink } from "./payment.service.js";
import { currentGoldRate } from "./tenant.service.js";
import { enrichCustomerKycRecord } from "../lib/customer-kyc-enrichment.js";
import { paymentRecordedByLabel } from "../lib/payment-scope.js";
import { loadUserMap } from "../lib/relation-maps.js";

export async function resolveTenants(query) {
  if (query.deepLinkToken) {
    const tenant = await Tenant.findOne({ "branding.deepLinkToken": String(query.deepLinkToken) })
      .select("_id code name branding status supportNumber mobile city settings operations")
      .lean();
    if (!tenant) throw errors.notFound("Jewellery");
    return {
      resolvedBy: "DEEP_LINK",
      tenantCode: tenant.code,
      tenants: [tenantResolveRow(tenant, "DEEP_LINK")],
    };
  }
  if (query.tenantCode) {
    const tenant = await Tenant.findOne({
      code: String(query.tenantCode).trim().toUpperCase(),
    })
      .select("_id code name branding status supportNumber mobile city settings operations")
      .lean();
    if (!tenant) throw errors.notFound("Jewellery");
    return {
      resolvedBy: "TENANT_CODE",
      tenantCode: tenant.code,
      tenants: [tenantResolveRow(tenant, "TENANT_CODE")],
    };
  }
  if (query.mobile) {
    const variants = mobileLookupVariants(query.mobile);
    const customers = await Customer.find({ mobile: { $in: variants } })
      .select("tenantId")
      .lean();
    const tenantIds = [...new Set(customers.map((c) => c.tenantId))];
    if (!tenantIds.length) throw errors.notFound("Jewellery");
    const tenants = await Tenant.find({ _id: { $in: tenantIds } })
      .select("_id code name branding status supportNumber mobile city settings operations")
      .lean();
    return {
      resolvedBy: "MOBILE",
      tenantCode: tenants.length === 1 ? tenants[0].code : null,
      tenants: tenants.map((t) => tenantResolveRow(t, "MOBILE")),
    };
  }
  throw errors.validation([{ field: "query", message: "Provide tenantCode, mobile, or deepLinkToken." }]);
}

export async function getAppProfile(auth, tenant) {
  const [customer, branch] = await Promise.all([
    Customer.findOne({ _id: auth.id, tenantId: auth.tenantId }).select("-fcmTokens").lean(),
    auth.branchId
      ? Branch.findOne({ _id: auth.branchId, tenantId: auth.tenantId }).lean()
      : null,
  ]);
  if (!customer) throw errors.notFound("Customer");
  const profile = customerProfileDto(customer, tenant, branch);
  const kycMandatory = Boolean(tenant?.settings?.requireKycForEnrolment);
  if (kycMandatory) {
    profile.kyc = await enrichCustomerKycRecord(customer, profile.kyc);
  } else {
    delete profile.kyc;
  }
  return profile;
}

export async function completeAppProfile(auth, body) {
  const allowed = {};
  for (const key of ["name", "email", "address"]) {
    if (body[key] !== undefined) allowed[key] = body[key];
  }
  allowed.profileCompletedAt = new Date();
  const customer = await Customer.findOneAndUpdate(
    { _id: auth.id, tenantId: auth.tenantId },
    { $set: allowed, $inc: { version: 1 } },
    { new: true },
  )
    .select("-fcmTokens")
    .lean();
  const tenant = await Tenant.findById(auth.tenantId).lean();
  const branch = customer.branchId
    ? await Branch.findById(customer.branchId).lean()
    : null;
  const profile = customerProfileDto(customer, tenant, branch);
  if (tenant?.settings?.requireKycForEnrolment !== true) {
    delete profile.kyc;
  }
  return profile;
}

export async function buildHome(auth, tenant, query = {}) {
  const includeTrends = query.includeTrends === "true" || query.includeTrends === true;
  const trendMonths = Number(query.trendMonths) || 6;
  const [customer, activeSchemesRaw, pastSchemes, unreadRows, goldRate] = await Promise.all([
    Customer.findById(auth.id).lean(),
    Scheme.find({
      tenantId: auth.tenantId,
      customerId: auth.id,
      status: { $in: ["PENDING_PAYMENT", "ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] },
    }).lean(),
    Scheme.find({
      tenantId: auth.tenantId,
      customerId: auth.id,
      status: { $in: [SchemeStatus.REDEEMED, SchemeStatus.CLOSED_PREMATURE] },
    })
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean(),
    Message.find({ tenantId: auth.tenantId, customerId: auth.id, readAt: null })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean(),
    currentGoldRate({ tenantId: auth.tenantId, branchId: auth.branchId }, today()),
  ]);
  const unreadCount = countUnreadDedupedNotifications(unreadRows);
  const activeSchemes = await schemes.attachLedgerTotals(auth.tenantId, activeSchemesRaw);
  const hasGoldAccumulationScheme = Boolean(
    await Scheme.exists({
      tenantId: auth.tenantId,
      customerId: auth.id,
      valueBasis: ValueBasis.GOLD_WEIGHT,
    }),
  );
  const payments = await Payment.find({
    tenantId: auth.tenantId,
    customerId: auth.id,
    status: { $in: [PaymentStatus.SUCCESS, PaymentStatus.PARTIALLY_REFUNDED] },
  })
    .select("amountPaise weightMg refundedAmountPaise refundedWeightMg paidAt")
    .lean();
  const totalPaidPaise = payments.reduce(
    (s, p) => s + (p.amountPaise ?? 0) - (p.refundedAmountPaise ?? 0),
    0,
  );
  const goldMg = payments.reduce(
    (s, p) => s + (p.weightMg ?? 0) - (p.refundedWeightMg ?? 0),
    0,
  );
  const currentValuePaise =
    goldRate?.ratePerGramPaise && goldMg > 0
      ? moneyPaiseFromWeightMg(goldMg, goldRate.ratePerGramPaise)
      : totalPaidPaise;
  const firstName = customer?.name?.trim()?.split(/\s+/)[0] ?? "there";
  const hour = new Date().getHours();
  const greetingText =
    hour < 12 ? `Good morning, ${firstName}` : hour < 17 ? `Good afternoon, ${firstName}` : `Good evening, ${firstName}`;
  const actionCard = pickActionCard(activeSchemes);
  const passbookNumber = customer?.passbookNumber ?? null;
  const activeSchemeCards = await mapActiveSchemeCardsForCustomer(
    auth.tenantId,
    auth.id,
    passbookNumber,
    activeSchemes.slice(0, 6),
  );
  const recentPayments = await recentPaymentsForHome(auth, 8);
  return {
    tenant: tenantBrandingDto(tenant),
    customer: {
      id: auth.id,
      name: customer?.name,
      profileComplete: isCustomerProfileComplete(customer),
      passbookNumber,
    },
    greeting: {
      text: greetingText,
      subtext:
        activeSchemes.length === 0
          ? "Start a scheme to begin saving."
          : `${activeSchemes.length} active scheme${activeSchemes.length === 1 ? "" : "s"}.`,
    },
    hasGoldAccumulationScheme,
    summary: {
      activeSchemeCount: activeSchemes.length,
      pastSchemeCount: pastSchemes.length,
      totalPaid: moneyRef(totalPaidPaise),
      goldAccumulated: hasGoldAccumulationScheme ? weightRef(goldMg) : undefined,
      currentValuation: hasGoldAccumulationScheme ? moneyRef(currentValuePaise) : undefined,
    },
    goldRate:
      hasGoldAccumulationScheme && goldRate
        ? {
            ...rateRef(goldRate.ratePerGramPaise),
            effectiveDate: goldRate.effectiveDate,
            purity: goldRate.purity ?? "22K",
            movement: goldRate.movement ?? null,
          }
        : null,
    actionCard,
    activeSchemes: activeSchemeCards,
    recentPayments,
    pastSchemesPreview: pastSchemes.map((s) => ({
      id: s._id,
      schemeNumber: s.enrollmentNumber,
      status: s.status,
    })),
    quickActions: [
      { key: "PAY", label: "Pay instalment", enabled: activeSchemes.some((s) => ["PENDING_PAYMENT", "ACTIVE"].includes(s.status)) },
      { key: "ENROL", label: "Enrol in plan", enabled: true },
      { key: "PASSBOOK", label: "Passbook", enabled: activeSchemes.length > 0 },
    ],
    unreadNotificationCount: unreadCount,
    contributionTrend: includeTrends ? await contributionTrend(auth, trendMonths) : undefined,
    goldAccumulationTrend:
      hasGoldAccumulationScheme && includeTrends ? await goldTrend(auth, trendMonths) : undefined,
    emptyState: activeSchemes.length === 0 ? { message: "No active schemes yet.", cta: "Browse plans" } : null,
    cacheTtlSeconds: 60,
  };
}

function pickActionCard(schemesList) {
  const due = schemesList.find((s) =>
    (s.installments ?? []).some((i) => ["DUE", "OVERDUE"].includes(i.status)),
  );
  if (due) {
    const card = mapHomeSchemeCard(due);
    return {
      type: "PAY_DUE",
      schemeId: due._id,
      title: "Instalment due",
      priority: "HIGH",
      planName: card.planName,
      subtitle: card.nextActionAmount
        ? `${card.nextActionAmount.amountDisplay}${card.nextActionLabel.includes("·") ? ` · ${card.nextActionLabel.split("·").pop()?.trim()}` : ""}`
        : card.nextActionLabel,
    };
  }
  const matured = schemesList.find((s) => s.status === "MATURED");
  if (matured) {
    const card = mapHomeSchemeCard(matured);
    return {
      type: "REDEEM",
      schemeId: matured._id,
      title: "Scheme matured",
      priority: "MEDIUM",
      planName: card.planName,
      subtitle: card.maturityDate ? `Maturity ${card.maturityDate}` : null,
    };
  }
  return null;
}

export async function mapActiveSchemeCardsForCustomer(tenantId, customerId, passbookNumber, schemeRows) {
  if (!schemeRows.length) return [];
  const schemeIds = schemeRows.map((row) => row._id);
  const payments = await Payment.find({
    tenantId,
    customerId,
    schemeId: { $in: schemeIds },
    status: PaymentStatus.SUCCESS,
  })
    .sort({ paidAt: -1 })
    .lean();
  const recentByScheme = new Map();
  for (const payment of payments) {
    const key = String(payment.schemeId);
    const list = recentByScheme.get(key) ?? [];
    if (list.length < 3) {
      list.push({
        id: payment._id,
        amount: moneyRef(payment.amountPaise ?? 0),
        paidAt: payment.paidAt ?? payment.createdAt,
        receiptNumber: payment.receiptNumber ?? undefined,
      });
    }
    recentByScheme.set(key, list);
  }
  return schemeRows.map((scheme) =>
    mapHomeSchemeCard(scheme, {
      passbookNumber,
      recentPayments: recentByScheme.get(String(scheme._id)) ?? [],
    }),
  );
}

async function recentPaymentsForHome(auth, limit = 8) {
  const rows = await Payment.find({
    tenantId: auth.tenantId,
    customerId: auth.id,
    status: PaymentStatus.SUCCESS,
  })
    .sort({ paidAt: -1 })
    .limit(limit)
    .lean();
  if (!rows.length) return [];
  const schemeIds = [...new Set(rows.map((row) => row.schemeId))];
  const schemeDocs = await Scheme.find({ _id: { $in: schemeIds } })
    .select("_id enrollmentNumber planSnapshot.name planSnapshot.displayName")
    .lean();
  const schemeMap = new Map(schemeDocs.map((row) => [String(row._id), row]));
  return rows.map((payment) => {
    const scheme = schemeMap.get(String(payment.schemeId));
    return {
      id: payment._id,
      amount: moneyRef(payment.amountPaise ?? 0),
      paidAt: payment.paidAt ?? payment.createdAt,
      receiptNumber: payment.receiptNumber ?? undefined,
      schemeId: payment.schemeId,
      schemeNumber: scheme?.enrollmentNumber ?? "",
      schemeName: scheme?.planSnapshot?.displayName ?? scheme?.planSnapshot?.name ?? "",
    };
  });
}

async function contributionTrend(auth, months) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const rows = await Payment.aggregate([
    {
      $match: {
        tenantId: auth.tenantId,
        customerId: auth.id,
        status: PaymentStatus.SUCCESS,
        paidAt: { $gte: since },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
        amountPaise: { $sum: "$amountPaise" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ month: r._id, amount: moneyRef(r.amountPaise) }));
}

async function goldTrend(auth, months) {
  const since = new Date();
  since.setMonth(since.getMonth() - months);
  const rows = await Payment.aggregate([
    {
      $match: {
        tenantId: auth.tenantId,
        customerId: auth.id,
        status: PaymentStatus.SUCCESS,
        paidAt: { $gte: since },
        weightMg: { $gt: 0 },
      },
    },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$paidAt" } },
        weightMg: { $sum: "$weightMg" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((r) => ({ month: r._id, weight: weightRef(r.weightMg) }));
}

async function paymentBlockForScheme(scheme) {
  if (scheme.valueBasis !== ValueBasis.GOLD_WEIGHT) return null;
  const rate = await currentGoldRate(
    { tenantId: scheme.tenantId, branchId: scheme.branchId },
    today(),
  );
  if (rate) return null;
  return {
    code: "GOLD_RATE_NOT_SET",
    message:
      "Today's gold rate is not published yet. Payments will open once your jeweller sets the rate.",
  };
}

export async function getSchemeDetailForApp(req) {
  const raw = await schemes.getScheme(req);
  let payableRange;
  if (["ACTIVE", "LOCKED", "DEFAULTED"].includes(raw.status)) {
    try {
      const payReq = {
        ...req,
        query: {
          ...req.query,
          targetCycle: req.query?.targetCycle ?? monthKey(),
        },
      };
      payableRange = await payableRangeForApp(payReq);
    } catch {
      payableRange = undefined;
    }
  }
  const [customer, paymentBlock] = await Promise.all([
    Customer.findById(req.auth.id).select("passbookNumber").lean(),
    paymentBlockForScheme(raw),
  ]);
  return mapCustomerSchemeDetail({
    ...raw,
    payableRange,
    passbookNumber: customer?.passbookNumber ?? null,
    paymentBlock,
  });
}

export async function payableRangeForApp(req) {
  const raw = await schemes.payableRange(req);
  const scheme = await Scheme.findOne({
    _id: req.params.schemeId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  return enrichPayableRange(raw, scheme);
}

export async function listSchemesForApp(req) {
  const result = await schemes.listSchemes(req);
  if (req.query.group === "PAST") {
    const schemeIds = result.data.map((s) => s._id);
    const redemptions = await Redemption.find({
      tenantId: req.auth.tenantId,
      schemeId: { $in: schemeIds },
      status: RedemptionStatus.COMPLETED,
    }).lean();
    const byScheme = new Map(redemptions.map((r) => [r.schemeId, r]));
    result.data = result.data.map((s) => mapPastSchemeRow(s, byScheme.get(s._id)));
  } else {
    result.data = await schemes.attachLedgerTotals(req.auth.tenantId, result.data);
    const customer = await Customer.findById(req.auth.id).select("passbookNumber").lean();
    result.data = await mapActiveSchemeCardsForCustomer(
      req.auth.tenantId,
      req.auth.id,
      customer?.passbookNumber ?? null,
      result.data,
    );
  }
  return result;
}

export async function publicPayStatus(linkToken) {
  let link = await getPublicLink(linkToken, false);
  let payment = link.paymentId ? await Payment.findById(link.paymentId).lean() : null;
  payment = await (
    await import("./payment.service.js")
  ).maybeCompleteMockGatewayPayment({
    tenantId: link.tenantId,
    link,
    payment,
  });
  if (payment?.status === "SUCCESS") {
    link = (await PaymentLink.findById(link._id).lean()) ?? link;
  }
  const [tenant, customer, scheme] = await Promise.all([
    Tenant.findById(link.tenantId).lean(),
    Customer.findById(link.customerId).select("name mobile").lean(),
    Scheme.findById(link.schemeId).lean(),
  ]);
  const canPay = !["PAID", "EXPIRED", "CANCELLED"].includes(link.status);
  const page = publicPayPageDto({
    link,
    tenant,
    customer,
    scheme,
    canPay,
    message: canPay ? null : "This payment link is no longer active.",
  });
  const poll = paymentPollStatusDto({ link, payment, scheme });
  return { ...page, poll };
}

export async function authenticatedLinkStatus(auth, linkId) {
  const link = await PaymentLink.findOne({
    _id: linkId,
    tenantId: auth.tenantId,
    customerId: auth.id,
  }).lean();
  if (!link) throw errors.notFound("Payment link");
  const payment = link.paymentId ? await Payment.findById(link.paymentId).lean() : null;
  const scheme =
    payment?.status === "SUCCESS"
      ? await Scheme.findById(link.schemeId).lean()
      : null;
  return paymentPollStatusDto({ link, payment, scheme });
}

export async function listPaymentsForApp(req) {
  const scope = { tenantId: req.auth.tenantId, customerId: req.auth.id };
  const result = await paginate(Payment, {
    scope,
    filters: {},
    cursor: req.query.cursor,
    limit: Math.min(Number(req.query.limit) || 50, 100),
    sort: "paidAt:desc",
  });
  const activeSchemeCount = await Scheme.countDocuments({
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
    status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] },
  });
  if (!result.data.length) {
    return {
      data: [],
      meta: {
        ...result.meta,
        summary: { totalPaidPaise: 0, successCount: 0, activeSchemeCount },
      },
    };
  }
  const schemeIds = [...new Set(result.data.map((row) => row.schemeId).filter(Boolean))];
  const staffIds = [...new Set(result.data.map((row) => row.collectedBy).filter(Boolean))];
  const [schemeDocs, staffMap] = await Promise.all([
    Scheme.find({ _id: { $in: schemeIds } })
      .select("_id enrollmentNumber planSnapshot paymentPattern valueBasis")
      .lean(),
    loadUserMap(staffIds),
  ]);
  const schemeMap = new Map(schemeDocs.map((row) => [String(row._id), row]));
  const data = result.data.map((payment) => {
    const scheme = schemeMap.get(String(payment.schemeId)) ?? {
      _id: payment.schemeId,
      enrollmentNumber: "",
      planSnapshot: {},
      paymentPattern: "FIXED",
    };
    const collector = staffMap.get(payment.collectedBy);
    const enriched = {
      ...payment,
      recordedByLabel: paymentRecordedByLabel(payment, collector),
    };
    return mapCustomerPaymentListItem(enriched, scheme);
  });
  const successRows = result.data.filter((row) => row.status === PaymentStatus.SUCCESS);
  const totalPaidPaise = successRows.reduce((sum, row) => sum + (row.amountPaise ?? 0), 0);
  return {
    data,
    meta: {
      ...result.meta,
      summary: {
        totalPaidPaise,
        successCount: successRows.length,
        activeSchemeCount,
      },
    },
  };
}

export async function getPaymentForApp(req) {
  const payment = await Payment.findOne({
    _id: req.params.paymentId,
    tenantId: req.auth.tenantId,
    customerId: req.auth.id,
  }).lean();
  if (!payment) throw errors.notFound("Payment");
  const scheme = await Scheme.findOne({ _id: payment.schemeId })
    .select("_id enrollmentNumber planSnapshot paymentPattern")
    .lean();
  if (!scheme) throw errors.notFound("Scheme");
  return mapCustomerPaymentListItem(payment, scheme);
}

export async function listNotifications(auth) {
  const limit = Number(auth.limit) || 50;
  const rows = await Message.find({ tenantId: auth.tenantId, customerId: auth.id })
    .sort({ createdAt: -1 })
    .limit(Math.min(limit * 3, 150))
    .lean();
  const unreadRows = await Message.find({
    tenantId: auth.tenantId,
    customerId: auth.id,
    readAt: null,
  })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean();
  const unreadCount = countUnreadDedupedNotifications(unreadRows);
  const deduped = dedupeCustomerNotificationRows(rows).slice(0, limit);
  const paymentIds = [
    ...new Set(
      deduped
        .map((row) => row.templateParams?.paymentId)
        .filter(Boolean)
        .map(String),
    ),
  ];
  const schemeIds = [
    ...new Set(deduped.map((row) => row.schemeId).filter(Boolean).map(String)),
  ];
  const [payments, schemes] = await Promise.all([
    paymentIds.length
      ? Payment.find({ _id: { $in: paymentIds }, customerId: auth.id })
          .select("_id amountPaise receiptNumber schemeId")
          .lean()
      : [],
    schemeIds.length
      ? Scheme.find({ _id: { $in: schemeIds }, customerId: auth.id })
          .select("_id enrollmentNumber planSnapshot")
          .lean()
      : [],
  ]);
  const ctx = buildNotificationContext({ payments, schemes });
  return {
    items: deduped.map((row) => mapNotification(row, ctx)),
    unreadCount,
  };
}

export async function markNotificationRead(auth, messageId) {
  const row = await Message.findOne({
    _id: messageId,
    tenantId: auth.tenantId,
    customerId: auth.id,
  }).lean();
  if (!row) throw errors.notFound("Notification");
  const now = new Date();
  const dedupeKey = customerNotificationDedupeKey(row);
  const unread = await Message.find({
    tenantId: auth.tenantId,
    customerId: auth.id,
    readAt: null,
  }).lean();
  const ids = unread
    .filter((candidate) => customerNotificationDedupeKey(candidate) === dedupeKey)
    .map((candidate) => candidate._id);
  if (ids.length) {
    await Message.updateMany({ _id: { $in: ids } }, { $set: { readAt: now } });
  }
  return { read: true, readAt: now.toISOString() };
}
