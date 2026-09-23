import dayjs from "dayjs";
import { MessageType, SchemeStatus } from "../constants/enums.js";
import { env } from "../config/env.js";
import { addMonthsClamped } from "../lib/date.js";
import { evaluateReminderChannels } from "../lib/reminder-channel-eligibility.js";
import {
  getReminderConfig,
  isWithinSendWindow,
} from "../lib/reminder-config.js";
import {
  acquireReminderSchedulerLease,
  releaseReminderSchedulerLease,
} from "../lib/reminder-scheduler-lease.js";
import { Customer, Payment, Scheme, Tenant } from "../models/index.js";
import { installmentRemainingPaise } from "./admin-summary.service.js";
import {
  attachPaymentLinkToMessage,
  claimReminderMessage,
} from "./reminder-message.service.js";
import {
  incrementOpsMetric,
  OpsMetric,
  recordReminderSchedulerRun,
} from "../lib/ops-metrics.js";
import {
  releaseReminderDailyQuota,
  tryClaimReminderDailyQuota,
} from "../lib/reminder-daily-quota.js";
import { ReminderDailyQuota } from "../models/index.js";
import { calendarDayYmd, resolveReminderTimezone } from "../lib/reminder-timezone.js";
import {
  emptyTenantReminderStats,
  mergeTenantReminderStats,
  runBoundedSchemeStream,
} from "../lib/reminder-scheme-runner.js";
import { ReminderStream } from "../lib/reminder-stream-cursor.js";
import * as payments from "./payment.service.js";

function ymdAddDays(ymd, days) {
  return dayjs(`${ymd}T12:00:00+05:30`).add(days, "day").format("YYYY-MM-DD");
}

function maxSchemesPerTenantPerRun() {
  return env.REMINDER_MAX_SCHEMES_PER_TENANT_PER_RUN ?? 500;
}

function tenantBatchSize() {
  return env.REMINDER_TENANT_BATCH_SIZE ?? 50;
}

function maxTenantBatchesPerRun() {
  return env.REMINDER_SCHEDULER_MAX_TENANT_BATCHES_PER_RUN ?? 20;
}

function channelDailyCap(config, channel) {
  if (channel === "PUSH") {
    const cap = config.maxPushPerCustomerPerDay ?? 3;
    return cap > 0 ? cap : Number.MAX_SAFE_INTEGER;
  }
  const cap = config.maxWhatsAppPerCustomerPerDay ?? 0;
  return cap > 0 ? cap : Number.MAX_SAFE_INTEGER;
}

async function quotaCountsForCustomers({ tenantId, customerIds, channel, dayYmd }) {
  if (!customerIds.length) return new Map();
  const rows = await ReminderDailyQuota.find({
    tenantId,
    customerId: { $in: customerIds },
    channel,
    dayYmd,
  })
    .select("customerId count")
    .lean();
  return new Map(rows.map((row) => [row.customerId, row.count ?? 0]));
}

async function claimReminderWithDailyQuota({
  config,
  dayYmd,
  channel,
  pushCounts,
  whatsAppCounts,
  claimArgs,
}) {
  const cap = channelDailyCap(config, channel);
  const memoryMap = channel === "PUSH" ? pushCounts : whatsAppCounts;
  const used = memoryMap.get(claimArgs.customerId) ?? 0;
  if (used >= cap) return null;

  const quota = await tryClaimReminderDailyQuota({
    tenantId: claimArgs.tenantId,
    customerId: claimArgs.customerId,
    channel,
    dayYmd,
    cap,
  });
  if (!quota.allowed) return null;

  const messageId = await claimReminderMessage({ ...claimArgs, channel });
  if (!messageId) {
    await releaseReminderDailyQuota({
      tenantId: claimArgs.tenantId,
      customerId: claimArgs.customerId,
      channel,
      dayYmd,
    });
    return null;
  }
  memoryMap.set(claimArgs.customerId, used + 1);
  return messageId;
}

function sendWindowKey(config) {
  const sw = config.sendWindow ?? {};
  return `${sw.startTime ?? "09:00"}-${sw.endTime ?? "20:00"}`;
}

async function loadCustomersById(tenantId, customerIds) {
  if (!customerIds.length) return new Map();
  const rows = await Customer.find({ tenantId, _id: { $in: customerIds } })
    .select("mobile whatsappOptedOutAt")
    .lean();
  return new Map(rows.map((row) => [row._id, row]));
}

