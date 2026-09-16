import { PaymentPattern, ValueBasis } from "../constants/enums.js";
import { moneyRef, rateRef, weightRef } from "./money.js";
import { maskMobile } from "./mobile.js";
import { buildAmountSummary, planBenefitLabel } from "./plan-amount-summary.js";

export function withId(doc) {
  if (!doc || typeof doc !== "object") return doc;
  const id = doc.id ?? doc._id;
  if (!id) return doc;
  const { _id, ...rest } = doc;
  return { ...rest, id: String(id) };
}

export function tenantPortalCapabilitiesDto(tenant) {
  if (!tenant) {
    return {
      customerSelfEnrol: true,
      customerSelfRegistration: true,
      kycMandatory: false,
      multiScheme: true,
    };
  }
  const ops = tenant.operations ?? {};
  const settings = tenant.settings ?? {};
  const oneSchemeOnly =
    settings.oneActiveSchemePerCustomer === true || ops.multiSchemePerCustomer === false;
  return {
    customerSelfEnrol: ops.customerSelfEnrolEnabled !== false,
    customerSelfRegistration: ops.customerSelfRegistrationEnabled !== false,
    kycMandatory: Boolean(settings.requireKycForEnrolment),
    multiScheme: !oneSchemeOnly,
  };
}

export function tenantBrandingDto(tenant) {
  if (!tenant) return null;
  const branding = tenant.branding ?? {};
  const primary = branding.primaryColor ?? "#730321";
  const accent = branding.accentColor ?? "#C9A227";
  return {
    tenantCode: tenant.code,
    displayName: branding.displayName ?? tenant.name,
    appDisplayName: branding.appDisplayName ?? branding.displayName ?? tenant.name,
    logoUrl: branding.logoUploadId ? `/uploads/${branding.logoUploadId}` : null,
    primaryColor: primary,
    accentColor: accent,
    foregroundColor: branding.foregroundColor ?? "#FFFFFF",
    contrastColor: branding.contrastColor ?? primary,
    supportNumber: tenant.supportNumber ?? tenant.mobile ?? null,
    city: tenant.city ?? branding.city ?? null,
    ...tenantPortalCapabilitiesDto(tenant),
  };
}

export function tenantResolveRow(tenant, resolvedBy) {
  return {
    id: tenant._id,
    ...tenantBrandingDto(tenant),
    resolvedBy,
    status: tenant.status ?? "ACTIVE",
  };
}

export function otpRequestDto(payload) {
  return {
    otpId: payload.otpId,
    channel: payload.channel ?? "SMS",
    maskedMobile: payload.maskedMobile,
    resendAvailableInSeconds: payload.resendAvailableInSeconds ?? 30,
    attemptsAllowed: payload.attemptsAllowed ?? 5,
    isRegistered: Boolean(payload.isRegistered),
    expiresInSeconds: payload.expiresInSeconds,
  };
}

/** True when onboarding was finished explicitly or the customer predates profileCompletedAt tracking. */
export function isCustomerProfileComplete(customer) {
  if (!customer) return false;
  if (customer.profileCompletedAt) return true;
  const name = String(customer.name ?? "").trim();
  return name.length >= 2 && name !== "Customer";
}

export function customerProfileDto(customer, tenant, branch) {
  if (!customer) return null;
  const kyc = customer.kyc ?? {};
  const verified = kyc.status === "VERIFIED";
  return {
    id: customer._id,
    tenantId: customer.tenantId,
    customerNumber: customer.customerNumber,
    passbookNumber: customer.passbookNumber ?? null,
    name: customer.name,
    mobile: customer.mobile,
    mobileImmutable: true,
    email: customer.email ?? null,
    dateOfBirth: customer.dateOfBirth ?? null,
    address: parseAddress(customer.address),
    branch: branch
      ? { id: branch._id, code: branch.code, name: branch.name }
      : null,
    whatsappOptIn: !customer.whatsappOptedOutAt,
    memberSince: customer.createdAt,
    profileComplete: isCustomerProfileComplete(customer),
    profileCompleteness: profileCompleteness(customer),
    kyc: {
      status: kyc.status ?? "NOT_SUBMITTED",
      statusLabel: kycStatusLabel(kyc.status),
      type: kyc.type ?? null,
      numberMasked: kyc.numberMasked ?? null,
      canUpdate: !verified,
      verifiedAt: kyc.verifiedAt ?? null,
    },
    nominee: mapNomineeDto(customer.nominee),
    nomineeEditable: true,
    status: customer.status,
    version: customer.version ?? 1,
    tenant: tenantBrandingDto(tenant),
  };
}

