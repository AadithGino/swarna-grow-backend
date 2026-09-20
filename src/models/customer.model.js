import mongoose from "mongoose";
import {
  CustomerStatus,
  KycStatus,
  KycType,
  NomineeRelationship,
} from "../constants/enums.js";
import {
  baseOptions,
  branchField,
  enumField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

const kycSchema = new mongoose.Schema(
  {
    type: enumField(KycType),
    status: enumField(KycStatus, { default: KycStatus.NOT_SUBMITTED }),
    numberMasked: String,
    frontUploadId: String,
    backUploadId: String,
    submittedAt: Date,
    verifiedAt: Date,
    verifiedBy: String,
    rejectionReason: String,
  },
  { _id: false },
);
const nomineeSchema = new mongoose.Schema(
  {
    name: { type: String, required: true },
    relationship: enumField(NomineeRelationship, { required: true }),
    mobile: String,
    address: String,
  },
  { _id: false },
);
const customerSchema = new mongoose.Schema(
  {
    _id: stringId("cus"),
    tenantId: tenantField,
    branchId: branchField,
    customerNumber: { type: String, required: true },
    passbookNumber: String,
    name: { type: String, required: true, trim: true },
    mobile: { type: String, required: true },
    email: String,
    address: String,
    passwordHash: { type: String, select: false },
    mustSetPassword: { type: Boolean, default: false },
    passwordSetAt: Date,
    status: enumField(CustomerStatus, { default: CustomerStatus.ACTIVE }),
    kyc: { type: kycSchema, default: () => ({}) },
    nominee: { type: nomineeSchema, default: null },
    fcmTokens: {
      type: [
        {
          tokenHash: String,
          tokenSealed: { type: String, select: false },
          deviceId: String,
          platform: String,
          updatedAt: Date,
        },
      ],
      select: false,
      default: [],
    },
    whatsappOptedOutAt: Date,
    profileCompletedAt: Date,
    createdBy: String,
    securityVersion: { type: Number, default: 0, validate: { validator: (value) => value == null || Number.isSafeInteger(value), message: "{PATH} must be a safe integer" } },
    /** Internal mutex for one-active-scheme enrolment — not customer profile version. */
    enrolmentSerializationVersion: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: (value) => value == null || Number.isSafeInteger(value),
        message: "{PATH} must be a safe integer",
      },
    },
    version: versionField,
  },
  baseOptions,
);
customerSchema.index({ tenantId: 1, mobile: 1 }, { unique: true });
customerSchema.index(
  { tenantId: 1, branchId: 1, status: 1 },
  { partialFilterExpression: { "fcmTokens.0": { $exists: true } } },
);
customerSchema.index({ tenantId: 1, customerNumber: 1 }, { unique: true });
customerSchema.index(
  { tenantId: 1, passbookNumber: 1 },
  {
    unique: true,
    partialFilterExpression: {
      passbookNumber: { $exists: true, $type: "string", $gt: "" },
    },
  },
);
customerSchema.index({ tenantId: 1, branchId: 1, status: 1, createdAt: -1 });
customerSchema.index({
  tenantId: 1,
  name: "text",
  mobile: "text",
  customerNumber: "text",
});
export const Customer = mongoose.model("Customer", customerSchema);
