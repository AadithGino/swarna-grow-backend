import { AlertSeverity, AlertStatus, AlertType, isEnumValue } from "../constants/enums.js";
import { Alert } from "../models/index.js";

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

/** Idempotent open operational alert (schema-validated). */
export async function upsertOperationalAlert({
  tenantId,
  type,
  entityId,
  title,
  message,
  severity = AlertSeverity.CRITICAL,
  entityType = "WEBHOOK",
  metadata,
  session = null,
}) {
  if (!isEnumValue(AlertType, type)) {
    throw new TypeError(`Unknown AlertType: ${type}`);
  }
  try {
    await Alert.findOneAndUpdate(
      { tenantId, type, entityId, status: AlertStatus.OPEN },
      {
        $setOnInsert: {
          severity,
          title,
          message,
          entityType,
          metadata,
        },
      },
      { upsert: true, runValidators: true, ...(session ? { session } : {}) },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}

export async function resolveOperationalAlert({
  tenantId,
  type,
  entityId,
  session = null,
}) {
  if (!isEnumValue(AlertType, type)) {
    throw new TypeError(`Unknown AlertType: ${type}`);
  }
  await Alert.updateOne(
    { tenantId, type, entityId, status: AlertStatus.OPEN },
    { $set: { status: AlertStatus.RESOLVED, resolvedAt: new Date() } },
    session ? { session } : {},
  );
}

export async function reopenOperationalAlert({
  tenantId,
  type,
  entityId,
  title,
  message,
  metadata,
  session = null,
}) {
  if (!isEnumValue(AlertType, type)) {
    throw new TypeError(`Unknown AlertType: ${type}`);
  }
  try {
    await Alert.findOneAndUpdate(
      { tenantId, type, entityId },
      {
        $set: {
          status: AlertStatus.OPEN,
          title: title ?? "Operational alert reopened",
          message: message ?? "",
          metadata,
          resolvedAt: null,
        },
      },
      { upsert: true, runValidators: true, ...(session ? { session } : {}) },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
  }
}