function parseAddress(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;
  return { line1: String(raw) };
}

function profileCompleteness(customer) {
  const fields = ["name", "email", "dateOfBirth", "address"];
  const filled = fields.filter((key) => {
    const v = customer[key];
    return v != null && String(v).trim() !== "";
  }).length;
  return { filled, total: fields.length, complete: isCustomerProfileComplete(customer) };
}

function kycStatusLabel(status) {
  const map = {
    NOT_SUBMITTED: "Not submitted",
    SUBMITTED: "Under review",
    PENDING: "Under review",
    VERIFIED: "Verified",
    REJECTED: "Rejected",
  };
  return map[status] ?? status ?? "Not submitted";
}

const NOMINEE_RELATIONSHIP_LABEL = {
  SPOUSE: "Spouse",
  PARENT: "Parent",
  CHILD: "Child",
  SIBLING: "Sibling",
  RELATIVE: "Relative",
  FRIEND: "Friend",
  OTHER: "Other",
};

function mapNomineeDto(nominee) {
  if (!nominee) return null;
  return {
    ...nominee,
    relationshipLabel: NOMINEE_RELATIONSHIP_LABEL[nominee.relationship] ?? nominee.relationship,
    notes: nominee.address ?? null,
  };
}

export function enrichPayableRange(quote, scheme) {
  const helperBits = [];
  if (quote.contributionIsOptional) {
    helperBits.push("Contributions are optional in this phase.");
    helperBits.push("Unused monthly allowance does not carry forward.");
    helperBits.push("Paid amounts remain in your scheme permanently.");
  }
  const maxPayablePaise = quote.maxPayablePaise ?? 0;
  const remainingPaise = quote.remainingPaise ?? maxPayablePaise;
  const cycleCapPaise = quote.capPaise ?? (quote.phase === "CAPPED" ? quote.capPaise : null);
  const quickAmounts = buildQuickAmounts({ ...quote, maxPayablePaise: remainingPaise });
  const positionVersion = quote.positionVersion ?? scheme?.positionVersion ?? 0;
  return {
    model: quote.model,
    phase: quote.phase ?? null,
    targetCycle: quote.targetCycle ?? null,
    contributionIsOptional: quote.contributionIsOptional !== false,
    payable: quote.payable !== false,
    minPayable: moneyRef(quote.minPayablePaise ?? 0),
    maxPayable: moneyRef(remainingPaise),
    suggested: moneyRef(quote.suggestedPaise ?? remainingPaise),
    cycleCap: cycleCapPaise != null ? moneyRef(cycleCapPaise) : null,
    remainingThisCycle: moneyRef(remainingPaise),
    multipleOfPaise: quote.paymentIncrementPaise ?? 1,
    multipleOf: moneyRef(quote.paymentIncrementPaise ?? 1),
    isMandatory: quote.isMandatory === true,
    maxReason:
      quote.maxReason ??
      (remainingPaise === 0 ? "CYCLE_CAP_REACHED" : quote.payable === false ? "NOTHING_DUE" : null),
    finalRemainderException: Boolean(quote.allowFinalRemainderBelowMinimum),
    helperText: helperBits.join(" "),
    quickAmounts,
    nextCycleAction: quote.nextCycleAction ?? null,
    positionVersion,
    paidMoneyNeverExpires: true,
    unusedAllowanceCarriesForward: false,
  };
}

function buildQuickAmounts(quote) {
  const max = quote.maxPayablePaise ?? 0;
  const min = quote.minPayablePaise ?? 0;
  if (max <= 0) return [];
  const candidates = [min, max];
  if (max > min) candidates.push(Math.round((min + max) / 2));
  return [...new Set(candidates.filter((n) => n > 0))].map((n) => moneyRef(n));
}

export function publicPayPageDto({ link, tenant, customer, scheme, canPay, message }) {
  const branding = tenantBrandingDto(tenant);
  return {
    linkId: link._id,
    status: link.status,
    jeweller: branding,
    customerName: customer?.name ?? null,
    maskedMobile: customer?.mobile ? maskMobile(customer.mobile) : null,
    schemeLabel: scheme?.enrollmentNumber ?? scheme?.planSnapshot?.displayName ?? scheme?.planSnapshot?.name ?? null,
    installmentLabel: scheme?.paymentPattern === "FIXED" ? "Fixed instalment" : "Flexible contribution",
    dueDate: link.dueDate ?? link.expiresAt ?? null,
    amount: moneyRef(link.amountPaise ?? 0),
    canPay: Boolean(canPay),
    expiredOrCancelledMessage: message ?? null,
    supportNumber: branding?.supportNumber ?? null,
    expiresAt: link.expiresAt,
  };
}

