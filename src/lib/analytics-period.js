import dayjs from "dayjs";
import { Branch } from "../models/index.js";
import { env } from "../config/env.js";
import { resolveQueryDateRange } from "./query-filters.js";
import { AppError } from "./app-error.js";

const MONTH_MS = 366 * 24 * 60 * 60 * 1000;
const TZ = env.APP_TIMEZONE ?? "Asia/Kolkata";

function shiftYmd(ymdStr, days) {
  return dayjs.tz(ymdStr, TZ).add(days, "day").format("YYYY-MM-DD");
}

export function parseAnalyticsYmd(ymd) {
  const parsed = dayjs.tz(String(ymd ?? "").slice(0, 10), TZ);
  return parsed.isValid() ? parsed : null;
}

export function assertAnalyticsPeriod(query = {}) {
  const { from, to } = resolveQueryDateRange({
    ...query,
    period: query.period ?? "THIS_MONTH",
  });
  if (!from || !to) {
    throw new AppError(
      "ANALYTICS_RANGE_REQUIRED",
      "Choose a start and end date for analytics.",
      422,
    );
  }
  const start = parseAnalyticsYmd(from);
  const end = parseAnalyticsYmd(to);
  if (!start || !end) {
    throw new AppError(
      "ANALYTICS_RANGE_INVALID",
      "Use valid calendar dates (YYYY-MM-DD).",
      422,
    );
  }
  if (end.isBefore(start, "day")) {
    throw new AppError(
      "ANALYTICS_RANGE_INVALID",
      "End date must be on or after start date.",
      422,
    );
  }
  const rangeMs = end.endOf("day").valueOf() - start.startOf("day").valueOf();
  if (rangeMs > 12 * MONTH_MS) {
    throw new AppError(
      "ANALYTICS_RANGE_TOO_LARGE",
      "Analytics range cannot exceed 12 months.",
      422,
    );
  }
  return { from, to };
}

export function periodDayCount(from, to) {
  const start = parseAnalyticsYmd(from);
  const end = parseAnalyticsYmd(to);
  if (!start || !end) return 0;
  return end.diff(start, "day") + 1;
}

export function previousPeriod(from, to) {
  const days = periodDayCount(from, to);
  const prevTo = shiftYmd(from, -1);
  const prevFrom = shiftYmd(prevTo, -(days - 1));
  return { from: prevFrom, to: prevTo };
}

export function inferTrendGroupBy(from, to, requested) {
  const group = String(requested ?? "").trim().toUpperCase();
  if (["DAY", "WEEK", "MONTH", "YEAR"].includes(group)) return group;
  const days = periodDayCount(from, to);
  if (days <= 7) return "DAY";
  if (days <= 31) return "WEEK";
  if (days <= 366) return "MONTH";
  return "YEAR";
}

export function weekStartYmd(ymd) {
  const d = parseAnalyticsYmd(ymd);
  if (!d) return ymd;
  const weekday = d.day();
  const diff = weekday === 0 ? 6 : weekday - 1;
  return d.subtract(diff, "day").format("YYYY-MM-DD");
}

export function* iteratePeriodBuckets(from, to, groupBy) {
  const start = parseAnalyticsYmd(from);
  const end = parseAnalyticsYmd(to);
  if (!start || !end) return;

  if (groupBy === "DAY") {
    let cur = start.startOf("day");
    const limit = end.startOf("day");
    while (!cur.isAfter(limit, "day")) {
      yield cur.format("YYYY-MM-DD");
      cur = cur.add(1, "day");
    }
    return;
  }

  if (groupBy === "WEEK") {
    let cur = parseAnalyticsYmd(weekStartYmd(from)).startOf("day");
    const limit = end.startOf("day");
    while (!cur.isAfter(limit, "day")) {
      yield cur.format("YYYY-MM-DD");
      cur = cur.add(7, "day");
    }
    return;
  }

  if (groupBy === "MONTH") {
    let cur = start.startOf("month");
    const limit = end.startOf("month");
    while (!cur.isAfter(limit, "month")) {
      yield cur.format("YYYY-MM");
      cur = cur.add(1, "month");
    }
    return;
  }

  let cur = start.startOf("year");
  const limit = end.startOf("year");
  while (!cur.isAfter(limit, "year")) {
    yield cur.format("YYYY");
    cur = cur.add(1, "year");
  }
}

