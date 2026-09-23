import { Customer, Payment, Redemption, Scheme } from "../models/index.js";
import { netCollectionStatusFilter } from "../lib/payment-net-aggregation.js";
import { effectiveScope, fuzzyMongoFilter } from "../lib/query-filters.js";

const MIN_QUERY_LEN = 2;
const MAX_QUERY_LEN = 120;
const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 10;

function branchFilter(req) {
  const scope = effectiveScope(req);
  if (scope.branchId) return { branchId: scope.branchId };
  return {};
}

const CUSTOMER_SEARCH_FIELDS = [
  "name",
  "mobile",
  "customerNumber",
  "passbookNumber",
  "email",
];

function mapCustomer(row) {
  return {
    id: row._id,
    kind: "CUSTOMER",
    title: row.name ?? "Customer",
    subtitle: row.mobile ?? row.customerNumber ?? "",
    meta: row.customerNumber ?? undefined,
  };
}

function mapEnrollment(row, customerName) {
  return {
    id: row._id,
    kind: "ENROLLMENT",
    title: row.enrollmentNumber ?? row._id,
    subtitle: [customerName, row.planSnapshot?.name].filter(Boolean).join(" · "),
    meta: row.status,
  };
}

function mapReceipt(row, customerName, enrollmentNo) {
  return {
    id: row._id,
    kind: "RECEIPT",
    title: row.receiptNumber ?? row._id,
    subtitle: [customerName, enrollmentNo].filter(Boolean).join(" · "),
    meta: row.paidAt,
  };
}

function mapRedemption(row, customerName, enrollmentNo) {
  return {
    id: row._id,
    kind: "REDEMPTION",
    title: enrollmentNo ?? row._id,
    subtitle: [customerName, row.status, row.closureType].filter(Boolean).join(" · "),
    meta: row.createdAt,
  };
}

export async function globalSearch(req) {
  const query = String(req.query.q ?? "").trim().slice(0, MAX_QUERY_LEN);
  const limit = Math.min(
    Math.max(Number(req.query.limit) || DEFAULT_LIMIT, 1),
    MAX_LIMIT,
  );
  const customerFuzzy = fuzzyMongoFilter(CUSTOMER_SEARCH_FIELDS, query);
  if (!customerFuzzy || query.length < MIN_QUERY_LEN) {
    return { query, groups: [] };
  }

  const tenantId = req.auth.tenantId;
  const branch = branchFilter(req);
  const customerScope = { tenantId, ...branch };

  const matchedCustomers = await Customer.find({
    ...customerScope,
    ...customerFuzzy,
  })
    .select("_id name mobile customerNumber")
    .limit(40)
    .lean();
  const customerIds = matchedCustomers.map((row) => row._id);
  const customerById = new Map(matchedCustomers.map((row) => [String(row._id), row]));

  const enrollmentFuzzy = fuzzyMongoFilter(["enrollmentNumber"], query);
  const schemeOr = [];
  if (enrollmentFuzzy) schemeOr.push(enrollmentFuzzy);
  if (customerIds.length) schemeOr.push({ customerId: { $in: customerIds } });

  const receiptFuzzy = fuzzyMongoFilter(["receiptNumber"], query);
  const paymentOr = [];
  if (receiptFuzzy) paymentOr.push(receiptFuzzy);
  if (customerIds.length) paymentOr.push({ customerId: { $in: customerIds } });

  const [customers, schemes, payments, redemptions] = await Promise.all([
    Customer.find({ ...customerScope, ...customerFuzzy })
      .select("_id name mobile customerNumber")
      .sort({ name: 1 })
      .limit(limit)
      .lean(),
    schemeOr.length
      ? Scheme.find({ tenantId, ...branch, $or: schemeOr })
          .select("_id enrollmentNumber status customerId planSnapshot.name maturityDate")
          .sort({ enrollmentNumber: 1 })
          .limit(limit)
          .lean()
      : [],
    paymentOr.length
      ? Payment.find({
          tenantId,
          ...branch,
          ...netCollectionStatusFilter(),
          $or: paymentOr,
        })
          .select("_id receiptNumber amountPaise refundedAmountPaise paidAt customerId schemeId")
          .sort({ paidAt: -1 })
          .limit(limit)
          .lean()
      : [],
    (async () => {
      const schemeIdsByEnr =
        enrollmentFuzzy &&
        (await Scheme.find({
          tenantId,
          ...branch,
          ...enrollmentFuzzy,
        })
          .select("_id")
          .limit(20)
          .lean());
      const schemeIds = (schemeIdsByEnr ?? []).map((row) => row._id);
      const or = [];
      if (customerIds.length) or.push({ customerId: { $in: customerIds } });
      if (schemeIds.length) or.push({ schemeId: { $in: schemeIds } });
      const idFuzzy = fuzzyMongoFilter(["_id"], query);
      if (idFuzzy) or.push(idFuzzy);
      if (!or.length) return [];
      return Redemption.find({ tenantId, ...branch, $or: or })
        .select("_id status closureType mode customerId schemeId createdAt")
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean();
    })(),
  ]);

  const extraCustomerIds = new Set(customerIds.map(String));
  for (const row of schemes) if (row.customerId) extraCustomerIds.add(String(row.customerId));
  for (const row of payments) if (row.customerId) extraCustomerIds.add(String(row.customerId));
  for (const row of redemptions) if (row.customerId) extraCustomerIds.add(String(row.customerId));

  const missingCustomerIds = [...extraCustomerIds].filter((id) => !customerById.has(id));
  if (missingCustomerIds.length) {
    const extra = await Customer.find({
      tenantId,
      _id: { $in: missingCustomerIds },
    })
      .select("_id name mobile customerNumber")
      .lean();
    for (const row of extra) customerById.set(String(row._id), row);
  }

  const schemeIds = [...new Set(payments.map((p) => p.schemeId).filter(Boolean))];
  const redemptionSchemeIds = redemptions.map((r) => r.schemeId).filter(Boolean);
  const allSchemeIds = [...new Set([...schemeIds, ...redemptionSchemeIds, ...schemes.map((s) => s._id)])];
  const schemeRows = allSchemeIds.length
    ? await Scheme.find({ tenantId, _id: { $in: allSchemeIds } })
        .select("_id enrollmentNumber")
        .lean()
    : [];
  const schemeById = new Map(schemeRows.map((row) => [String(row._id), row]));

  const customerName = (id) => customerById.get(String(id))?.name ?? "";
  const enrollmentNo = (id) => schemeById.get(String(id))?.enrollmentNumber ?? "";

  const groups = [];
  if (customers.length) {
    groups.push({
      kind: "CUSTOMER",
      label: "Customers",
      items: customers.map(mapCustomer),
    });
  }
  if (schemes.length) {
    groups.push({
      kind: "ENROLLMENT",
      label: "Enrollments",
      items: schemes.map((row) => mapEnrollment(row, customerName(row.customerId))),
    });
  }
  if (payments.length) {
    groups.push({
      kind: "RECEIPT",
      label: "Receipts",
      items: payments.map((row) =>
        mapReceipt(row, customerName(row.customerId), enrollmentNo(row.schemeId)),
      ),
    });
  }
  if (redemptions.length) {
    groups.push({
      kind: "REDEMPTION",
      label: "Redemptions",
      items: redemptions.map((row) =>
        mapRedemption(row, customerName(row.customerId), enrollmentNo(row.schemeId)),
      ),
    });
  }

  return { query, groups };
}