export function paymentPollStatusDto({ link, payment, scheme }) {
  const state = derivePaymentUiState(link, payment);
  return {
    linkId: link._id,
    status: state,
    processing: state === "PROCESSING",
    paid: state === "PAID",
    failed: state === "FAILED",
    receipt: payment?.status === "SUCCESS"
      ? { paymentId: payment._id, receiptNumber: payment.receiptNumber, paidAt: payment.paidAt }
      : null,
    updatedScheme: scheme ? withId(scheme) : null,
    retryAfterSeconds: state === "PROCESSING" ? 3 : null,
  };
}

/** UI poll status — maps link + payment storage states. */
export function derivePaymentUiState(link, payment) {
  if (link.status === "PAID" || payment?.status === "SUCCESS") return "PAID";
  if (link.status === "EXPIRED") return "EXPIRED";
  if (link.status === "CANCELLED") return "CANCELLED";
  if (payment?.status === "FAILED" || payment?.status === "REVERSED") return "FAILED";
  if (payment?.status === "PENDING") return "PROCESSING";
  return "PROCESSING";
}

export function paymentLinkDto(link, token) {
  return {
    id: link._id,
    paymentLinkId: link._id,
    token: token ?? undefined,
    gatewayUrl: link.url ?? (token ? `/pay/${token}` : undefined),
    amount: moneyRef(link.amountPaise ?? 0),
    status: link.status,
    expiresAt: link.expiresAt,
    transactionId: link.paymentId ?? null,
  };
}

export function paymentIntentAppDto(intent, extras = {}) {
  const positionVersion = intent.positionVersion ?? extras.positionVersion ?? 0;
  return {
    id: intent._id,
    intentId: intent._id,
    schemeId: intent.schemeId,
    targetCycle: intent.targetCycle ?? null,
    amount: moneyRef(intent.amountPaise ?? 0),
    status: intent.status,
    positionVersion,
    expiresAt: intent.reservationExpiresAt ?? extras.expiresAt ?? null,
    paymentUrl: extras.redirectUrl ?? extras.paymentUrl ?? null,
    statusPollUrl: `/app/payment-intents/${intent._id}`,
    paymentId: intent.paymentId ?? extras.paymentId ?? null,
    providerOrderId: intent.providerOrderId ?? extras.providerOrderId ?? null,
    retryAfterSeconds: extras.retryAfterSeconds ?? 3,
    auditEventId: extras.auditEventId ?? null,
  };
}

export function paymentIntentCancelDto(intent, payment, scheme) {
  return {
    intentId: intent._id,
    intentStatus: intent.status,
    paymentId: payment?._id ?? intent.paymentId,
    paymentStatus: payment?.status ?? "FAILED",
    positionVersion: scheme?.positionVersion ?? null,
    reservationReleased: intent.status === "CANCELLED",
  };
}

export function enrolPaymentResponse(paymentType, payload) {
  if (paymentType === "FIXED_PAYMENT_LINK") {
    return { paymentType, paymentLink: payload };
  }
  return { paymentType: "FLEXIBLE_PAYMENT_INTENT", paymentIntent: payload };
}

function valueBasisLabel(valueBasis) {
  if (valueBasis === ValueBasis.GOLD_WEIGHT) return "Gold savings";
  return "Rupee savings";
}

function paymentPatternLabel(paymentPattern) {
  if (paymentPattern === PaymentPattern.FLEXIBLE) return "Pay as you like, then monthly";
  return "Fixed monthly";
}

function buildFlexibleSummary(plan) {
  if (plan.paymentPattern !== PaymentPattern.FLEXIBLE) return null;
  const flex = plan.flexibleRules ?? {};
  const phase = flex.flexiblePhase ?? {};
  const free = flex.flexiblePhaseCycles ?? null;
  const capped = flex.cappedPhaseCycles ?? null;
  const explainer =
    String(plan.description ?? "").trim() ||
    (free != null && capped != null
      ? `Contribute any amount for the first ${free} cycles. From cycle ${(free ?? 0) + 1}, pay up to your snapshotted monthly average (plus plan rules).`
      : null);
  return {
    freeWindowMonths: free,
    lockWindowMonths: capped,
    explainer,
    minPerPayment:
      phase.minimumPaymentPaise != null ? moneyRef(phase.minimumPaymentPaise) : null,
    maxPerPayment:
      phase.maximumPaymentPaise != null ? moneyRef(phase.maximumPaymentPaise) : null,
  };
}