export function formatPeriodLabel(from, to) {
  const start = parseAnalyticsYmd(from);
  const end = parseAnalyticsYmd(to);
  if (!start || !end) return `${from} – ${to}`;
  if (from === to) return start.format("D MMM YYYY");
  if (start.isSame(end, "month")) {
    return `${start.format("D")}–${end.format("D MMM YYYY")}`;
  }
  return `${start.format("D MMM YYYY")} – ${end.format("D MMM YYYY")}`;
}

export function bucketAsOfYmd(bucketKey, groupBy, periodTo) {
  const end = String(periodTo ?? "").slice(0, 10);
  if (groupBy === "DAY") return bucketKey;
  if (groupBy === "YEAR") {
    const yearEnd = dayjs
      .tz(`${bucketKey}-01-01`, TZ)
      .endOf("year")
      .format("YYYY-MM-DD");
    return !end || yearEnd <= end ? yearEnd : end;
  }
  if (groupBy === "MONTH") {
    const monthEnd = dayjs
      .tz(`${bucketKey}-01`, TZ)
      .endOf("month")
      .format("YYYY-MM-DD");
    return !end || monthEnd <= end ? monthEnd : end;
  }
  const weekEnd = parseAnalyticsYmd(bucketKey)?.add(6, "day").format("YYYY-MM-DD");
  return weekEnd && (!end || weekEnd <= end) ? weekEnd : end || weekEnd || bucketKey;
}

export function formatTrendBucketLabel(bucketKey, groupBy) {
  if (groupBy === "YEAR") {
    return bucketKey;
  }
  if (groupBy === "MONTH") {
    const d = dayjs.tz(`${bucketKey}-01`, TZ);
    return d.isValid() ? d.format("MMM YYYY") : bucketKey;
  }
  const d = parseAnalyticsYmd(bucketKey);
  if (!d) return bucketKey;
  if (groupBy === "WEEK") return `Week of ${d.format("D MMM")}`;
  return d.format("D MMM");
}

export function percentChange(current, previous) {
  const cur = Number(current) || 0;
  const prev = Number(previous) || 0;
  if (prev === 0) {
    if (cur === 0) return null;
    return { percent: 100, direction: "up", isGood: true };
  }
  const raw = ((cur - prev) / prev) * 100;
  const rounded = Math.round(Math.abs(raw) * 10) / 10;
  return {
    percent: rounded,
    direction: raw >= 0 ? "up" : "down",
    isGood: raw >= 0,
  };
}

export async function buildAnalyticsScope(scope) {
  if (!scope.branchId) {
    return { level: "TENANT", label: "All showrooms", branchId: null };
  }
  const branch = await Branch.findOne({
    _id: scope.branchId,
    tenantId: scope.tenantId,
  })
    .select("_id name code")
    .lean();
  return {
    level: "BRANCH",
    label: branch?.name ?? branch?.code ?? "Branch",
    branchId: scope.branchId,
    branch: branch
      ? { id: branch._id, name: branch.name, code: branch.code }
      : undefined,
  };
}

export function rollupDailyRegistrationCounts(dailyRows, from, to, groupBy) {
  const dailyMap = new Map(
    dailyRows.map((row) => [String(row._id), Number(row.count) || 0]),
  );

  if (groupBy === "DAY") {
    return [...iteratePeriodBuckets(from, to, "DAY")].map((key) => ({
      key,
      count: dailyMap.get(key) ?? 0,
    }));
  }

  if (groupBy === "WEEK") {
    const weekMap = new Map();
    for (const [day, count] of dailyMap) {
      const weekKey = weekStartYmd(day);
      weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + count);
    }
    return [...iteratePeriodBuckets(from, to, "WEEK")].map((key) => ({
      key,
      count: weekMap.get(key) ?? 0,
    }));
  }

  if (groupBy === "MONTH") {
    const monthMap = new Map();
    for (const [day, count] of dailyMap) {
      const monthKey = day.slice(0, 7);
      monthMap.set(monthKey, (monthMap.get(monthKey) ?? 0) + count);
    }
    return [...iteratePeriodBuckets(from, to, "MONTH")].map((key) => ({
      key,
      count: monthMap.get(key) ?? 0,
    }));
  }

  const yearMap = new Map();
  for (const [day, count] of dailyMap) {
    const yearKey = day.slice(0, 4);
    yearMap.set(yearKey, (yearMap.get(yearKey) ?? 0) + count);
  }
  return [...iteratePeriodBuckets(from, to, "YEAR")].map((key) => ({
    key,
    count: yearMap.get(key) ?? 0,
  }));
}
