import argon2 from "argon2";
import {
  AuditEntityType,
  CashHandoverStatus,
  CustomerStatus,
  PaymentMode,
  RedemptionStatus,
  SchemeStatus,
  TenantRole,
  UserStatus,
  UserType,
} from "../constants/enums.js";
import { ROLE_PERMISSIONS } from "../constants/permissions.js";
import { revokeSessionsForUser } from "./auth.service.js";
import { bumpSecurityVersion } from "../lib/security-version.js";
import {
  Branch,
  CashHandover,
  Customer,
  GoldRate,
  Payment,
  Redemption,
  Scheme,
  SchemePlan,
  Session,
  Tenant,
  User,
} from "../models/index.js";
import { createId } from "../lib/ids.js";
import {
  NET_COLLECTION_PAYMENT_STATUSES,
  netCollectionStatusFilter,
  sumNetAmountPaise,
} from "../lib/payment-net-aggregation.js";
import { errors, AppError } from "../lib/app-error.js";
import { withTransaction } from "../lib/transaction.js";
import { paginate } from "../lib/pagination.js";
import {
  dateMatch,
  effectiveScope,
  searchRegex,
} from "../lib/query-filters.js";
import { now } from "../lib/date.js";
import { moneyRef } from "../lib/money.js";
import {
  formatTrendBucketLabel,
  inferTrendGroupBy,
  iteratePeriodBuckets,
  weekStartYmd,
} from "../lib/analytics-period.js";
import { writeAudit } from "./audit.service.js";
import { cashBalance } from "./cash.service.js";
import { assertWithinLimit } from "../lib/tenant-limits.js";
import { generateTemporaryPassword } from "../lib/password-generator.js";
import {
  PASSWORD_PIN_MESSAGE,
  passwordPolicySchema,
} from "../validators/common.validators.js";

function resolveTemporaryPassword(raw) {
  const value = raw ?? generateTemporaryPassword();
  const parsed = passwordPolicySchema.safeParse(value);
  if (!parsed.success) {
    throw errors.validation([
      { field: "temporaryPassword", message: PASSWORD_PIN_MESSAGE },
    ]);
  }
  return parsed.data;
}

const dayStart = () => now().startOf("day").toDate();
const monthStart = () => now().startOf("month").toDate();
const TENANT_WIDE_ROLES = new Set([
  TenantRole.TENANT_OWNER,
  TenantRole.TENANT_ADMIN,
]);
const CASH_STAFF_ROLES = [TenantRole.BRANCH_STAFF, TenantRole.BRANCH_MANAGER, TenantRole.COLLECTION_AGENT];
const OPEN_SCHEME_STATUSES = [
  SchemeStatus.ACTIVE,
  SchemeStatus.LOCKED,
  SchemeStatus.DEFAULTED,
];

function branchAddressForCreate(address) {
  if (address == null) return undefined;
  if (typeof address === "string") {
    const line1 = address.trim();
    return line1 ? { line1 } : undefined;
  }
  if (typeof address !== "object" || Array.isArray(address)) return undefined;
  const next = {};
  for (const key of ["line1", "city", "pincode"]) {
    const value = address[key];
    if (typeof value === "string" && value.trim()) next[key] = value.trim();
  }
  return Object.keys(next).length ? next : undefined;
}

function normalizeBranchAddress(branch) {
  const address = branch?.address;
  if (address && typeof address === "object") {
    return {
      line1: address.line1 ?? null,
      city: address.city ?? branchCityLabel(branch),
      pincode: address.pincode ?? null,
    };
  }
  const city = branchCityLabel(branch);
  return city ? { line1: null, city, pincode: null } : null;
}

async function branchActiveCashStaff(tenantId, branchId) {
  return User.find({
    tenantId,
    branchId,
    type: UserType.TENANT_USER,
    status: UserStatus.ACTIVE,
    role: { $in: CASH_STAFF_ROLES },
  })
    .select("_id")
    .lean();
}

async function branchTotalCashInHandPaise(tenantId, branchId) {
  const staff = await branchActiveCashStaff(tenantId, branchId);
  if (!staff.length) return 0;
  const balances = await Promise.all(
    staff.map((row) => cashBalance({ tenantId, branchId, staffId: row._id })),
  );
  return balances.reduce((sum, row) => sum + (row.cashInHandPaise ?? 0), 0);
}

async function branchCashTotals(tenantId, branchId) {
  const staff = await branchActiveCashStaff(tenantId, branchId);
  const handoverScope = { tenantId, branchId };
  const paymentCashMatch = {
    tenantId,
    branchId,
    mode: PaymentMode.CASH,
    ...netCollectionStatusFilter(),
  };
  const [staffBalances, cashCollectedRow, handedOverRow, lastHandover] =
    await Promise.all([
      Promise.all(
        staff.map((row) =>
          cashBalance({ tenantId, branchId, staffId: row._id }),
        ),
      ),
      Payment.aggregate([
        { $match: paymentCashMatch },
        { $group: { _id: null, amountPaise: sumNetAmountPaise() } },
      ]),
      CashHandover.aggregate([
        {
          $match: {
            ...handoverScope,
            status: {
              $in: [
                CashHandoverStatus.ACCEPTED,
                CashHandoverStatus.DISCREPANCY,
              ],
            },
          },
        },
        {
          $group: {
            _id: null,
            amountPaise: {
              $sum: {
                $ifNull: [
                  "$acceptedAmountPaise",
                  {
                    $subtract: [
                      "$amountPaise",
                      { $ifNull: ["$discrepancyPaise", 0] },
                    ],
                  },
                ],
              },
            },
          },
        },
      ]),
      CashHandover.findOne({
        ...handoverScope,
        status: {
          $in: [
            CashHandoverStatus.ACCEPTED,
            CashHandoverStatus.DISCREPANCY,
            CashHandoverStatus.REJECTED,
          ],
        },
      })
        .sort({ settledAt: -1, submittedAt: -1, createdAt: -1 })
        .select("settledAt submittedAt")
        .lean(),
    ]);
  const cashInHandPaise = staffBalances.reduce(
    (sum, row) => sum + (row.cashInHandPaise ?? 0),
    0,
  );
  const cashPendingAcceptancePaise = staffBalances.reduce(
    (sum, row) => sum + (row.cashPendingAcceptancePaise ?? 0),
    0,
  );
  return {
    cashInHandPaise,
    cashPendingAcceptancePaise,
    cashCollectedPaise: cashCollectedRow[0]?.amountPaise ?? 0,
    handedOverPaise: handedOverRow[0]?.amountPaise ?? 0,
    lastHandoverAt:
      lastHandover?.settledAt ?? lastHandover?.submittedAt ?? null,
  };
}

