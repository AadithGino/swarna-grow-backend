import { JobStatus } from "../constants/enums.js";
import { PushDeviceDeliveryStatus } from "../constants/enums.js";

/** @typedef {{ queued: number, processingActive: number, processingExpired: number, retryableFailed: number, succeeded: number, permanentFailed: number, deadLetter: number, totalRows: number, expectedDevices: number }} CampaignDeliveryCounts */

/**
 * Pure campaign-scoped delivery verdict for staging gates.
 * @param {object} input
 * @param {number} input.requestedUniqueCustomers
 * @param {number} input.discoveredUniqueCustomers
 * @param {number} input.logicalMessages
 * @param {number} input.duplicateLogicalMessages
 * @param {number} input.missingLogicalMessages
 * @param {CampaignDeliveryCounts} input.deliveries
 * @param {string} input.campaignStatus
 */
export function evaluateStagingCampaignVerdict(input) {
  const errors = [];
  if (input.campaignStatus !== JobStatus.COMPLETED) {
    errors.push("CAMPAIGN_NOT_COMPLETED");
  }
  if (input.discoveredUniqueCustomers !== input.requestedUniqueCustomers) {
    errors.push("CUSTOMER_COUNT_MISMATCH");
  }
  if (input.logicalMessages !== input.requestedUniqueCustomers) {
    errors.push("LOGICAL_MESSAGE_COUNT_MISMATCH");
  }
  if (input.duplicateLogicalMessages > 0) errors.push("DUPLICATE_LOGICAL_MESSAGES");
  if (input.missingLogicalMessages > 0) errors.push("MISSING_LOGICAL_MESSAGES");
  const d = input.deliveries;
  if (d.totalRows !== d.expectedDevices) errors.push("DELIVERY_ROW_COUNT_MISMATCH");
  if ((d.missingDeliveryRows ?? 0) > 0) errors.push("MISSING_DELIVERY_ROWS");
  if (d.queued > 0) errors.push("DELIVERIES_QUEUED");
  if (d.processingActive > 0) errors.push("DELIVERIES_PROCESSING");
  if (d.retryableFailed > 0) errors.push("DELIVERIES_RETRYABLE");
  if (d.permanentFailed > 0) errors.push("DELIVERIES_PERMANENT_FAILED");
  if (d.deadLetter > 0) errors.push("DELIVERIES_DEAD_LETTER");
  if (d.succeeded !== d.expectedDevices) errors.push("DELIVERIES_NOT_ALL_SUCCEEDED");
  return {
    ok: errors.length === 0,
    errors,
    exitCode: errors.length === 0 ? 0 : 1,
  };
}

export function aggregateDeliveryStatusRows(rows) {
  const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
  return {
    queued: Number(byStatus[PushDeviceDeliveryStatus.QUEUED] ?? 0),
    retryableFailed: Number(byStatus[PushDeviceDeliveryStatus.RETRYABLE_FAILED] ?? 0),
    succeeded: Number(byStatus[PushDeviceDeliveryStatus.SUCCEEDED] ?? 0),
    permanentFailed: Number(byStatus[PushDeviceDeliveryStatus.PERMANENT_FAILED] ?? 0),
    deadLetter: Number(byStatus[PushDeviceDeliveryStatus.DEAD_LETTER] ?? 0),
    processing: Number(byStatus[PushDeviceDeliveryStatus.PROCESSING] ?? 0),
  };
}

export function redactStagingReport(report) {
  const blob = JSON.stringify(report);
  const forbidden = [
    /fcm[_-]?token/i,
    /Bearer\s+/,
    /private_key/,
    /client_email/,
    /\+91\d{10}/,
  ];
  for (const pattern of forbidden) {
    if (pattern.test(blob)) return { ...report, redactionFailed: true };
  }
  return report;
}