async function latestPaymentsByScheme(tenantId, schemeIds) {
  if (!schemeIds.length) return new Map();
  const rows = await Payment.aggregate([
    {
      $match: {
        tenantId,
        schemeId: { $in: schemeIds },
        status: "SUCCESS",
      },
    },
    { $sort: { paidAt: -1 } },
    {
      $group: {
        _id: "$schemeId",
        paidAt: { $first: "$paidAt" },
      },
    },
  ]);
  return new Map(rows.map((row) => [row._id, row.paidAt]));
}

function systemPaymentLinkReq(scheme) {
  return {
    auth: { id: "reminder-worker", tenantId: scheme.tenantId, type: "SYSTEM" },
    scope: { tenantId: scheme.tenantId, branchId: scheme.branchId },
    headers: {},
    ip: "worker",
    body: {},
  };
}

async function queueFixedOffsetReminder({
  config,
  scheme,
  customer,
  installment,
  offset,
  today,
  pushCountToday,
  pushCounts,
  whatsAppCounts,
}) {
  if (offset.schemePattern && offset.schemePattern !== "FIXED") return 0;
  if (["PAID", "WAIVED"].includes(installment.status)) return 0;
  if (ymdAddDays(installment.dueDate, offset.days) !== today) return 0;

  const type =
    offset.messageType
    ?? (offset.days > 0 ? MessageType.PAYMENT_OVERDUE : MessageType.PAYMENT_DUE);
  const pushOnly = offset.pushOnly === true;
  const { whatsapp, push } = evaluateReminderChannels({
    config,
    customer,
    type,
    templateParams: { pushKind: offset.key },
    pushOnly,
    pushCountToday,
    whatsAppCountToday: whatsAppCounts?.get(scheme.customerId) ?? 0,
  });
  if (!whatsapp && !push) return 0;

  const baseParams = {
    mobile: customer.mobile,
    enrollmentNumber: scheme.enrollmentNumber,
    pushKind: offset.key,
  };
  let queued = 0;
  let whatsappMessageId = null;
  const claimBase = {
    tenantId: scheme.tenantId,
    branchId: scheme.branchId,
    customerId: scheme.customerId,
    schemeId: scheme._id,
    type,
    offsetKey: offset.key,
    reminderDate: today,
    installmentNumber: installment.number,
    templateParams: baseParams,
  };

  if (whatsapp) {
    whatsappMessageId = await claimReminderWithDailyQuota({
      config,
      dayYmd: today,
      channel: "WHATSAPP",
      pushCounts,
      whatsAppCounts,
      claimArgs: claimBase,
    });
    if (whatsappMessageId) queued += 1;
  }
  if (push) {
    const pushId = await claimReminderWithDailyQuota({
      config,
      dayYmd: today,
      channel: "PUSH",
      pushCounts,
      whatsAppCounts,
      claimArgs: claimBase,
    });
    if (pushId) queued += 1;
  }

  if (
    whatsappMessageId
    && config.attachPaymentLink !== false
  ) {
    const remaining = installmentRemainingPaise(installment);
    if (remaining > 0) {
      const link = await payments.createPaymentLink({
        ...systemPaymentLinkReq(scheme),
        body: { schemeId: scheme._id, amountPaise: remaining },
      });
      await attachPaymentLinkToMessage(whatsappMessageId, link.token);
    }
  }
  return queued;
}

async function runFixedReminders({ tenant, config, today, lease, budget, onBatch }) {
  const enabledOffsets = config.offsets.filter(
    (row) => row.enabled !== false
      && row.schemePattern !== "FLEXIBLE"
      && !String(row.key).startsWith("MATURITY_")
      && !String(row.key).startsWith("LOCK_")
      && row.key !== "FLEX_NUDGE",
  );
  if (!enabledOffsets.length) return emptyTenantReminderStats();

  const dueDates = [...new Set(enabledOffsets.map((row) => ymdAddDays(today, -row.days)))];
  const statusFilter = {
    $in: [SchemeStatus.ACTIVE, SchemeStatus.DEFAULTED, SchemeStatus.LOCKED],
  };
  const windowKey = sendWindowKey(config);

  return runBoundedSchemeStream({
    stream: ReminderStream.FIXED,
    tenantId: tenant._id,
    today,
    windowKey,
    leaseToken: lease.token,
    budget,
    fetchBatch: async (cursor, limit) => {
      const query = {
        tenantId: tenant._id,
        paymentPattern: "FIXED",
        status: statusFilter,
        installments: {
          $elemMatch: {
            dueDate: { $in: dueDates },
            status: { $nin: ["PAID", "WAIVED"] },
          },
        },
      };
      if (cursor) query._id = { $gt: cursor };
      return Scheme.find(query)
        .select("_id customerId branchId enrollmentNumber installments")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
    },
    processBatch: async (schemes) => {
      onBatch?.({ schemesVisited: schemes.length, schemeIds: schemes.map((row) => row._id) });
      let queued = 0;
      let skipped = 0;
      const customerIds = [...new Set(schemes.map((row) => row.customerId))];
      const [customersById, pushCounts, whatsAppCounts] = await Promise.all([
        loadCustomersById(tenant._id, customerIds),
        quotaCountsForCustomers({
          tenantId: tenant._id,
          customerIds,
          channel: "PUSH",
          dayYmd: today,
        }),
        quotaCountsForCustomers({
          tenantId: tenant._id,
          customerIds,
          channel: "WHATSAPP",
          dayYmd: today,
        }),
      ]);
      for (const scheme of schemes) {
        const customer = customersById.get(scheme.customerId);
        if (!customer) {
          skipped += 1;
          continue;
        }
        const pushCountToday = pushCounts.get(scheme.customerId) ?? 0;
        for (const installment of scheme.installments ?? []) {
          for (const offset of enabledOffsets) {
            queued += await queueFixedOffsetReminder({
              config,
              scheme,
              customer,
              installment,
              offset,
              today,
              pushCountToday,
              pushCounts,
              whatsAppCounts,
            });
          }
        }
      }
      return { queued, skipped };
    },
  });
}