function branchCityLabel(branch) {
  const address = branch?.address;
  if (address && typeof address === "object" && address.city)
    return String(address.city);
  if (typeof address === "string" && address.trim()) return address.trim();
  const parts = String(branch?.name ?? "")
    .split("—")
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length >= 2) return parts[parts.length - 1];
  return null;
}

function presentBranchListRow(branch, stats) {
  const city = branchCityLabel(branch);
  return {
    id: branch._id,
    _id: branch._id,
    name: branch.name,
    code: branch.code,
    city: city ?? "—",
    address: branch.address ?? null,
    stats: {
      staffCount: stats?.staffCount ?? 0,
      activeCustomers: stats?.activeCustomers ?? 0,
    },
    staff: stats?.staffCount ?? 0,
    customers: stats?.activeCustomers ?? 0,
    status: branch.active === false ? "INACTIVE" : "ACTIVE",
    active: branch.active !== false,
  };
}

function presentStaffListRow(user, { branch, todayPaise, activeSessions }) {
  const tenantWide = !user.branchId && TENANT_WIDE_ROLES.has(user.role);
  return {
    id: user._id,
    _id: user._id,
    name: user.name,
    role: user.role,
    status: user.status,
    mobile: user.mobile,
    email: user.email,
    branch: branch
      ? { id: branch._id, name: branch.name, code: branch.code }
      : tenantWide
        ? { id: null, name: "All branches" }
        : null,
    performance: { collectionTodayPaise: todayPaise ?? 0 },
    activeSessions: activeSessions ?? 0,
    lastLoginAt: user.lastSeenAt ?? null,
    lastSeenAt: user.lastSeenAt ?? null,
  };
}

async function aggregateCountsByField(
  model,
  tenantId,
  field,
  ids,
  matchExtra = {},
) {
  if (!ids.length) return new Map();
  const rows = await model.aggregate([
    { $match: { tenantId, [field]: { $in: ids }, ...matchExtra } },
    { $group: { _id: `$${field}`, count: { $sum: 1 } } },
  ]);
  return new Map(rows.map((row) => [row._id, row.count]));
}

export async function listStaffForAdmin(req) {
  const scope = effectiveScope(req);
  const filters = { type: UserType.TENANT_USER };
  if (req.query.status) filters.status = req.query.status;
  if (req.query.role) filters.role = req.query.role;
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    filters.$or = [{ name: pattern }, { mobile: pattern }, { email: pattern }];
  }
  const page = await paginate(User, {
    scope: {
      tenantId: scope.tenantId,
      ...(scope.branchId ? { branchId: scope.branchId } : {}),
    },
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: req.query.sort ?? "name:asc",
    projection: "-passwordHash",
  });
  const staffRows = page.data;
  const staffIds = staffRows.map((row) => row._id);
  const branchIds = [
    ...new Set(staffRows.map((row) => row.branchId).filter(Boolean)),
  ];
  const [branches, todayRows, sessionRows] = await Promise.all([
    branchIds.length
      ? Branch.find({ tenantId: req.auth.tenantId, _id: { $in: branchIds } })
          .select("_id name code")
          .lean()
      : [],
    staffIds.length
      ? Payment.aggregate([
          {
            $match: {
              tenantId: req.auth.tenantId,
              ...netCollectionStatusFilter(),
              collectedBy: { $in: staffIds },
              paidAt: { $gte: dayStart() },
            },
          },
          {
            $group: {
              _id: "$collectedBy",
              amountPaise: sumNetAmountPaise(),
            },
          },
        ])
      : [],
    staffIds.length
      ? Session.aggregate([
          {
            $match: {
              tenantId: req.auth.tenantId,
              userId: { $in: staffIds },
              expiresAt: { $gt: new Date() },
              revokedAt: { $exists: false },
              $or: [{ consumedAt: { $exists: false } }, { consumedAt: null }],
            },
          },
          { $group: { _id: "$userId", count: { $sum: 1 } } },
        ])
      : [],
  ]);
  const branchMap = new Map(branches.map((row) => [row._id, row]));
  const todayMap = new Map(todayRows.map((row) => [row._id, row.amountPaise]));
  const sessionMap = new Map(sessionRows.map((row) => [row._id, row.count]));
  page.data = staffRows.map((user) =>
    presentStaffListRow(user, {
      branch: user.branchId ? branchMap.get(user.branchId) : null,
      todayPaise: todayMap.get(user._id) ?? 0,
      activeSessions: sessionMap.get(user._id) ?? 0,
    }),
  );
  return page;
}

export async function listBranchesForAdmin(req) {
  const filters = {};
  if (req.query.active === "true") filters.active = true;
  if (req.query.active === "false") filters.active = false;
  const pattern = searchRegex(req.query.q);
  if (pattern) {
    filters.$or = [{ name: pattern }, { code: pattern }, { mobile: pattern }];
  }
  const page = await paginate(Branch, {
    scope: { tenantId: req.auth.tenantId },
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: req.query.sort ?? "name:asc",
  });
  const branchIds = page.data.map((row) => row._id);
  const [staffCounts, customerCounts] = await Promise.all([
    aggregateCountsByField(User, req.auth.tenantId, "branchId", branchIds, {
      type: UserType.TENANT_USER,
      status: UserStatus.ACTIVE,
    }),
    aggregateCountsByField(Customer, req.auth.tenantId, "branchId", branchIds, {
      status: CustomerStatus.ACTIVE,
    }),
  ]);
  page.data = page.data.map((branch) =>
    presentBranchListRow(branch, {
      staffCount: staffCounts.get(branch._id) ?? 0,
      activeCustomers: customerCounts.get(branch._id) ?? 0,
    }),
  );
  return page;
}

async function staffActiveSessionCount(tenantId, staffId) {
  const [row] = await Session.aggregate([
    {
      $match: {
        tenantId,
        userId: staffId,
        expiresAt: { $gt: new Date() },
        revokedAt: { $exists: false },
        $or: [{ consumedAt: { $exists: false } }, { consumedAt: null }],
      },
    },
    { $count: "count" },
  ]);
  return row?.count ?? 0;
}

