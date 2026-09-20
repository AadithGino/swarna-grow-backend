import mongoose from "mongoose";
import { PushDeviceDeliveryStatus } from "../constants/enums.js";
import {
  baseOptions,
  enumField,
  integerField,
  stringId,
  tenantField,
} from "./schema-helpers.js";

const pushDeviceDeliverySchema = new mongoose.Schema(
  {
    _id: stringId("pdd"),
    tenantId: tenantField,
    messageId: { type: String, required: true, index: true },
    deviceRegistrationId: { type: String, required: true },
    status: enumField(PushDeviceDeliveryStatus, {
      default: PushDeviceDeliveryStatus.QUEUED,
    }),
    providerMessageId: String,
    attemptCount: integerField({ min: 0 }),
    lastErrorKind: String,
    lastErrorCode: String,
    lastAttemptAt: Date,
    succeededAt: Date,
    deadLetteredAt: Date,
    claimToken: String,
    claimExpiresAt: Date,
  },
  baseOptions,
);

pushDeviceDeliverySchema.index(
  { tenantId: 1, messageId: 1, deviceRegistrationId: 1 },
  { unique: true },
);
pushDeviceDeliverySchema.index({ tenantId: 1, status: 1, claimExpiresAt: 1 });
pushDeviceDeliverySchema.index({ status: 1, claimExpiresAt: 1 });
pushDeviceDeliverySchema.index({ tenantId: 1, status: 1, lastAttemptAt: 1 });

export const PushDeviceDelivery = mongoose.model(
  "PushDeviceDelivery",
  pushDeviceDeliverySchema,
);