async function runFlexibleNudges({ tenant, config, today, lease, budget }) {
  const offset = config.offsets.find((row) => row.key === "FLEX_NUDGE" && row.enabled !== false);
  if (!offset || config.push?.flexibleNudge === false) return emptyTenantReminderStats();
  const inactiveDays = config.flexibleNudgeInactiveDays ?? 7;
  const windowKey = sendWindowKey(config);

  return runBoundedSchemeStream({
    stream: ReminderStream.FLEX_NUDGE,
    tenantId: tenant._id,
    today,
    windowKey,
    leaseToken: lease.token,
    budget,
    fetchBatch: async (cursor, limit) => {
      const query = {
        tenantId: tenant._id,
        paymentPattern: "FLEXIBLE",
        flexiblePhase: "FLEXIBLE",
        status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED] },
      };
      if (cursor) query._id = { $gt: cursor };
      return Scheme.find(query)
        .select("_id customerId branchId enrollmentNumber startDate")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
    },
    processBatch: async (schemes) => {
      let queued = 0;
      let skipped = 0;
      const customerIds = [...new Set(schemes.map((row) => row.customerId))];
      const schemeIds = schemes.map((row) => row._id);
      const [customersById, lastPaidByScheme, pushCounts] = await Promise.all([
        loadCustomersById(tenant._id, customerIds),
        latestPaymentsByScheme(tenant._id, schemeIds),
        quotaCountsForCustomers({
          tenantId: tenant._id,
          customerIds,
          channel: "PUSH",
          dayYmd: today,
        }),
      ]);
      for (const scheme of schemes) {
        const customer = customersById.get(scheme.customerId);
        if (!customer) {
          skipped += 1;
          continue;
        }
        const lastAt = lastPaidByScheme.get(scheme._id) ?? scheme.startDate;
        const daysSince = dayjs(today).diff(dayjs(lastAt).format("YYYY-MM-DD"), "day");
        if (daysSince < inactiveDays) {
          skipped += 1;
          continue;
        }
        const { push } = evaluateReminderChannels({
          config,
          customer,
          type: MessageType.PAYMENT_DUE,
          templateParams: { pushKind: "FLEX_NUDGE" },
          pushOnly: true,
          pushCountToday: pushCounts.get(scheme.customerId) ?? 0,
        });
        if (!push) {
          skipped += 1;
          continue;
        }
        const claimed = await claimReminderWithDailyQuota({
          config,
          dayYmd: today,
          channel: "PUSH",
          pushCounts,
          whatsAppCounts: new Map(),
          claimArgs: {
            tenantId: scheme.tenantId,
            branchId: scheme.branchId,
            customerId: scheme.customerId,
            schemeId: scheme._id,
            type: MessageType.PAYMENT_DUE,
            offsetKey: "FLEX_NUDGE",
            reminderDate: today,
            templateParams: {
              mobile: customer.mobile,
              enrollmentNumber: scheme.enrollmentNumber,
              pushKind: "FLEX_NUDGE",
            },
          },
        });
        if (claimed) queued += 1;
      }
      return { queued, skipped };
    },
  });
}