async function staffMonthPerformance(tenantId, staffId) {
  const since = monthStart();
  const paymentMatch = {
    tenantId,
    ...netCollectionStatusFilter(),
    collectedBy: staffId,
    paidAt: { $gte: since },
  };
  const [collectionRow, enrolmentsThisMonth, customersServedThisMonth] =
    await Promise.all([
      Payment.aggregate([
        { $match: paymentMatch },
        { $group: { _id: null, amountPaise: sumNetAmountPaise() } },
      ]),
      Scheme.countDocuments({
        tenantId,
        createdBy: staffId,
        createdAt: { $gte: since },
      }),
      Payment.distinct("customerId", paymentMatch),
    ]);
  return {
    collectionThisMonthPaise: collectionRow[0]?.amountPaise ?? 0,
    enrolmentsThisMonth,
    customersServedThisMonth: customersServedThisMonth.length,
  };
}

async function staffLastHandoverAt(tenantId, staffId) {
  const row = await CashHandover.findOne({
    tenantId,
    staffId,
    status: {
      $in: [
        CashHandoverStatus.ACCEPTED,
        CashHandoverStatus.DISCREPANCY,
        CashHandoverStatus.REJECTED,
      ],
    },
  })
    .sort({ settledAt: -1, submittedAt: -1, createdAt: -1 })
    .select("settledAt submittedAt")
    .lean();
  return row?.settledAt ?? row?.submittedAt ?? null;
}

const PERFORMANCE_SECTIONS = new Set([
  "collections",
  "enrolments",
  "handovers",
]);

function performanceDateRange(query = {}) {
  if (query.from || query.to) {
    return {
      from: query.from ? String(query.from).slice(0, 10) : undefined,
      to: query.to ? String(query.to).slice(0, 10) : undefined,
    };
  }
  return {
    from: now().startOf("month").format("YYYY-MM-DD"),
    to: now().format("YYYY-MM-DD"),
  };
}

async function findStaffForPerformance(req) {
  const user = await User.findOne({
    _id: req.params.staffId,
    tenantId: req.auth.tenantId,
    type: UserType.TENANT_USER,
  })
    .select("_id branchId")
    .lean();
  if (!user) throw errors.notFound("Staff");
  return user;
}

