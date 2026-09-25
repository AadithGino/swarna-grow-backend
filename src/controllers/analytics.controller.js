import { Customer, LedgerEntry, Scheme } from "../models/index.js";
import { ledgerTotals } from "../services/scheme.service.js";
import { branchDto, loadBranchMap } from "../lib/relation-maps.js";
import { sendList, sendSuccess } from "../lib/response.js";
import { errors } from "../lib/app-error.js";
import * as reporting from "../services/reporting.service.js";
import { paginate } from "../lib/pagination.js";
import {
  calendarDateMatch,
  effectiveScope,
  maturityListFilter,
  resolveDatePreset,
  searchRegex,
} from "../lib/query-filters.js";
import {
  duesBoardSummary,
  pickWorkboardInstallment,
} from "../services/admin-summary.service.js";
import { monthKey } from "../lib/date.js";
import dayjs from "dayjs";

export const dashboard = async (req, res) =>
  sendSuccess(res, await reporting.dashboard(req));
export const chart = async (req, res) =>
  sendSuccess(res, await reporting.chart(req, req.params.chartKey));
export const activity = async (req, res) =>
  sendList(res, await reporting.auditEvents(req));
export const report = async (req, res) => {
  const result = await reporting.report(req, req.params.reportKey);
  if (result?.meta) {
    const { meta, ...data } = result;
    return sendSuccess(res, data, meta);
  }
  return sendSuccess(res, result);
};
export const collectionSummary = async (req, res) =>
  sendSuccess(res, await reporting.collectionSummary(req));
export const createExport = async (req, res) =>
  sendSuccess(res, await reporting.createExport(req), {}, 202);
export const getExport = async (req, res) => {
  const job = await reporting.getExport(req);
  if (!job) throw errors.notFound("Export");
  return sendSuccess(res, job);
};
export const downloadExportFile = async (req, res) =>
  reporting.downloadExportFile(req, res);
export const auditEvents = async (req, res) =>
  sendList(res, await reporting.auditEvents(req));
export const navBadges = async (req, res) =>
  sendSuccess(res, await reporting.navBadges(req));

function dueBaseFilter(kind, query = {}) {
  const installmentKind = query.kind;
  if (kind === "maturities") return maturityListFilter(query);
  if (kind === "defaulters")
    return { status: "DEFAULTED", paymentPattern: "FIXED" };
  if (kind === "flexible-locks")
    return { status: "LOCKED", paymentPattern: "FLEXIBLE" };
  if (kind === "overdues") {
    return {
      paymentPattern: "FIXED",
      "installments.status":
        installmentKind && installmentKind !== "ALL"
          ? installmentKind
          : "OVERDUE",
    };
  }
  // dues board
  const statusFilter =
    installmentKind === "OVERDUE" ||
    installmentKind === "DEFAULTED" ||
    installmentKind === "GRACE" ||
    installmentKind === "DUE"
      ? installmentKind === "GRACE"
        ? { $in: ["DUE", "PARTIALLY_PAID"] }
        : installmentKind === "DUE"
          ? { $in: ["DUE", "PARTIALLY_PAID"] }
          : installmentKind
      : { $in: ["DUE", "PARTIALLY_PAID", "OVERDUE"] };
  return { paymentPattern: "FIXED", "installments.status": statusFilter };
}

