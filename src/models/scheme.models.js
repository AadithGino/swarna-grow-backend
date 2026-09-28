import mongoose from "mongoose";
import { AmountMode, AuditActorType, BelowMinimumTotalAction, BenefitTreatment, BenefitType, BonusBasis, CapFormula, CapMode, CapRoundingMode, CarryForwardMode, CycleStatus, DueDateRule, FirstInstallmentMode, FlexibleFrequencyMode, FlexiblePhase, GoldRateSource, InstallmentStatus, LedgerEntryType, PaymentPattern, PhaseMode, PrematurePenaltyMode, RedemptionMode, SchemePlanStatus, SchemeStatus, ValueBasis, WeightRoundingMode, ZeroFlexibleTotalAction } from "../constants/enums.js";
import { baseOptions, branchField, enumField, immutablePlugin, integerField, stringId, tenantField, versionField } from "./schema-helpers.js";

const schemePlanSchema = new mongoose.Schema({
  _id: stringId("spl"), tenantId: tenantField, name: { type: String, required: true }, code: { type: String, required: true, uppercase: true }, displayName: String, description: String, termsText: String,
  valueBasis: enumField(ValueBasis, { required: true }), paymentPattern: enumField(PaymentPattern, { required: true }), durationMonths: integerField({ required: true, min: 1 }), installmentCount: integerField({ required: true, min: 1 }),
  amountRules: { amountMode: enumField(AmountMode), fixedAmountPaise: integerField(), slabsPaise: [Number], minInstallmentPaise: integerField(), maxInstallmentPaise: integerField(), multipleOfPaise: integerField() },
  scheduleRules: { dueDateRule: enumField(DueDateRule), dueDayOfMonth: Number, graceDays: integerField(), firstInstallmentModeDefault: enumField(FirstInstallmentMode), firstInstallmentModeEditable: Boolean },
  paymentRules: { partialPaymentAllowed: Boolean, advancePaymentAllowed: Boolean, maxAdvanceInstallments: integerField(), minPaymentPaise: integerField(), maxPaymentPerTransactionPaise: integerField() },
  flexibleRules: { phaseMode: enumField(PhaseMode), capMode: enumField(CapMode), carryForwardMode: enumField(CarryForwardMode), flexiblePhaseCycles: integerField(), cappedPhaseCycles: integerField(), averagingDivisor: integerField(), frequencyMode: enumField(FlexibleFrequencyMode), flexiblePhase: { minimumPaymentPaise: integerField(), maximumPaymentPaise: integerField(), paymentIncrementPaise: integerField(), minTotalPaise: integerField(), maxPaymentsPerCycle: integerField(), paymentsRequiredPerCycle: integerField() }, capComputation: { formula: enumField(CapFormula), roundingMode: enumField(CapRoundingMode), roundToNearestPaise: integerField(), minCycleCapPaise: integerField(), maxCycleCapPaise: integerField(), onZeroFlexiblePhaseTotal: enumField(ZeroFlexibleTotalAction), onBelowMinimumTotal: enumField(BelowMinimumTotalAction) }, cappedPhase: { minimumPaymentPaise: integerField(), paymentIncrementPaise: integerField(), allowFinalRemainderBelowMinimum: Boolean, allowFutureCyclePayment: Boolean, maxAdvanceCycles: integerField() } },
  goldRules: { rateSource: enumField(GoldRateSource), weightRoundingMode: enumField(WeightRoundingMode), weightPrecisionMg: integerField(), blockPaymentIfRateNotSet: Boolean },
  benefit: { type: enumField(BenefitType), bonusBasis: enumField(BonusBasis), bonusValue: integerField(), maxBonusPaise: integerField(), textBenefit: String, eligibility: { requireAllInstallmentsPaid: Boolean, maxAllowedDefaults: integerField(), minMonthsCompleted: integerField() }, displayLabel: String },
  redemptionRules: { prematureClosureAllowed: Boolean, lockInMonths: integerField(), prematurePenalty: { mode: enumField(PrematurePenaltyMode), value: integerField(), flatPaise: integerField(), benefitTreatment: enumField(BenefitTreatment) }, allowedModes: [{ type: String, enum: Object.values(RedemptionMode) }], redeemAtAnyBranch: Boolean },
  availability: { allBranches: Boolean, branchIds: [String], enrolmentOpenFrom: String, enrolmentOpenTo: String, maxEnrolments: Number, visibleInCustomerApp: Boolean, customerSelfEnrolAllowed: Boolean },
  status: enumField(SchemePlanStatus, { default: SchemePlanStatus.DRAFT }), version: versionField, createdBy: String,
}, baseOptions);
schemePlanSchema.index({ tenantId: 1, code: 1 }, { unique: true }); schemePlanSchema.index({ tenantId: 1, status: 1, createdAt: -1 });