async function loadCustomerMap(tenantId, customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await Customer.find({ tenantId, _id: { $in: customerIds } })
    .select("_id name")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

async function loadPlanMap(planIds) {
  if (!planIds.length) return new Map();
  const rows = await SchemePlan.find({ _id: { $in: planIds } })
    .select("_id name code")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

async function loadSchemeEnrollmentMap(schemeIds) {
  if (!schemeIds.length) return new Map();
  const rows = await Scheme.find({ _id: { $in: schemeIds } })
    .select("_id enrollmentNumber")
    .lean();
  return new Map(rows.map((row) => [row._id, row.enrollmentNumber]));
}

function mapCollectionRows(payments, customerMap, schemeMap = new Map()) {
  return payments.map((row) => ({
    id: row._id,
    receiptNumber: row.receiptNumber ?? "—",
    amount: moneyRef(row.amountPaise ?? 0),
    mode: row.mode ?? "—",
    source: row.source ?? null,
    paidAt: row.paidAt ?? null,
    customer: row.customerId
      ? {
          id: row.customerId,
          name: customerMap.get(row.customerId)?.name ?? row.customerId,
        }
      : null,
    scheme: row.schemeId
      ? {
          id: row.schemeId,
          enrollmentNumber: schemeMap.get(row.schemeId) ?? null,
        }
      : null,
  }));
}

async function aggregateCollectionByMode(paymentMatch) {
  const rows = await Payment.aggregate([
    { $match: paymentMatch },
    {
      $group: {
        _id: "$mode",
        amountPaise: sumNetAmountPaise(),
        count: { $sum: 1 },
      },
    },
    { $sort: { amountPaise: -1 } },
  ]);
  return rows.map((row) => ({
    mode: row._id ?? "UNKNOWN",
    count: row.count ?? 0,
    amount: moneyRef(row.amountPaise ?? 0),
  }));
}

async function aggregateCollectionTrend(paymentMatch) {
  const rows = await Payment.aggregate([
    { $match: paymentMatch },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$paidAt",
            timezone: "Asia/Kolkata",
          },
        },
        amountPaise: sumNetAmountPaise(),
        count: { $sum: 1 },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return rows.map((row) => ({
    date: row._id,
    count: row.count ?? 0,
    amount: moneyRef(row.amountPaise ?? 0),
  }));
}

function performanceTrendGroupBy(range, requestedGroupBy) {
  if (!range?.from || !range?.to) return "DAY";
  return inferTrendGroupBy(range.from, range.to, requestedGroupBy);
}

function trendBucketKey(ymd, groupBy) {
  if (groupBy === "YEAR") return String(ymd).slice(0, 4);
  if (groupBy === "MONTH") return String(ymd).slice(0, 7);
  if (groupBy === "WEEK") return weekStartYmd(ymd);
  return String(ymd).slice(0, 10);
}

function aggregateCollectionTrendByGroup(rows, range, groupBy) {
  const aggregate = new Map();
  for (const row of rows ?? []) {
    const key = trendBucketKey(row.date, groupBy);
    const prev = aggregate.get(key) ?? { count: 0, amountPaise: 0 };
    aggregate.set(key, {
      count: prev.count + (Number(row.count) || 0),
      amountPaise: prev.amountPaise + (Number(row.amount?.amountPaise) || 0),
    });
  }

  const sortedKeys =
    range?.from && range?.to
      ? [...iteratePeriodBuckets(range.from, range.to, groupBy)]
      : [...aggregate.keys()].sort((a, b) => a.localeCompare(b));

  return sortedKeys.map((key) => {
    const value = aggregate.get(key) ?? { count: 0, amountPaise: 0 };
    return {
      date: key,
      label: formatTrendBucketLabel(key, groupBy),
      count: value.count,
      amount: moneyRef(value.amountPaise),
    };
  });
}

async function aggregateRedemptionsCompleted(match) {
  const [count, sumRow] = await Promise.all([
    Redemption.countDocuments({ ...match, status: RedemptionStatus.COMPLETED }),
    Redemption.aggregate([
      { $match: { ...match, status: RedemptionStatus.COMPLETED } },
      {
        $group: {
          _id: null,
          settlementPaise: { $sum: { $ifNull: ["$settlementPaise", 0] } },
        },
      },
    ]),
  ]);
  return {
    count,
    settlementTotal: moneyRef(sumRow[0]?.settlementPaise ?? 0),
  };
}

async function aggregateHandoversInPeriod(scope, rangedQuery) {
  const base = { ...scope, ...dateMatch("createdAt", rangedQuery) };
  const [submitted, accepted, pending, rejected] = await Promise.all([
    CashHandover.countDocuments(base),
    CashHandover.countDocuments({
      ...base,
      status: CashHandoverStatus.ACCEPTED,
    }),
    CashHandover.countDocuments({
      ...scope,
      status: CashHandoverStatus.PENDING,
    }),
    CashHandover.countDocuments({
      ...base,
      status: CashHandoverStatus.REJECTED,
    }),
  ]);
  return { submitted, accepted, pending, rejected };
}

async function aggregateTopCollectors(paymentMatch, limit = 5) {
  const rows = await Payment.aggregate([
    { $match: { ...paymentMatch, collectedBy: { $exists: true, $ne: null } } },
    {
      $group: {
        _id: "$collectedBy",
        amountPaise: sumNetAmountPaise(),
        count: { $sum: 1 },
      },
    },
    { $sort: { amountPaise: -1 } },
    { $limit: limit },
  ]);
  const staffMap = await loadStaffMap(
    rows.map((row) => row._id).filter(Boolean),
  );
  return rows.map((row) => ({
    staff: {
      id: row._id,
      name: staffMap.get(row._id)?.name ?? row._id,
    },
    paymentsCount: row.count ?? 0,
    collectionTotal: moneyRef(row.amountPaise ?? 0),
  }));
}

function mapEnrolmentRows(schemes, customerMap, planMap) {
  return schemes.map((row) => {
    const plan = planMap.get(row.planId);
    const customer = customerMap.get(row.customerId);
    return {
      id: row._id,
      enrollmentNumber: row.enrollmentNumber,
      status: row.status,
      createdAt: row.createdAt ?? null,
      customer: customer
        ? { id: customer._id, name: customer.name }
        : row.customerId
          ? { id: row.customerId, name: row.customerId }
          : null,
      plan: plan ? { id: plan._id, name: plan.name, code: plan.code } : null,
    };
  });
}

function mapHandoverRows(handovers, staffMap = new Map()) {
  return handovers.map((row) => ({
    id: row._id,
    amount: moneyRef(row.amountPaise ?? 0),
    acceptedAmount:
      row.acceptedAmountPaise != null
        ? moneyRef(row.acceptedAmountPaise)
        : null,
    status: row.status,
    submittedAt: row.submittedAt ?? row.createdAt ?? null,
    settledAt: row.settledAt ?? null,
    staff: row.staffId
      ? {
          id: row.staffId,
          name: staffMap.get(row.staffId)?.name ?? row.staffId,
        }
      : null,
  }));
}

export async function getStaffPerformanceSummary(req) {
  const user = await findStaffForPerformance(req);
  const tenantId = req.auth.tenantId;
  const range = performanceDateRange(req.query);
  const rangedQuery = { ...req.query, ...range };
  const trendGroupBy = performanceTrendGroupBy(range, req.query?.groupBy);
  const paymentMatch = {
    tenantId,
    ...netCollectionStatusFilter(),
    collectedBy: user._id,
    ...dateMatch("paidAt", rangedQuery),
  };
  const schemeMatch = {
    tenantId,
    createdBy: user._id,
    ...dateMatch("createdAt", rangedQuery),
  };
  const [
    collectionRow,
    enrolments,
    customersServed,
    paymentsCount,
    cash,
    lastHandoverAt,
    collectionByMode,
    collectionTrend,
    redemptionsCompleted,
    handoversInPeriod,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: null,
          amountPaise: sumNetAmountPaise(),
          count: { $sum: 1 },
        },
      },
    ]),
    Scheme.countDocuments(schemeMatch),
    Payment.distinct("customerId", paymentMatch),
    Payment.countDocuments(paymentMatch),
    cashBalance({
      tenantId,
      branchId: user.branchId ?? null,
      staffId: user._id,
    }),
    staffLastHandoverAt(tenantId, user._id),
    aggregateCollectionByMode(paymentMatch),
    aggregateCollectionTrend(paymentMatch),
    aggregateRedemptionsCompleted({
      tenantId,
      status: RedemptionStatus.COMPLETED,
      ...dateMatch("completedAt", rangedQuery),
      $or: [{ completedBy: user._id }, { requestedBy: user._id }],
    }),
    aggregateHandoversInPeriod({ tenantId, staffId: user._id }, rangedQuery),
  ]);
  const totalPaise = collectionRow[0]?.amountPaise ?? 0;
  const count = collectionRow[0]?.count ?? paymentsCount;
  return {
    range,
    trendGroupBy,
    collectionTotal: moneyRef(totalPaise),
    enrolments,
    customersServed: customersServed.length,
    paymentsCount: count,
    averageTicket: moneyRef(count ? Math.round(totalPaise / count) : 0),
    collectionByMode,
    collectionTrend: aggregateCollectionTrendByGroup(
      collectionTrend,
      range,
      trendGroupBy,
    ),
    redemptionsCompleted,
    handoversInPeriod,
    cash: {
      cashInHand: moneyRef(cash.cashInHandPaise ?? 0),
      cashPendingAcceptance: moneyRef(cash.cashPendingAcceptancePaise ?? 0),
      cashCollected: moneyRef(cash.cashCollectedPaise ?? 0),
      handedOver: moneyRef(cash.handedOverPaise ?? 0),
      lastHandoverAt,
    },
  };
}

