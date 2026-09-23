import { CashHandover, Payment, Scheme, User } from "../../models/index.js";
import { CashHandoverStatus, TenantRole, UserStatus, UserType } from "../../constants/enums.js";
import { moneyRef } from "../../lib/money.js";
import { dateMatch } from "../../lib/query-filters.js";
import { cashBalance } from "../cash.service.js";
import {
  baseEnvelope,
  branchNameMap,
  paginateRows,
  reportDataScope,
  schemeIdsForPlan,
} from "./report-envelope.js";
import {
  netCollectionStatusFilter,
  sumNetAmountPaise,
} from "../../lib/payment-net-aggregation.js";

const COLUMNS = [
  { key: "staff", label: "Staff", type: "staff", sticky: true },
  { key: "branch", label: "Showroom", type: "text" },
  { key: "enrolments", label: "Enrolments", type: "count", align: "right" },
  { key: "collected", label: "Collected", type: "currency", align: "right", emphasis: true },
  { key: "receiptCount", label: "Receipts", type: "count", align: "right" },
  { key: "cashInHand", label: "Cash in hand", type: "currency", align: "right" },
  { key: "avgHoldingDays", label: "Avg holding (days)", type: "number", align: "right" },
  { key: "discrepancies", label: "Discrepancies", type: "count", align: "right" },
];

const STAFF_ROLES = [
  TenantRole.BRANCH_STAFF,
  TenantRole.BRANCH_MANAGER,
  TenantRole.COLLECTION_AGENT,
];

export async function buildStaffPerformanceReport(req) {
  const envelope = baseEnvelope(req, "STAFF_PERFORMANCE", "Staff performance");
  const { from, to } = envelope.period;
  const tenantId = req.auth.tenantId;
  const scope = reportDataScope(req);
  const branchId = scope.branchId ?? null;

  const staff = await User.find({
    tenantId,
    type: UserType.TENANT_USER,
    role: { $in: STAFF_ROLES },
    status: UserStatus.ACTIVE,
    ...(branchId ? { branchId } : {}),
    ...(req.query.staffId ? { _id: req.query.staffId } : {}),
  })
    .select("_id name role branchId")
    .sort({ name: 1 })
    .lean();

  const staffIds = staff.map((s) => s._id);
  const schemeIds = await schemeIdsForPlan(scope, req.query.planId);
  const paymentMatch = {
    tenantId,
    ...netCollectionStatusFilter(),
    collectedBy: { $in: staffIds },
    ...dateMatch("paidAt", { from, to }),
    ...(schemeIds ? { schemeId: { $in: schemeIds } } : {}),
  };

  const [collections, enrolments, discrepancies] = await Promise.all([
    Payment.aggregate([
      { $match: paymentMatch },
      { $group: { _id: "$collectedBy", amountPaise: sumNetAmountPaise(), payments: { $sum: 1 } } },
    ]),
    Scheme.aggregate([
      {
        $match: {
          ...scope,
          createdBy: { $in: staffIds },
          ...dateMatch("createdAt", { from, to }),
          ...(req.query.planId ? { planId: req.query.planId } : {}),
        },
      },
      { $group: { _id: "$createdBy", count: { $sum: 1 } } },
    ]),
    CashHandover.aggregate([
      {
        $match: {
          tenantId,
          staffId: { $in: staffIds },
          status: CashHandoverStatus.DISCREPANCY,
          ...dateMatch("createdAt", { from, to }),
        },
      },
      { $group: { _id: "$staffId", count: { $sum: 1 } } },
    ]),
  ]);

  const collMap = new Map(collections.map((r) => [r._id, r]));
  const enrolMap = new Map(enrolments.map((r) => [r._id, r.count]));
  const discMap = new Map(discrepancies.map((r) => [r._id, r.count]));
  const branchNames = await branchNameMap(tenantId, staff.map((s) => s.branchId).filter(Boolean));

  const tableRows = await Promise.all(
    staff.map(async (member) => {
      const coll = collMap.get(member._id);
      const balance = await cashBalance({ tenantId, branchId: branchId ?? member.branchId, staffId: member._id });
      return {
        key: member._id,
        staff: { id: member._id, name: member.name, role: member.role },
        branch: branchNames.get(member.branchId) ?? "—",
        enrolments: enrolMap.get(member._id) ?? 0,
        collected: moneyRef(coll?.amountPaise ?? 0),
        receiptCount: coll?.payments ?? 0,
        cashInHand: moneyRef(balance.cashInHandPaise),
        avgHoldingDays: 0,
        discrepancies: discMap.get(member._id) ?? 0,
      };
    }),
  );

  tableRows.sort((a, b) => b.collected.amountPaise - a.collected.amountPaise);

  const totalCollected = tableRows.reduce((sum, row) => sum + row.collected.amountPaise, 0);
  const totalEnrolments = tableRows.reduce((sum, row) => sum + row.enrolments, 0);

  const { rows, meta } = paginateRows(tableRows, req.query);

  return {
    ...envelope,
    summary: [
      { key: "TOTAL_COLLECTED", label: "Collected by staff & agents", value: moneyRef(totalCollected), valueType: "currency" },
      { key: "ENROLMENTS", label: "Enrolments", value: totalEnrolments, valueType: "count" },
      { key: "STAFF_ACTIVE", label: "Active staff & agents", value: staff.length, valueType: "count" },
    ],
    charts: {
      collectionByStaff: {
        chartType: "horizontalBar",
        title: "Collection by staff & agents",
        yAxis: { type: "currency", label: "Amount" },
        series: [
          {
            key: "COLLECTED",
            name: "Collected",
            data: tableRows.map((row) => ({
              x: row.staff.name,
              y: row.collected.amountPaise,
              yDisplay: row.collected.amountDisplay,
            })),
          },
        ],
      },
      enrolmentsByStaff: {
        chartType: "horizontalBar",
        title: "Enrolments by staff",
        yAxis: { type: "count", label: "Enrolments" },
        series: [
          {
            key: "enrolments",
            name: "Enrolments",
            data: tableRows.map((row) => ({ x: row.staff.name, y: row.enrolments })),
          },
        ],
      },
    },
    columns: COLUMNS,
    rows,
    meta,
  };
}
