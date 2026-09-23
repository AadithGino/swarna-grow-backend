import { AlertSeverity, AlertStatus, AlertType, isEnumValue } from "../constants/enums.js";
import { Alert } from "../models/index.js";

function isDuplicateKeyError(error) {
  return error?.code === 11000;
}

async function updateOpenOperationalAlert(filter, fields, session = null) {
  return Alert.findOneAndUpdate(
    { ...filter, status: AlertStatus.OPEN },
    { $set: fields },
    { new: true, runValidators: true, ...(session ? { session } : {}) },
  );
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
  const base = { tenantId, type, entityId };
  const fields = { severity, title, message, entityType, metadata };
  try {
    await Alert.findOneAndUpdate(
      { ...base, status: AlertStatus.OPEN },
      {
        $set: fields,
        $setOnInsert: { status: AlertStatus.OPEN },
      },
      {
        upsert: true,
        runValidators: true,
        ...(session ? { session } : {}),
      },
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    await updateOpenOperationalAlert(base, fields, session);
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
  const base = { tenantId, type, entityId };
  const fields = {
    title: title ?? "Operational alert reopened",
    message: message ?? "",
    metadata,
    resolvedAt: null,
  };
  const updated = await updateOpenOperationalAlert(base, fields, session);
  if (updated) return;

  try {
    const createOpts = session ? { session } : undefined;
    await Alert.create(
      [{
        tenantId,
        type,
        entityId,
        status: AlertStatus.OPEN,
        severity: AlertSeverity.WARNING,
        ...fields,
      }],
      createOpts,
    );
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const open = await Alert.findOne({ ...base, status: AlertStatus.OPEN }).session(session ?? null);
    if (!open) {
      throw new Error("Operational alert duplicate key but no OPEN row found after concurrent reopen.");
    }
    await updateOpenOperationalAlert(base, fields, session);
  }
}