async function runMaturityReminders({ tenant, config, today, lease, budget }) {
  const offsets = config.offsets.filter(
    (row) => row.key.startsWith("MATURITY_") && row.enabled !== false,
  );
  if (!offsets.length) return emptyTenantReminderStats();
  const maturityDates = [...new Set(offsets.map((row) => ymdAddDays(today, -row.days)))];
  const windowKey = sendWindowKey(config);

  return runBoundedSchemeStream({
    stream: ReminderStream.MATURITY,
    tenantId: tenant._id,
    today,
    windowKey,
    leaseToken: lease.token,
    budget,
    fetchBatch: async (cursor, limit) => {
      const query = {
        tenantId: tenant._id,
        status: { $in: [SchemeStatus.ACTIVE, SchemeStatus.LOCKED, SchemeStatus.DEFAULTED] },
        maturityDate: { $in: maturityDates },
      };
      if (cursor) query._id = { $gt: cursor };
      return Scheme.find(query)
        .select(
          "_id customerId branchId enrollmentNumber maturityDate paymentPattern planSnapshot installments cycles",
        )
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
    },
    processBatch: async (schemes) => {
      let queued = 0;
      let skipped = 0;
      const customerIds = [...new Set(schemes.map((row) => row.customerId))];
      const [customersById, pushCounts] = await Promise.all([
        loadCustomersById(tenant._id, customerIds),
        quotaCountsForCustomers({
          tenantId: tenant._id,
          customerIds,
          channel: "PUSH",
          dayYmd: today,
        }),
      ]);
      const { assessMaturityContributionEligibility } = await import("../lib/maturity-eligibility.js");
      for (const scheme of schemes) {
        const customer = customersById.get(scheme.customerId);
        if (!customer) {
          skipped += 1;
          continue;
        }
        if (!assessMaturityContributionEligibility(scheme).paymentEligible) {
          skipped += 1;
          continue;
        }
        const pushCountToday = pushCounts.get(scheme.customerId) ?? 0;
        for (const offset of offsets) {
          if (ymdAddDays(scheme.maturityDate, offset.days) !== today) continue;
          const { push } = evaluateReminderChannels({
            config,
            customer,
            type: MessageType.SCHEME_MATURED,
            templateParams: { pushKind: offset.key },
            pushOnly: true,
            pushCountToday,
          });
          if (!push) {
            skipped += 1;
            continue;
          }
          const claimed = await claimReminderWithDailyQuota({
            config,
            dayYmd: today,
            channel: "PUSH",
            pushCounts,
            whatsAppCounts: new Map(),
            claimArgs: {
              tenantId: scheme.tenantId,
              branchId: scheme.branchId,
              customerId: scheme.customerId,
              schemeId: scheme._id,
              type: MessageType.SCHEME_MATURED,
              offsetKey: offset.key,
              reminderDate: today,
              templateParams: {
                mobile: customer.mobile,
                enrollmentNumber: scheme.enrollmentNumber,
              },
            },
          });
          if (claimed) queued += 1;
        }
      }
      return { queued, skipped };
    },
  });
}

async function runFlexibleLockReminders({ tenant, config, today, lease, budget }) {
  const offsets = config.offsets.filter(
    (row) => row.key.startsWith("LOCK_") && row.enabled !== false,
  );
  if (!offsets.length) return emptyTenantReminderStats();
  const windowKey = sendWindowKey(config);

  return runBoundedSchemeStream({
    stream: ReminderStream.FLEX_LOCK,
    tenantId: tenant._id,
    today,
    windowKey,
    leaseToken: lease.token,
    budget,
    fetchBatch: async (cursor, limit) => {
      const query = {
        tenantId: tenant._id,
        paymentPattern: "FLEXIBLE",
        flexiblePhase: "FLEXIBLE",
        status: SchemeStatus.ACTIVE,
      };
      if (cursor) query._id = { $gt: cursor };
      return Scheme.find(query)
        .select("_id customerId branchId enrollmentNumber startDate planSnapshot")
        .sort({ _id: 1 })
        .limit(limit)
        .lean();
    },
    processBatch: async (schemes) => {
      let queued = 0;
      let skipped = 0;
      const customerIds = [...new Set(schemes.map((row) => row.customerId))];
      const [customersById, pushCounts] = await Promise.all([
        loadCustomersById(tenant._id, customerIds),
        quotaCountsForCustomers({
          tenantId: tenant._id,
          customerIds,
          channel: "PUSH",
          dayYmd: today,
        }),
      ]);
      for (const scheme of schemes) {
        const customer = customersById.get(scheme.customerId);
        if (!customer) {
          skipped += 1;
          continue;
        }
        const pushCountToday = pushCounts.get(scheme.customerId) ?? 0;
        const freeCycles = scheme.planSnapshot?.flexibleRules?.flexiblePhaseCycles ?? 0;
        if (!freeCycles) {
          skipped += 1;
          continue;
        }
        const lockDate = addMonthsClamped(scheme.startDate, freeCycles).format("YYYY-MM-DD");
        for (const offset of offsets) {
          if (ymdAddDays(lockDate, offset.days) !== today) continue;
          const { push } = evaluateReminderChannels({
            config,
            customer,
            type: MessageType.FLEXI_LOCK_APPLIED,
            templateParams: { pushKind: offset.key },
            pushOnly: true,
            pushCountToday,
          });
          if (!push) {
            skipped += 1;
            continue;
          }
          const claimed = await claimReminderWithDailyQuota({
            config,
            dayYmd: today,
            channel: "PUSH",
            pushCounts,
            whatsAppCounts: new Map(),
            claimArgs: {
              tenantId: scheme.tenantId,
              branchId: scheme.branchId,
              customerId: scheme.customerId,
              schemeId: scheme._id,
              type: MessageType.FLEXI_LOCK_APPLIED,
              offsetKey: offset.key,
              reminderDate: today,
              templateParams: {
                mobile: customer.mobile,
                enrollmentNumber: scheme.enrollmentNumber,
                lockDate,
              },
            },
          });
          if (claimed) queued += 1;
        }
      }
      return { queued, skipped };
    },
  });
}