const installmentSchema = new mongoose.Schema({ number: Number, dueDate: String, amountPaise: integerField(), paidPaise: integerField(), status: enumField(InstallmentStatus), graceEndsAt: String }, { _id: false });
const cycleSchema = new mongoose.Schema({ cycle: String, capPaise: integerField(), paidPaise: integerField(), remainingPaise: integerField(), status: enumField(CycleStatus), expiresAt: String }, { _id: false });
const schemeSchema = new mongoose.Schema({
  _id: stringId("sch"), tenantId: tenantField, branchId: branchField, customerId: { type: String, required: true, index: true }, planId: { type: String, required: true, index: true }, enrollmentNumber: { type: String, required: true },
  planSnapshot: { type: mongoose.Schema.Types.Mixed, required: true }, valueBasis: enumField(ValueBasis, { required: true }), paymentPattern: enumField(PaymentPattern, { required: true }), status: enumField(SchemeStatus, { default: SchemeStatus.ACTIVE }),
  startDate: { type: String, required: true }, maturityDate: { type: String, required: true }, installmentAmountPaise: integerField(), installments: { type: [installmentSchema], default: [] }, cycles: { type: [cycleSchema], default: [] },
  flexiblePhase: enumField(FlexiblePhase), lockedAveragePaise: integerField(), lockedAt: Date,
  closureReason: String, closedAt: Date, settlementRequired: { type: Boolean, default: false },
  settlementPrincipalPaise: integerField(), settlementCompletedAt: Date,
  postSettlementRefundedPaise: integerField(),
  postSettlementRefundedWeightMg: integerField(),
  positionVersion: integerField({ default: 0, min: 0 }), ledgerNextSequence: integerField({ default: 0, min: 0 }), version: versionField, createdBy: String,
}, baseOptions);
schemeSchema.index({ tenantId: 1, enrollmentNumber: 1 }, { unique: true }); schemeSchema.index({ tenantId: 1, branchId: 1, status: 1, maturityDate: 1 }); schemeSchema.index({ tenantId: 1, branchId: 1, createdAt: -1 });
schemeSchema.index({ tenantId: 1, paymentPattern: 1, status: 1, _id: 1 });
schemeSchema.index({ tenantId: 1, paymentPattern: 1, flexiblePhase: 1, status: 1, _id: 1 });
schemeSchema.index({ status: 1, maturityDate: 1, _id: 1 });
schemeSchema.index({ status: 1, paymentPattern: 1, _id: 1 });
schemeSchema.index({ status: 1, paymentPattern: 1, "installments.status": 1, _id: 1 });
schemeSchema.index({ paymentPattern: 1, "cycles.status": 1, _id: 1 });
schemeSchema.index({ paymentPattern: 1, flexiblePhase: 1, status: 1, _id: 1 });

const ledgerEntrySchema = new mongoose.Schema({
  _id: stringId("led"), tenantId: tenantField, branchId: branchField, schemeId: { type: String, required: true, index: true }, customerId: { type: String, required: true, index: true },
  paymentId: String, redemptionId: String, type: enumField(LedgerEntryType, { required: true }), sequence: integerField({ required: true, min: 1 }),
  amountPaise: integerField(), weightMg: integerField(), ratePerGramPaise: integerField(), cycle: String, installmentNumber: Number, description: String,
  actorType: enumField(AuditActorType), actorId: String, effectiveAt: { type: Date, default: Date.now, index: true }, reversalOf: String, metadata: mongoose.Schema.Types.Mixed,
}, baseOptions);
ledgerEntrySchema.index({ tenantId: 1, schemeId: 1, sequence: 1 }, { unique: true }); ledgerEntrySchema.index({ paymentId: 1, type: 1 }, { sparse: true });
ledgerEntrySchema.plugin(immutablePlugin);

export const SchemePlan = mongoose.model("SchemePlan", schemePlanSchema);
export const Scheme = mongoose.model("Scheme", schemeSchema);
export const LedgerEntry = mongoose.model("LedgerEntry", ledgerEntrySchema);