export async function listStaffPerformanceSection(req) {
  const section = String(req.params.section ?? "");
  if (!PERFORMANCE_SECTIONS.has(section)) {
    throw errors.validation([
      {
        field: "section",
        message: "Section must be collections, enrolments, or handovers.",
      },
    ]);
  }
  const user = await findStaffForPerformance(req);
  const tenantId = req.auth.tenantId;
  const range = performanceDateRange(req.query);
  const rangedQuery = { ...req.query, ...range };

  if (section === "collections") {
    const page = await paginate(Payment, {
      scope: {
        tenantId,
        status: { $in: NET_COLLECTION_PAYMENT_STATUSES },
        collectedBy: user._id,
      },
      filters: dateMatch("paidAt", rangedQuery),
      cursor: req.query.cursor,
      limit: req.query.limit,
      sort: "paidAt:desc",
      projection:
        "_id receiptNumber amountPaise mode source paidAt customerId schemeId",
    });
    const customerMap = await loadCustomerMap(
      tenantId,
      page.data.map((row) => row.customerId).filter(Boolean),
    );
    const schemeMap = await loadSchemeEnrollmentMap(
      page.data.map((row) => row.schemeId).filter(Boolean),
    );
    page.data = mapCollectionRows(page.data, customerMap, schemeMap);
    page.meta = { ...page.meta, range };
    return page;
  }

  if (section === "enrolments") {
    const page = await paginate(Scheme, {
      scope: { tenantId, createdBy: user._id },
      filters: dateMatch("createdAt", rangedQuery),
      cursor: req.query.cursor,
      limit: req.query.limit,
      sort: "createdAt:desc",
      projection: "_id enrollmentNumber customerId planId createdAt status",
    });
    const customerMap = await loadCustomerMap(
      tenantId,
      page.data.map((row) => row.customerId).filter(Boolean),
    );
    const planMap = await loadPlanMap(
      page.data.map((row) => row.planId).filter(Boolean),
    );
    page.data = mapEnrolmentRows(page.data, customerMap, planMap);
    page.meta = { ...page.meta, range };
    return page;
  }

  const page = await paginate(CashHandover, {
    scope: { tenantId, staffId: user._id },
    filters: dateMatch("createdAt", rangedQuery),
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
    projection:
      "_id amountPaise acceptedAmountPaise status submittedAt settledAt createdAt",
  });
  page.data = mapHandoverRows(page.data);
  page.meta = { ...page.meta, range };
  return page;
}

async function findBranchForPerformance(req) {
  const branch = await Branch.findOne({
    _id: req.params.branchId,
    tenantId: req.auth.tenantId,
  })
    .select("_id name code")
    .lean();
  if (!branch) throw errors.notFound("Branch");
  return branch;
}

