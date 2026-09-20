import { incrementOpsMetric, OpsMetric } from "./ops-metrics.js";
import { calendarDayYmd, REMINDER_PRODUCT_TIMEZONE } from "./reminder-timezone.js";
import { ReminderDailyQuota } from "../models/reminder-daily-quota.model.js";

export function reminderQuotaDocId({ tenantId, customerId, channel, dayYmd }) {
  return `${tenantId}:${customerId}:${channel}:${dayYmd}`;
}

export function tenantCalendarDayYmd(now = new Date(), timeZone = REMINDER_PRODUCT_TIMEZONE) {
  return calendarDayYmd(now, timeZone);
}

/**
 * Atomic daily cap claim. Quota is consumed only when this returns allowed:true.
 * Failed reminder claims must call releaseReminderDailyQuota if message insert did not occur.
 */
export async function tryClaimReminderDailyQuota({
  tenantId,
  customerId,
  channel,
  dayYmd,
  cap,
}) {
  if (!cap || cap <= 0) return { allowed: true, count: 0 };
  const _id = reminderQuotaDocId({ tenantId, customerId, channel, dayYmd });
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await ReminderDailyQuota.updateOne(
        { _id },
        { $setOnInsert: { tenantId, customerId, channel, dayYmd, count: 0 } },
        { upsert: true },
      );
      const row = await ReminderDailyQuota.findOneAndUpdate(
        { _id, count: { $lt: cap } },
        { $inc: { count: 1 } },
        { new: true },
      );
      if (row && row.count <= cap) {
        return { allowed: true, count: row.count };
      }
      incrementOpsMetric(OpsMetric.REMINDER_QUOTA_DENIED, 1);
      return { allowed: false, count: cap };
    } catch (error) {
      if (error?.code === 11000 && attempt < 5) continue;
      throw error;
    }
  }
  incrementOpsMetric(OpsMetric.REMINDER_QUOTA_DENIED, 1);
  return { allowed: false, count: cap };
}

export async function releaseReminderDailyQuota({
  tenantId,
  customerId,
  channel,
  dayYmd,
}) {
  const _id = reminderQuotaDocId({ tenantId, customerId, channel, dayYmd });
  await ReminderDailyQuota.updateOne({ _id, count: { $gt: 0 } }, { $inc: { count: -1 } });
}
