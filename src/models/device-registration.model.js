import mongoose from "mongoose";
import {
  DevicePrincipalType,
  DeviceRegistrationStatus,
} from "../constants/enums.js";
import {
  baseOptions,
  enumField,
  stringId,
  tenantField,
  versionField,
} from "./schema-helpers.js";

const deviceRegistrationSchema = new mongoose.Schema(
  {
    _id: stringId("dvr"),
    tenantId: tenantField,
    principalType: enumField(DevicePrincipalType, { required: true }),
    principalId: { type: String, required: true, index: true },
    deviceId: { type: String, required: true },
    platform: String,
    tokenHash: { type: String, required: true },
    tokenSealed: { type: String, required: true, select: false },
    status: enumField(DeviceRegistrationStatus, {
      default: DeviceRegistrationStatus.ACTIVE,
    }),
    lastRegisteredAt: { type: Date, default: Date.now },
    lastSuccessAt: Date,
    lastFailureAt: Date,
    invalidatedAt: Date,
    invalidReason: String,
    version: versionField,
  },
  baseOptions,
);

deviceRegistrationSchema.index(
  { tenantId: 1, tokenHash: 1 },
  {
    unique: true,
    partialFilterExpression: { status: DeviceRegistrationStatus.ACTIVE },
  },
);
deviceRegistrationSchema.index(
  { tenantId: 1, principalType: 1, principalId: 1, deviceId: 1 },
  { unique: true },
);
deviceRegistrationSchema.index({
  tenantId: 1,
  principalType: 1,
  principalId: 1,
  status: 1,
  lastRegisteredAt: -1,
});

export const DeviceRegistration = mongoose.model(
  "DeviceRegistration",
  deviceRegistrationSchema,
);