async function runTenantReminders({ tenant, now, hooks = {} }) {
  const config = getReminderConfig(tenant);
  const today = calendarDayYmd(now, resolveReminderTimezone(tenant));
  const empty = emptyTenantReminderStats();
  if (config.enabled === false) return empty;
  if (!isWithinSendWindow(config.sendWindow, now)) return empty;

  const windowKey = sendWindowKey(config);
  const token = await acquireReminderSchedulerLease({
    tenantId: tenant._id,
    today,
    windowKey,
  });
  if (!token) {
    incrementOpsMetric(OpsMetric.REMINDER_LEASE_CONTENTION);
    return empty;
  }

  const lease = { token };
  const budget = { schemesLeft: maxSchemesPerTenantPerRun() };
  const agg = emptyTenantReminderStats();
  try {
    const streams = [
      () => runFixedReminders({
        tenant,
        config,
        today,
        lease,
        budget,
        onBatch: hooks.onSchemeBatch,
      }),
      () => runFlexibleNudges({ tenant, config, today, lease, budget }),
      () => runFlexibleLockReminders({ tenant, config, today, lease, budget }),
      () => runMaturityReminders({ tenant, config, today, lease, budget }),
    ];
    for (const runStream of streams) {
      if (agg.leaseLost || budget.schemesLeft <= 0) break;
      mergeTenantReminderStats(agg, await runStream());
      if (agg.leaseLost) break;
    }
  } finally {
    await releaseReminderSchedulerLease({
      tenantId: tenant._id,
      today,
      windowKey,
      token,
    });
  }
  return agg;
}

export async function runReminderScheduler(now = new Date(), hooks = {}) {
  const started = Date.now();
  const summary = {
    tenantsProcessed: 0,
    messagesQueued: 0,
    schemesVisited: 0,
    processed: 0,
    skipped: 0,
    conflicted: 0,
    failed: 0,
    remainingBacklog: 0,
    continuationScheduled: 0,
    leaseLost: 0,
  };
  let cursor = null;

  for (let batchIdx = 0; batchIdx < maxTenantBatchesPerRun(); batchIdx += 1) {
    const query = { status: "ACTIVE" };
    if (cursor) query._id = { $gt: cursor };
    const tenants = await Tenant.find(query)
      .select("_id settings version")
      .sort({ _id: 1 })
      .limit(tenantBatchSize())
      .lean();
    if (!tenants.length) break;

    for (const tenant of tenants) {
      const result = await runTenantReminders({
        tenant,
        now,
        hooks: { onSchemeBatch: hooks.onSchemeBatch },
      });
      summary.messagesQueued += result.queued ?? 0;
      summary.schemesVisited += result.schemesVisited ?? 0;
      summary.processed += result.schemesVisited ?? 0;
      summary.skipped += result.skipped ?? 0;
      summary.continuationScheduled += result.continuationScheduled ?? 0;
      if (result.hasMore) summary.remainingBacklog += 1;
      if (result.leaseLost) summary.leaseLost += 1;
      summary.tenantsProcessed += 1;
    }

    cursor = tenants[tenants.length - 1]._id;
    if (tenants.length < tenantBatchSize()) break;
  }

  summary.durationMs = Date.now() - started;
  recordReminderSchedulerRun(summary);
  return summary;
}