export const dueList = (kind) => async (req, res) => {
  const dates = resolveDatePreset(req.query.preset, req.query);
  const filter = dueBaseFilter(kind, req.query);
  const scope = effectiveScope(req);

  if ((kind === "dues" || kind === "overdues") && (dates.from || dates.to)) {
    Object.assign(filter, calendarDateMatch("installments.dueDate", dates));
  }

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
    filter.$or = [
      { enrollmentNumber: pattern },
      { customerId: { $in: matchedCustomers.map((row) => row._id) } },
    ];
  }

  const result = await paginate(Scheme, {
    scope,
    filters: filter,
    cursor: req.query.cursor,
    limit: req.query.limit,
    sort: kind === "maturities" ? "maturityDate:asc" : "createdAt:desc",
  });
  if (kind === "maturities") {
    const { maturityBoardSummary } =
      await import("../services/admin-summary.service.js");
    result.meta = {
      ...result.meta,
      summary: await maturityBoardSummary(req),
    };
  }
  if (kind === "dues" || kind === "overdues") {
    result.meta = {
      ...result.meta,
      summary: await duesBoardSummary(req, kind),
    };
  }
  if (result.data.length) {
    const customerIds = [
      ...new Set(result.data.map((row) => row.customerId).filter(Boolean)),
    ];
    const branchIds = [
      ...new Set(result.data.map((row) => row.branchId).filter(Boolean)),
    ];
    const [customers, branchMap] = await Promise.all([
      Customer.find({ _id: { $in: customerIds } })
        .select("_id name mobile")
        .lean(),
      loadBranchMap(req.auth.tenantId, branchIds),
    ]);
    const customerMap = new Map(customers.map((row) => [row._id, row]));
    const schemeIds = result.data.map((row) => row._id);
    const ledgerRows = await LedgerEntry.find({
      tenantId: req.auth.tenantId,
      schemeId: { $in: schemeIds },
    })
      .select("schemeId type amountPaise weightMg")
      .lean();
    const ledgerByScheme = new Map();
    for (const entry of ledgerRows) {
      const list = ledgerByScheme.get(entry.schemeId) ?? [];
      list.push(entry);
      ledgerByScheme.set(entry.schemeId, list);
    }
    result.data = result.data.map((scheme) => {
      const customer = customerMap.get(scheme.customerId);
      const branch = branchMap.get(scheme.branchId);
      const installments = scheme.installments ?? [];
      const installmentPaidPaise = installments.reduce(
        (sum, row) => sum + (row.paidPaise ?? 0),
        0,
      );
      const ledger = ledgerTotals(ledgerByScheme.get(scheme._id) ?? []);
      const amountPaidPaise = ledger.amountPaidPaise || installmentPaidPaise;
      const base = {
        ...scheme,
        customer: customer
          ? {
              _id: customer._id,
              id: customer._id,
              name: customer.name,
              mobile: customer.mobile,
            }
          : undefined,
        branch: branchDto(branch),
        plan: scheme.planSnapshot
          ? {
              _id: scheme.planId,
              id: scheme.planId,
              name: scheme.planSnapshot.name,
              valueBasis: scheme.planSnapshot.valueBasis,
            }
          : undefined,
        totals: {
          amountPaidPaise,
          goldWeightMg: ledger.goldWeightMg,
          totalPaid: { amountPaise: amountPaidPaise },
        },
      };
      if (kind === "dues" || kind === "overdues") {
        const next = pickWorkboardInstallment(
          installments,
          kind,
          dates,
          req.query,
        );
        const targetCycle =
          scheme.paymentPattern === "FLEXIBLE" &&
          scheme.flexiblePhase === "CAPPED"
            ? monthKey()
            : undefined;
        return {
          ...base,
          duePreview: next
            ? {
                installmentNumber: next.number,
                dueDate: next.dueDate,
                amountPaise: next.amountPaise,
                paidPaise: next.paidPaise ?? 0,
                remainingPaise: Math.max(
                  0,
                  (next.amountPaise ?? 0) - (next.paidPaise ?? 0),
                ),
                status: next.status,
                graceEndsAt: next.graceEndsAt,
                paymentPattern: scheme.paymentPattern,
                flexiblePhase: scheme.flexiblePhase,
                targetCycle,
              }
            : null,
        };
      }
      return base;
    });
    if (kind === "dues" || kind === "overdues") {
      result.data = result.data.filter((row) => row.duePreview != null);
    }
  }
  sendList(res, result);
};
async function enrichMaturitySchemeRows(req, schemes) {
  if (!schemes.length) return [];
  const customerIds = [
    ...new Set(schemes.map((row) => row.customerId).filter(Boolean)),
  ];
  const branchIds = [
    ...new Set(schemes.map((row) => row.branchId).filter(Boolean)),
  ];
  const [customers, branchMap] = await Promise.all([
    Customer.find({ _id: { $in: customerIds } })
      .select("_id name mobile")
      .lean(),
    loadBranchMap(req.auth.tenantId, branchIds),
  ]);
  const customerMap = new Map(customers.map((row) => [row._id, row]));
  const schemeIds = schemes.map((row) => row._id);
  const ledgerRows = await LedgerEntry.find({
    tenantId: req.auth.tenantId,
    schemeId: { $in: schemeIds },
  })
    .select("schemeId type amountPaise weightMg")
    .lean();
  const ledgerByScheme = new Map();
  for (const entry of ledgerRows) {
    const list = ledgerByScheme.get(entry.schemeId) ?? [];
    list.push(entry);
    ledgerByScheme.set(entry.schemeId, list);
  }
  return schemes.map((scheme) => {
    const customer = customerMap.get(scheme.customerId);
    const branch = branchMap.get(scheme.branchId);
    const installments = scheme.installments ?? [];
    const installmentPaidPaise = installments.reduce(
      (sum, row) => sum + (row.paidPaise ?? 0),
      0,
    );
    const ledger = ledgerTotals(ledgerByScheme.get(scheme._id) ?? []);
    const amountPaidPaise = ledger.amountPaidPaise || installmentPaidPaise;
    return {
      ...scheme,
      customer: customer
        ? {
            _id: customer._id,
            id: customer._id,
            name: customer.name,
            mobile: customer.mobile,
          }
        : undefined,
      branch: branchDto(branch),
      plan: scheme.planSnapshot
        ? {
            _id: scheme.planId,
            id: scheme.planId,
            name: scheme.planSnapshot.name,
            valueBasis: scheme.planSnapshot.valueBasis,
          }
        : undefined,
      totals: {
        amountPaidPaise,
        goldWeightMg: ledger.goldWeightMg,
        totalPaid: { amountPaise: amountPaidPaise },
      },
    };
  });
}