function buildPlanHighlights(plan) {
  const highlights = [];
  const benefit = planBenefitLabel(plan);
  if (plan.paymentPattern === PaymentPattern.FIXED) {
    if (plan.durationMonths) highlights.push(`${plan.durationMonths} monthly payments`);
    const rules = plan.amountRules ?? {};
    if (rules.amountMode === "JEWELLER_FIXED") highlights.push("Same instalment every month");
    if (rules.amountMode === "CUSTOMER_CHOSEN") highlights.push("You choose your monthly amount within plan limits");
  } else {
    const flex = plan.flexibleRules ?? {};
    if (flex.flexiblePhaseCycles) {
      highlights.push(`${flex.flexiblePhaseCycles} flexible contribution cycles`);
    }
    if (flex.cappedPhaseCycles) {
      highlights.push(`${flex.cappedPhaseCycles} capped cycles after averaging`);
    }
    highlights.push("Paid amounts never expire");
  }
  if (benefit) highlights.push(benefit);
  return highlights;
}

export function mapCustomerPlanListItem(plan, enrolCheck) {
  const id = String(plan._id ?? plan.id ?? "");
  const amountSummary =
    plan.amountSummary && typeof plan.amountSummary === "object" && plan.amountSummary.label
      ? plan.amountSummary
      : buildAmountSummary(plan);
  const benefitLabel = planBenefitLabel(plan);
  const paymentPattern = plan.paymentPattern;
  return {
    id,
    code: plan.code,
    displayName: plan.displayName ?? plan.name,
    name: plan.displayName ?? plan.name,
    description: plan.description ?? null,
    valueBasis: plan.valueBasis,
    valueBasisLabel: valueBasisLabel(plan.valueBasis),
    paymentPattern,
    paymentPatternLabel: paymentPatternLabel(paymentPattern),
    durationMonths: plan.durationMonths,
    amountSummary,
    benefitLabel,
    benefitType: plan.benefit?.type ?? null,
    highlights: buildPlanHighlights(plan),
    flexibleSummary: buildFlexibleSummary(plan),
    canEnrol: enrolCheck?.canEnrol ?? true,
    blockedReason: enrolCheck?.canEnrol === false ? enrolCheck.blockers?.[0]?.message ?? null : null,
  };
}

export function mapPastSchemeRow(scheme, redemption) {
  const displayMode =
    scheme.displayMode ??
    (scheme.paymentPattern === "FIXED"
      ? "FIXED"
      : scheme.flexiblePhase === "FLEXIBLE"
        ? "FLEXIBLE_FREE_WINDOW"
        : "FLEXIBLE_LOCK_WINDOW");
  return {
    id: scheme._id,
    schemeNumber: scheme.enrollmentNumber,
    planName: scheme.planSnapshot?.displayName ?? scheme.planSnapshot?.name,
    closureType: redemption?.closureType ?? (scheme.status === "CLOSED_PREMATURE" ? "PREMATURE" : "MATURITY"),
    closedAt: redemption?.completedAt ?? scheme.updatedAt,
    finalValue: moneyRef(redemption?.settlementPaise ?? scheme.totals?.amountPaidPaise ?? 0),
    benefitReceived: moneyRef(redemption?.benefitPaise ?? 0),
    redemptionMode: redemption?.mode ?? null,
    billNumber: redemption?.billNumber ?? null,
    closureReceiptUrl: redemption?.receiptUrl ?? null,
    passbookAvailable: true,
    displayMode,
  };
}

export function mapNotification(row) {
  return {
    id: row._id,
    type: row.type ?? "GENERAL",
    title: row.title ?? row.templateKey ?? "Notification",
    body: row.body ?? row.preview ?? "",
    createdAt: row.createdAt,
    read: Boolean(row.readAt),
    deepLink: row.deepLink ?? row.actionPath ?? null,
    cta: row.ctaLabel ?? null,
    imageUrl: row.imageUrl ?? null,
  };
}

export { maskMobile };