async function loadStaffMap(staffIds) {
  if (!staffIds.length) return new Map();
  const rows = await User.find({ _id: { $in: staffIds } })
    .select("_id name")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

function mapBranchCollectionRows(
  payments,
  customerMap,
  staffMap,
  schemeMap = new Map(),
) {
  return payments.map((row) => ({
    id: row._id,
    receiptNumber: row.receiptNumber ?? "—",
    amount: moneyRef(row.amountPaise ?? 0),
    mode: row.mode ?? "—",
    source: row.source ?? null,
    paidAt: row.paidAt ?? null,
    customer: row.customerId
      ? {
          id: row.customerId,
          name: customerMap.get(row.customerId)?.name ?? row.customerId,
        }
      : null,
    collectedBy: row.collectedBy
      ? {
          id: row.collectedBy,
          name: staffMap.get(row.collectedBy)?.name ?? row.collectedBy,
        }
      : null,
    scheme: row.schemeId
      ? {
          id: row.schemeId,
          enrollmentNumber: schemeMap.get(row.schemeId) ?? null,
        }
      : null,
  }));
}

export async function getBranchDetailForAdmin(req) {
  const branch = await Branch.findOne({
    _id: req.params.branchId,
    tenantId: req.auth.tenantId,
  }).lean();
  if (!branch) throw errors.notFound("Branch");
  const tenantId = req.auth.tenantId;
  const branchId = branch._id;
  const since = monthStart();
  const [
    staffCount,
    activeCustomers,
    activeSchemes,
    collectionRow,
    pendingCashPaise,
  ] = await Promise.all([
    User.countDocuments({
      tenantId,
      branchId,
      type: UserType.TENANT_USER,
      status: UserStatus.ACTIVE,
    }),
    Customer.countDocuments({
      tenantId,
      branchId,
      status: CustomerStatus.ACTIVE,
    }),
    Scheme.countDocuments({
      tenantId,
      branchId,
      status: { $in: OPEN_SCHEME_STATUSES },
    }),
    Payment.aggregate([
      {
        $match: {
          tenantId,
          branchId,
          ...netCollectionStatusFilter(),
          paidAt: { $gte: since },
        },
      },
      { $group: { _id: null, amountPaise: sumNetAmountPaise() } },
    ]),
    branchTotalCashInHandPaise(tenantId, branchId),
  ]);
  const collectionPaise = collectionRow[0]?.amountPaise ?? 0;
  const canDeactivate = activeSchemes === 0;
  return {
    id: branch._id,
    name: branch.name,
    code: branch.code,
    email: branch.email ?? null,
    mobile: branch.mobile ?? null,
    contactNumber: branch.contactNumber ?? branch.mobile ?? null,
    address: normalizeBranchAddress(branch),
    status: branch.active === false ? "INACTIVE" : "ACTIVE",
    active: branch.active !== false,
    stats: {
      staffCount,
      activeCustomers,
      activeSchemes,
      collectionThisMonth: moneyRef(collectionPaise),
      pendingCashInHand: moneyRef(pendingCashPaise),
    },
    guards: {
      canDeactivate: canDeactivate
        ? true
        : { activeSchemes, activeStaff: staffCount },
    },
    audit: {
      createdAt: branch.createdAt ?? null,
      version: branch.version ?? 1,
    },
  };
}

export async function getBranchPerformanceSummary(req) {
  const branch = await findBranchForPerformance(req);
  const tenantId = req.auth.tenantId;
  const branchId = branch._id;
  const range = performanceDateRange(req.query);
  const rangedQuery = { ...req.query, ...range };
  const trendGroupBy = performanceTrendGroupBy(range, req.query?.groupBy);
  const paymentMatch = {
    tenantId,
    branchId,
    ...netCollectionStatusFilter(),
    ...dateMatch("paidAt", rangedQuery),
  };
  const schemeMatch = {
    tenantId,
    branchId,
    ...dateMatch("createdAt", rangedQuery),
  };
  const [
    collectionRow,
    enrolments,
    customersServed,
    paymentsCount,
    cash,
    collectionByMode,
    collectionTrend,
    redemptionsCompleted,
    handoversInPeriod,
    topCollectors,
  ] = await Promise.all([
    Payment.aggregate([
      { $match: paymentMatch },
      {
        $group: {
          _id: null,
          amountPaise: sumNetAmountPaise(),
          count: { $sum: 1 },
        },
      },
    ]),
    Scheme.countDocuments(schemeMatch),
    Payment.distinct("customerId", paymentMatch),
    Payment.countDocuments(paymentMatch),
    branchCashTotals(tenantId, branchId),
    aggregateCollectionByMode(paymentMatch),
    aggregateCollectionTrend(paymentMatch),
    aggregateRedemptionsCompleted({
      tenantId,
      branchId,
      ...dateMatch("completedAt", rangedQuery),
    }),
    aggregateHandoversInPeriod({ tenantId, branchId }, rangedQuery),
    aggregateTopCollectors(paymentMatch),
  ]);
  const totalPaise = collectionRow[0]?.amountPaise ?? 0;
  const count = collectionRow[0]?.count ?? paymentsCount;
  return {
    range,
    trendGroupBy,
    collectionTotal: moneyRef(totalPaise),
    enrolments,
    customersServed: customersServed.length,
    paymentsCount: count,
    averageTicket: moneyRef(count ? Math.round(totalPaise / count) : 0),
    collectionByMode,
    collectionTrend: aggregateCollectionTrendByGroup(
      collectionTrend,
      range,
      trendGroupBy,
    ),
    redemptionsCompleted,
    handoversInPeriod,
    topCollectors,
    cash: {
      cashInHand: moneyRef(cash.cashInHandPaise ?? 0),
      cashPendingAcceptance: moneyRef(cash.cashPendingAcceptancePaise ?? 0),
      cashCollected: moneyRef(cash.cashCollectedPaise ?? 0),
      handedOver: moneyRef(cash.handedOverPaise ?? 0),
      lastHandoverAt: cash.lastHandoverAt,
    },
  };
}

export async function listBranchPerformanceSection(req) {
  const section = String(req.params.section ?? "");
  if (!PERFORMANCE_SECTIONS.has(section)) {
    throw errors.validation([
      {
        field: "section",
        message: "Section must be collections, enrolments, or handovers.",
      },
    ]);
  }
  const branch = await findBranchForPerformance(req);
  const tenantId = req.auth.tenantId;
  const branchId = branch._id;
  const range = performanceDateRange(req.query);
  const rangedQuery = { ...req.query, ...range };

  if (section === "collections") {
    const page = await paginate(Payment, {
      scope: {
        tenantId,
        branchId,
        status: { $in: NET_COLLECTION_PAYMENT_STATUSES },
      },
      filters: dateMatch("paidAt", rangedQuery),
      cursor: req.query.cursor,
      limit: req.query.limit,
      sort: "paidAt:desc",
      projection:
        "_id receiptNumber amountPaise mode source paidAt customerId collectedBy schemeId",
    });
    const customerMap = await loadCustomerMap(
      tenantId,
      page.data.map((row) => row.customerId).filter(Boolean),
    );
    const staffMap = await loadStaffMap(
      page.data.map((row) => row.collectedBy).filter(Boolean),
    );
    const schemeMap = await loadSchemeEnrollmentMap(
      page.data.map((row) => row.schemeId).filter(Boolean),
    );
    page.data = mapBranchCollectionRows(
      page.data,
      customerMap,
      staffMap,
      schemeMap,
    );
    page.meta = { ...page.meta, range };
    return page;
  }

  if (section === "enrolments") {
    const page = await paginate(Scheme, {
      scope: { tenantId, branchId },
      filters: dateMatch("createdAt", rangedQuery),
      cursor: req.query.cursor,
      limit: req.query.limit,
      sort: "createdAt:desc",
      projection: "_id enrollmentNumber customerId planId createdAt status",
    });
    const customerMap = await loadCustomerMap(
      tenantId,
      page.data.map((row) => row.customerId).filter(Boolean),
    );
    const planMap = await loadPlanMap(
      page.data.map((row) => row.planId).filter(Boolean),
    );
    page.data = mapEnrolmentRows(page.data, customerMap, planMap);
    page.meta = { ...page.meta, range };
    return page;
  }

  const page = await paginate(CashHandover, {
    scope: { tenantId, branchId },
    filters: dateMatch("createdAt", rangedQuery),
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: "createdAt:desc",
    projection:
      "_id amountPaise acceptedAmountPaise status submittedAt settledAt createdAt staffId",
  });
  const staffMap = await loadStaffMap(
    page.data.map((row) => row.staffId).filter(Boolean),
  );
  page.data = mapHandoverRows(page.data, staffMap);
  page.meta = { ...page.meta, range };
  return page;
}

export async function getStaffDetailForAdmin(req) {
  const user = await User.findOne({
    _id: req.params.staffId,
    tenantId: req.auth.tenantId,
    type: UserType.TENANT_USER,
  })
    .select("-passwordHash")
    .lean();
  if (!user) throw errors.notFound("Staff");
  const tenantId = req.auth.tenantId;
  const branch = user.branchId
    ? await Branch.findOne({ _id: user.branchId, tenantId })
        .select("_id name code address mobile")
        .lean()
    : null;
  const tenantWide = !user.branchId && TENANT_WIDE_ROLES.has(user.role);
  const [performance, activeSessions, pendingHandovers, cash, lastHandoverAt] =
    await Promise.all([
      staffMonthPerformance(tenantId, user._id),
      staffActiveSessionCount(tenantId, user._id),
      CashHandover.countDocuments({
        tenantId,
        staffId: user._id,
        status: CashHandoverStatus.PENDING,
      }),
      cashBalance({
        tenantId,
        branchId: user.branchId ?? null,
        staffId: user._id,
      }),
      staffLastHandoverAt(tenantId, user._id),
    ]);
  const paymentCountRow = await Payment.countDocuments({
    tenantId,
    ...netCollectionStatusFilter(),
    collectedBy: user._id,
    paidAt: { $gte: monthStart() },
  });
  return {
    ...user,
    id: user._id,
    scope: tenantWide ? "TENANT" : "BRANCH",
    mustChangePassword: Boolean(user.mustSetPassword),
    lastLoginAt: user.lastSeenAt ?? null,
    activeSessions,
    branch: branch
      ? {
          id: branch._id,
          name: branch.name,
          code: branch.code,
          address: branch.address ?? null,
        }
      : null,
    performance: {
      collectionThisMonth: moneyRef(performance.collectionThisMonthPaise),
      enrolmentsThisMonth: performance.enrolmentsThisMonth,
      cashInHand: moneyRef(cash.cashInHandPaise ?? 0),
      paymentsThisMonth: paymentCountRow,
    },
    cash: {
      cashInHand: moneyRef(cash.cashInHandPaise ?? 0),
      cashPendingAcceptance: moneyRef(cash.cashPendingAcceptancePaise ?? 0),
      cashCollected: moneyRef(cash.cashCollectedPaise ?? 0),
      handedOver: moneyRef(cash.handedOverPaise ?? 0),
      lastHandoverAt,
    },
    stats: {
      pendingHandovers,
      customersServedThisMonth: performance.customersServedThisMonth,
    },
    audit: {
      createdAt: user.createdAt ?? null,
      version: user.version ?? 1,
    },
  };
}

function enforceVersion(record, expectedVersion) {
  if (expectedVersion && record.version !== expectedVersion)
    throw new AppError(
      "VERSION_CONFLICT",
      "This record changed. Refresh and try again.",
      409,
    );
}
export async function updateTenantSettings(req, section, patch) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session);
    if (!tenant) throw errors.notFound("Tenant");
    enforceVersion(tenant, patch.expectedVersion);
    const before = tenant.toObject();
    delete patch.expectedVersion;
    if (section === "profile") Object.assign(tenant, patch);
    else
      tenant.set(section, { ...tenant.get(section)?.toObject?.(), ...patch });
    tenant.version += 1;
    await tenant.save({ session });
    const auditEventId = await writeAudit({
      req,
      action: `TENANT_${section.toUpperCase()}_UPDATED`,
      entityType: AuditEntityType.TENANT,
      entityId: tenant._id,
      before,
      after: tenant.toObject(),
      session,
    });
    return { ...tenant.toObject(), auditEventId };
  });
}
export async function createBranch(req) {
  const {
    code,
    name,
    email,
    contactNumber,
    mobile: mobileInput,
    isHeadOffice,
    address: addressInput,
  } = req.body;
  const address = branchAddressForCreate(addressInput);
  const contact = contactNumber ?? mobileInput;
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session);
    const used = await Branch.countDocuments({ tenantId: tenant._id, active: true }).session(session);
    await assertWithinLimit({ tenant, limitKey: "branches", used, errorCode: "LIMIT_BRANCHES", label: "branches" });
    const branchId = createId("branch");
    const tenantId = req.auth.tenantId;
    const branch = (
      await Branch.create(
        [
          {
            _id: branchId,
            tenantId,
            code,
            name: String(name).trim(),
            ...(email != null ? { email } : {}),
            ...(contact != null ? { contactNumber: contact, mobile: contact } : {}),
            ...(address ? { address } : {}),
            ...(isHeadOffice != null ? { isHeadOffice } : {}),
          },
        ],
        { session },
      )
    )[0];
    const auditEventId = await writeAudit({
      req,
      action: "BRANCH_CREATED",
      entityType: AuditEntityType.BRANCH,
      entityId: branch._id,
      after: branch.toObject(),
      session,
    });
    return { ...branch.toObject(), auditEventId };
  });
}
export async function createStaff(req) {
  return withTransaction(async (session) => {
    const tenant = await Tenant.findById(req.auth.tenantId).session(session);
    const used = await User.countDocuments({
      tenantId: tenant._id,
      status: UserStatus.ACTIVE,
    }).session(session);
    await assertWithinLimit({ tenant, limitKey: "staff", used, errorCode: "LIMIT_STAFF", label: "active staff" });
    const role = req.body.role ?? TenantRole.BRANCH_STAFF;
    let branchId = req.body.branchId ?? null;
    if (TENANT_WIDE_ROLES.has(role)) {
      branchId = null;
    } else {
      const branch = await Branch.findOne({ _id: branchId, tenantId: tenant._id, active: true }).session(session).select("_id").lean();
      if (!branch) throw errors.business("BRANCH_NOT_ACTIVE", "Branch-scoped staff must be assigned to an active branch in this jewellery.");
    }
    const temporaryPassword = resolveTemporaryPassword(req.body.temporaryPassword);
    const mustSetPassword = req.body.mustSetPassword !== false;
    const user = (
      await User.create(
        [
          {
            _id: createId("user"),
            type: UserType.TENANT_USER,
            tenantId: tenant._id,
            branchId,
            role,
            name: req.body.name,
            mobile: req.body.mobile,
            email: req.body.email,
            passwordHash: await argon2.hash(temporaryPassword),
            mustSetPassword,
            permissions:
              ROLE_PERMISSIONS[role],
          },
        ],
        { session },
      )
    )[0];
    const auditEventId = await writeAudit({
      req,
      action: "STAFF_CREATED",
      entityType: AuditEntityType.STAFF,
      entityId: user._id,
      after: user.toObject(),
      session,
    });
    return { id: user._id, mustSetPassword, temporaryPassword, auditEventId };
  });
}
export async function setGoldRate(req) {
  const { assertV1GoldPurity, V1_GOLD_PURITY } = await import("../lib/gold-rate-lookup.js");
  assertV1GoldPurity(req.body.purity);
  return withTransaction(async (session) => {
    const rate = (
      await GoldRate.create(
        [
          {
            _id: createId("grt"),
            tenantId: req.auth.tenantId,
            branchId: req.body.branchId ?? null,
            effectiveDate: req.body.effectiveDate,
            ratePerGramPaise: req.body.ratePerGramPaise,
            purity: V1_GOLD_PURITY,
            source: req.body.source,
            enteredBy: req.auth.id,
          },
        ],
        { session },
      )
    )[0];
    const auditEventId = await writeAudit({
      req,
      action: "GOLD_RATE_SET",
      entityType: AuditEntityType.GOLD_RATE,
      entityId: rate._id,
      after: rate.toObject(),
      session,
    });
    return { ...rate.toObject(), auditEventId };
  });
}

