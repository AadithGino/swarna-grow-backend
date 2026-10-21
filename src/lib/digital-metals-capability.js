import { presentDigitalMetalsAccessState } from "./digital-metals-access.js";

function liveTradingReadinessBlockers(_tenant) {
  return [];
}

/**
 * Server-authoritative capability DTO (Phase 1+).
 * @param {object} tenant
 * @param {object} context
 * @param {boolean} [context.hasHoldings]
 * @param {boolean} [context.hasOpenSettlement]
 * @param {boolean} [context.hasOpenFulfilment]
 * @param {boolean} [context.hasLegacyActivity]
 * @param {object} [context.scope] req.scope
 */
export function buildDigitalMetalsCapability(tenant, context = {}) {
  const access = presentDigitalMetalsAccessState(tenant);
  const hasHoldings = context.hasHoldings === true;
  const hasOpenSettlement = context.hasOpenSettlement === true;
  const hasOpenFulfilment = context.hasOpenFulfilment === true;
  const hasLegacyActivity = context.hasLegacyActivity === true
    || hasHoldings
    || hasOpenSettlement
    || hasOpenFulfilment;

  const blockers = [];
  if (!access.planEntitled) {
    blockers.push({
      code: "PLAN_NOT_ENTITLED",
      message: "Digital Gold & Silver is not included in your subscription plan.",
    });
  }
  if (access.planEntitled && !access.enabled) {
    blockers.push({
      code: "MODULE_DISABLED",
      message: "Digital Gold & Silver is not enabled for this jeweller.",
    });
  }
  if (access.paused) {
    blockers.push({
      code: "OPERATIONS_PAUSED",
      message: tenant?.operations?.digitalMetalsPlatformPaused
        ? (tenant?.operations?.digitalMetalsPlatformPauseReason || "Paused by platform operations.")
        : (tenant?.operations?.digitalMetalsPauseReason || "Trading is temporarily paused."),
    });
  }

  const readinessBlockers = liveTradingReadinessBlockers(tenant);
  const canViewHoldings = hasLegacyActivity
    || (access.planEntitled && access.enabled);
  const canViewHistory = canViewHoldings;
  const canAccessSettlement = hasOpenSettlement
    || (access.planEntitled && access.enabled);
  const canAccessFulfilment = hasOpenFulfilment
    || (access.planEntitled && access.enabled);

  const tradingAllowed = access.active && readinessBlockers.length === 0;

  return {
    enabled: access.active,
    planEntitled: access.planEntitled,
    tenantEnabled: access.enabled,
    paused: access.paused,
    hasLegacyActivity,
    canViewHoldings,
    canViewHistory,
    canAccessSettlement,
    canAccessFulfilment,
    canPlaceNewBuy: tradingAllowed,
    canPlaceNewSell: tradingAllowed,
    canPlaceRedemption: tradingAllowed,
    blockers: [...blockers, ...readinessBlockers],
    termsVersion: tenant?.operations?.digitalMetalsTermsVersion ?? null,
    scope: context.scope
      ? {
          roleScope: context.scope.roleScope ?? null,
          branchId: context.scope.branchId ?? null,
        }
      : undefined,
    implementationPhase: 1,
    workspaceLive: false,
  };
}