export const maturityCalendar = async (req, res) => {
  const month = String(req.query.month ?? monthKey()).slice(0, 7);
  const from = `${month}-01`;
  const to = dayjs(`${month}-01`).endOf("month").format("YYYY-MM-DD");
  const filter = maturityListFilter({
    ...req.query,
    from,
    to,
    preset: undefined,
  });
  const scope = effectiveScope(req);
  const rows = await Scheme.find({ ...scope, ...filter })
    .sort({ maturityDate: 1 })
    .lean();
  const items = await enrichMaturitySchemeRows(req, rows);
  const dayMap = new Map();
  for (const row of items) {
    const date = String(row.maturityDate ?? "").slice(0, 10);
    if (!date) continue;
    const bucket = dayMap.get(date) ?? { date, count: 0, schemeIds: [] };
    bucket.count += 1;
    bucket.schemeIds.push(row._id);
    dayMap.set(date, bucket);
  }
  const days = [...dayMap.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  sendSuccess(res, {
    month,
    days,
    items,
    monthSummary: {
      count: items.length,
      peakDate:
        days.reduce(
          (best, d) => (d.count > (best?.count ?? 0) ? d : best),
          null,
        )?.date ?? null,
    },
  });
};
export const staffHome = async (req, res) => {
  const scope = effectiveScope(req);
  const summary = await reporting.collectionSummary(req);
  const customers = await Customer.countDocuments(scope);
  const schemes = await Scheme.countDocuments({
    ...scope,
    status: { $in: ["ACTIVE", "LOCKED", "DEFAULTED"] },
  });
  sendSuccess(res, { today: summary, customers, activeSchemes: schemes });
};
