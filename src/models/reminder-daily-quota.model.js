import mongoose from "mongoose";
import { MessageChannel } from "../constants/enums.js";
import { baseOptions, enumField, integerField, tenantField } from "./schema-helpers.js";

const reminderDailyQuotaSchema = new mongoose.Schema(
  {
    _id: { type: String, required: true },
    tenantId: tenantField,
    customerId: { type: String, required: true, index: true },
    channel: enumField(MessageChannel, { required: true }),
    /** Calendar day in tenant timezone (YYYY-MM-DD). */
    dayYmd: { type: String, required: true, index: true },
    count: integerField({ min: 0 }),
  },
  baseOptions,
);

reminderDailyQuotaSchema.index(
  { tenantId: 1, customerId: 1, channel: 1, dayYmd: 1 },
  { unique: true },
);

export const ReminderDailyQuota = mongoose.model(
  "ReminderDailyQuota",
  reminderDailyQuotaSchema,
);
