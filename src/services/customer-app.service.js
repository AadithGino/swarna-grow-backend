import {
  Branch,
  Customer,
  GoldRate,
  Message,
  Payment,
  PaymentLink,
  Redemption,
  Scheme,
  Tenant,
} from "../models/index.js";
import { errors } from "../lib/app-error.js";
import { mobileLookupVariants } from "../lib/mobile.js";
import {
  customerProfileDto,
  enrichPayableRange,
  isCustomerProfileComplete,
  mapNotification,
  mapPastSchemeRow,
  paymentPollStatusDto,
  publicPayPageDto,
  tenantBrandingDto,
  tenantResolveRow,
  withId,
} from "../lib/customer-app-dto.js";
import { moneyRef, weightRef, rateRef } from "../lib/money.js";
import { today } from "../lib/date.js";
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
  for (const key of ["name", "email", "dateOfBirth", "address"]) {
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
  if (!Boolean(tenant?.settings?.requireKycForEnrolment)) {
    delete profile.kyc;
  }
  return profile;
}

export async function buildHome(auth, tenant, query = {}) {
  const includeTrends = query.includeTrends === "true" || query.includeTrends === true;
  const trendMonths = Number(query.trendMonths) || 6;
  const [customer, activeSchemesRaw, pastSchemes, unreadCount, goldRate] = await Promise.all([
    Customer.findById(auth.id).lean(),
    Scheme.find({
      tenantId: auth.tenantId,
      customerId: auth.id,
      status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED", "MATURED"] },
    }).lean(),
    Scheme.find({
      tenantId: auth.tenantId,
      customerId: auth.id,
      status: { $in: [SchemeStatus.REDEEMED, SchemeStatus.CLOSED_PREMATURE] },
    })
      .sort({ updatedAt: -1 })
      .limit(5)
      .lean(),
    Message.countDocuments({ tenantId: auth.tenantId, customerId: auth.id, readAt: null }),
    currentGoldRate({ tenantId: auth.tenantId, branchId: auth.branchId }, today()),
  ]);
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
    status: PaymentStatus.SUCCESS,
  })
    .select("amountPaise weightMg paidAt")
    .lean();
  const totalPaidPaise = payments.reduce((s, p) => s + (p.amountPaise ?? 0), 0);
  const goldMg = payments.reduce((s, p) => s + (p.weightMg ?? 0), 0);
  const currentValuePaise =
    goldRate?.ratePerGramPaise && goldMg
      ? Math.round((goldMg * goldRate.ratePerGramPaise) / 1000)
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
      { key: "PAY", label: "Pay instalment", enabled: activeSchemes.some((s) => s.status === "ACTIVE") },
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

export async function getSchemeDetailForApp(req) {
  const raw = await schemes.getScheme(req);
  let payableRange;
  if (["ACTIVE", "LOCKED", "DEFAULTED"].includes(raw.status)) {
    try {
      payableRange = await payableRangeForApp(req);
    } catch {
      payableRange = undefined;
    }
  }
  const customer = await Customer.findById(req.auth.id).select("passbookNumber").lean();
  return mapCustomerSchemeDetail({
    ...raw,
    payableRange,
    passbookNumber: customer?.passbookNumber ?? null,
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
  const link = await getPublicLink(linkToken, false);
  const [tenant, customer, scheme, payment] = await Promise.all([
    Tenant.findById(link.tenantId).lean(),
    Customer.findById(link.customerId).select("name mobile").lean(),
    Scheme.findById(link.schemeId).lean(),
    link.paymentId ? Payment.findById(link.paymentId).lean() : null,
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
  const schemeDocs = await Scheme.find({ _id: { $in: schemeIds } })
    .select("_id enrollmentNumber planSnapshot paymentPattern")
    .lean();
  const schemeMap = new Map(schemeDocs.map((row) => [String(row._id), row]));
  const data = result.data.map((payment) => {
    const scheme = schemeMap.get(String(payment.schemeId)) ?? {
      _id: payment.schemeId,
      enrollmentNumber: "",
      planSnapshot: {},
      paymentPattern: "FIXED",
    };
    return mapCustomerPaymentListItem(payment, scheme);
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
  const rows = await Message.find({ tenantId: auth.tenantId, customerId: auth.id })
    .sort({ createdAt: -1 })
    .limit(Number(auth.limit) || 50)
    .lean();
  const unreadCount = await Message.countDocuments({
    tenantId: auth.tenantId,
    customerId: auth.id,
    readAt: null,
  });
  return {
    items: rows.map(mapNotification),
    unreadCount,
  };
}