export async function listGoldRateHistory(req) {
  const filters = {};
  const effective = effectiveScope(req);
  if (effective.branchId) {
    filters.branchId = effective.branchId;
  } else if (req.query.branchId === "null") {
    filters.branchId = null;
  } else if (req.query.branchId && String(req.query.branchId).trim().toUpperCase() !== "ALL") {
    filters.branchId = String(req.query.branchId).trim();
  }
  if (req.query.from || req.query.to) {
    const range = {};
    if (req.query.from) range.$gte = String(req.query.from).slice(0, 10);
    if (req.query.to) range.$lte = String(req.query.to).slice(0, 10);
    filters.effectiveDate = range;
  }
  const scope = { tenantId: req.auth.tenantId };
  if (req.scope.branchId) {
    scope.$or = [{ branchId: req.scope.branchId }, { branchId: null }];
  }
  const result = await paginate(GoldRate, {
    scope,
    filters,
    cursor: req.query.cursor,
    limit: req.query.limit ?? 50,
    sort: "createdAt:desc",
  });
  if (!result.data.length) return result;
  const userIds = [
    ...new Set(result.data.map((row) => row.enteredBy).filter(Boolean)),
  ];
  const branchIds = [
    ...new Set(result.data.map((row) => row.branchId).filter(Boolean)),
  ];
  const [users, branches] = await Promise.all([
    userIds.length
      ? User.find({ _id: { $in: userIds } })
          .select("_id name")
          .lean()
      : [],
    branchIds.length
      ? Branch.find({ _id: { $in: branchIds } })
          .select("_id name code")
          .lean()
      : [],
  ]);
  const userMap = new Map(users.map((row) => [row._id, row]));
  const branchMap = new Map(branches.map((row) => [row._id, row]));
  result.data = result.data.map((row) => {
    const branch = row.branchId ? branchMap.get(row.branchId) : null;
    const user = row.enteredBy ? userMap.get(row.enteredBy) : null;
    return {
      ...row,
      enteredBy: user ? { id: user._id, name: user.name } : row.enteredBy,
      branch: branch
        ? {
            id: branch._id,
            _id: branch._id,
            name: branch.name,
            code: branch.code,
          }
        : { id: null, name: "All branches" },
    };
  });
  return result;
}
export async function currentGoldRate(scope, date) {
  const { currentGoldRate22K } = await import("../lib/gold-rate-lookup.js");
  return currentGoldRate22K(scope, date);
}
export async function latestGoldRateOnOrBefore(scope, date) {
  const { latestGoldRate22KOnOrBefore } = await import("../lib/gold-rate-lookup.js");
  return latestGoldRate22KOnOrBefore(scope, date);
}
export async function deactivateStaff(req) {
  return withTransaction(async (session) => {
    const user = await User.findOneAndUpdate(
      { _id: req.params.staffId, tenantId: req.auth.tenantId },
      { $set: { status: UserStatus.INACTIVE }, $inc: { version: 1 } },
      { new: true, session },
    );
    if (!user) throw errors.notFound("Staff");
    const auditEventId = await writeAudit({
      req,
      action: "STAFF_DEACTIVATED",
      entityType: AuditEntityType.STAFF,
      entityId: user._id,
      after: user.toObject(),
      session,
    });
    return { id: user._id, status: user.status, auditEventId };
  });
}
export async function updateBranch(req) {
  const branch = await Branch.findOne({
    _id: req.params.branchId,
    tenantId: req.auth.tenantId,
  });
  if (!branch) throw errors.notFound("Branch");
  if (
    req.body.expectedVersion != null &&
    branch.version !== Number(req.body.expectedVersion)
  ) {
    throw new AppError(
      "VERSION_CONFLICT",
      "Branch not found or changed. Refresh and try again.",
      409,
    );
  }
  const {
    name,
    email,
    contactNumber,
    mobile: mobileInput,
    isHeadOffice,
    address: addressInput,
  } = req.body;
  if (name != null) branch.name = String(name).trim() || branch.name;
  if (email != null) branch.email = email;
  const contact = contactNumber ?? mobileInput;
  if (contact != null) {
    branch.contactNumber = contact;
    branch.mobile = contact;
  }
  if (isHeadOffice != null) branch.isHeadOffice = isHeadOffice;
  if (addressInput != null) {
    const prev = branch.address?.toObject?.() ?? branch.address ?? {};
    if (typeof addressInput === "object") {
      branch.address = {
        line1:
          addressInput.line1 !== undefined ? addressInput.line1 : prev.line1,
        city: addressInput.city !== undefined ? addressInput.city : prev.city,
        pincode:
          addressInput.pincode !== undefined
            ? addressInput.pincode
            : prev.pincode,
      };
    } else if (typeof addressInput === "string") {
      branch.address = { ...prev, line1: addressInput };
    }
  }
  branch.version += 1;
  await branch.save();
  return getBranchDetailForAdmin(req);
}
export async function setBranchActive(req, active) {
  const row = await Branch.findOneAndUpdate(
    { _id: req.params.branchId, tenantId: req.auth.tenantId },
    { $set: { active }, $inc: { version: 1 } },
    { new: true },
  );
  if (!row) throw errors.notFound("Branch");
  return getBranchDetailForAdmin(req);
}
export async function updateStaff(req) {
  const patch = { ...req.body };
  delete patch.expectedVersion;
  delete patch.password;
  const filter = {
    _id: req.params.staffId,
    tenantId: req.auth.tenantId,
    ...(req.body.expectedVersion != null
      ? { version: Number(req.body.expectedVersion) }
      : {}),
  };
  const row = await User.findOneAndUpdate(
    filter,
    { $set: patch, $inc: { version: 1 } },
    { new: true },
  ).select("-passwordHash");
  if (!row)
    throw new AppError(
      "VERSION_CONFLICT",
      "Staff record not found or changed. Refresh and try again.",
      409,
    );
  if (["role", "permissions", "branchId"].some((key) => key in patch)) {
    await bumpSecurityVersion({ userId: row._id });
    await revokeSessionsForUser(row._id);
  }
  return row.toObject();
}
export async function activateStaff(req) {
  const row = await User.findOneAndUpdate(
    { _id: req.params.staffId, tenantId: req.auth.tenantId },
    { $set: { status: UserStatus.ACTIVE }, $inc: { version: 1 } },
    { new: true },
  ).select("-passwordHash");
  if (!row) throw errors.notFound("Staff");
  return row.toObject();
}
export async function transferStaff(req) {
  const branch = await Branch.findOne({
    _id: req.body.branchId,
    tenantId: req.auth.tenantId,
    active: true,
  }).lean();
  if (!branch) throw errors.notFound("Branch");
  const row = await User.findOneAndUpdate(
    { _id: req.params.staffId, tenantId: req.auth.tenantId },
    { $set: { branchId: branch._id }, $inc: { version: 1 } },
    { new: true },
  ).select("-passwordHash");
  if (!row) throw errors.notFound("Staff");
  await bumpSecurityVersion({ userId: row._id });
  await revokeSessionsForUser(row._id);
  return row.toObject();
}
export async function resetStaffPassword(req) {
  const temporaryPassword = resolveTemporaryPassword(req.body.temporaryPassword);
  const row = await User.findOneAndUpdate(
    { _id: req.params.staffId, tenantId: req.auth.tenantId },
    {
      $set: {
        passwordHash: await argon2.hash(temporaryPassword),
        mustSetPassword: true,
      },
      $inc: { version: 1, securityVersion: 1 },
    },
    { new: true },
  ).select("_id mustSetPassword");
  if (!row) throw errors.notFound("Staff");
  // Revokes refresh session; current access token remains valid until natural expiry (≤ JWT_MOBILE_TTL).
  await revokeSessionsForUser(row._id);
  return { staffId: row._id, temporaryPassword, mustSetPassword: true };
}
