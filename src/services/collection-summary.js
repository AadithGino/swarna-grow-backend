import { TenantRole } from "../constants/enums.js";
import { paymentListScope } from "../lib/payment-scope.js";
import { resolveQueryDateRange } from "../lib/query-filters.js";
import {
  aggregateCollectionPeriod,
  collectionPeriodBaseMatch,
} from "../lib/collection-period-aggregation.js";
import { schemeIdsForPlan } from "./report-builders/report-envelope.js";

export async function collectionSummary(req) {
  const range = resolveQueryDateRange(req.query);
  const scope = await paymentListScope(req);
  const extra =
    req.auth?.role === TenantRole.COLLECTION_AGENT
      ? { collectedBy: req.auth.id }
      : {};
  const schemeIds = await schemeIdsForPlan(scope, req.query.planId);
  const baseMatch = collectionPeriodBaseMatch(
    scope,
    {
      ...extra,
      ...(schemeIds ? { schemeId: { $in: schemeIds } } : {}),
    },
  );
  return aggregateCollectionPeriod(baseMatch, range);
}
