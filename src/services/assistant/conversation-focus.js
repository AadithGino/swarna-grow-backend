/** @typedef {{ customerId?: string, customerName?: string, schemeId?: string, schemeLabel?: string }} ConversationFocus */

function normalizeFocus(raw) {
  if (!raw || typeof raw !== "object") return null;
  const customerId = raw.customerId ? String(raw.customerId) : undefined;
  const schemeId = raw.schemeId ? String(raw.schemeId) : undefined;
  if (!customerId && !schemeId) return null;
  return {
    customerId,
    customerName: raw.customerName ? String(raw.customerName) : undefined,
    schemeId,
    schemeLabel: raw.schemeLabel ? String(raw.schemeLabel) : undefined,
  };
}

export function focusFingerprint(focus) {
  const f = normalizeFocus(focus);
  if (!f) return "";
  return `focus:${f.customerId ?? ""}:${f.schemeId ?? ""}`;
}

export function customerFilter(focus) {
  const f = normalizeFocus(focus);
  if (!f?.customerId) return null;
  return { field: "customerId", op: "eq", value: f.customerId };
}

function mergeFilter(spec, filter) {
  if (!filter) return spec;
  const filters = [...(spec.filters ?? [])];
  const idx = filters.findIndex((row) => row.field === filter.field && row.op === filter.op);
  if (idx >= 0) filters[idx] = filter;
  else filters.push(filter);
  return { ...spec, filters };
}

export function refersToFocusedCustomer(question) {
  const q = String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!q) return false;
  if (/\b(that|this|the)\s+customer\b/.test(q)) return true;
  if (/\b(he|she|him|her|they|them|his|hers|their)\b/.test(q)) return true;
  return false;
}

export function isSchemeMembershipFollowUp(question) {
  const q = String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!q) return false;
  if (!/\b(scheme|plan|enrol+\w*|chit)\b/.test(q)) return false;
  return (
    /\bpart of\b/.test(q) ||
    /\bany scheme\b/.test(q) ||
    /\bon a scheme\b/.test(q) ||
    (refersToFocusedCustomer(question) && /\b(scheme|plan)\b/.test(q))
  );
}

export function isFocusedCustomerPaymentQuestion(question) {
  const q = String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!q) return false;
  if (/\b(we|our|us)\b/.test(q) && /\b(collect\w*|collection)\b/.test(q)) return false;
  const paymentWord = /\b(payment|paid|pay|collection|receipt|installment)\b/.test(q);
  if (!paymentWord) return false;
  if (/\b(most|highest|top|maximum|biggest|rank)\b/.test(q)) return false;
  if (refersToFocusedCustomer(question)) return true;
  if (/\bhow much\b/.test(q) && paymentWord && refersToFocusedCustomer(question)) return true;
  return false;
}

export function isFocusedCustomerLatestPaymentQuestion(question) {
  const q = String(question ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
  if (!q || !refersToFocusedCustomer(question)) return false;
  const paymentWord = /\b(payment|paid|pay|receipt|installment)\b/.test(q);
  if (!paymentWord) return false;
  if (/\bhow much\b/.test(q)) return false;
  return /\b(when|last|latest|most recent|newest)\b/.test(q);
}

/**
 * @param {ConversationFocus | null | undefined} focus
 * @param {string} question
 * @returns {import("../../validators/assistant.validators.js").assistantActionSchema extends infer T ? T : never | null}
 */
export function actionForConversationFocus(focus, question) {
  const f = normalizeFocus(focus);
  if (!f?.customerId) return null;
  const cf = customerFilter(f);
  if (!cf) return null;

  if (isSchemeMembershipFollowUp(question)) {
    return {
      kind: "query",
      spec: {
        entity: "schemes",
        filters: [cf],
        sort: "desc",
        limit: 20,
      },
    };
  }

  if (isFocusedCustomerLatestPaymentQuestion(question)) {
    return {
      kind: "query",
      spec: {
        entity: "collections",
        filters: [
          { field: "status", op: "eq", value: "SUCCESS" },
          cf,
        ],
        sort: "desc",
        limit: 1,
      },
    };
  }

  if (isFocusedCustomerPaymentQuestion(question)) {
    const q = String(question ?? "").toLowerCase();
    const period = /\blast month\b/.test(q) ? "LAST_MONTH" : /\bthis month\b/.test(q) ? "THIS_MONTH" : undefined;
    return {
      kind: "query",
      spec: {
        entity: "collections",
        filters: [
          { field: "status", op: "eq", value: "SUCCESS" },
          cf,
        ],
        ...(period ? { period } : { aggregate: { fn: "sum", field: "amountPaise" } }),
      },
    };
  }

  return null;
}

/**
 * @param {import("../../validators/assistant.validators.js").assistantActionSchema extends infer T ? T : never} action
 * @param {ConversationFocus | null | undefined} focus
 * @param {string} question
 */
export function applyConversationFocusToAction(action, focus, question) {
  const forced = actionForConversationFocus(focus, question);
  if (forced) return forced;
  const f = normalizeFocus(focus);
  if (!f?.customerId || !refersToFocusedCustomer(question)) return action;
  if (action?.kind !== "query") return action;

  const cf = customerFilter(f);
  const entity = action.spec?.entity;
  if (entity === "collections" || entity === "schemes") {
    return {
      ...action,
      spec: mergeFilter(action.spec, cf),
    };
  }
  return action;
}

function filterValue(spec, field) {
  return (spec?.filters ?? []).find((f) => f.field === field && f.op === "eq")?.value;
}

/**
 * @param {{ action?: object, bundle?: object }} turn
 * @param {ConversationFocus | null | undefined} prevFocus
 * @returns {ConversationFocus | null}
 */
export function deriveConversationFocusFromTurn({ action, bundle }, prevFocus = null) {
  const prev = normalizeFocus(prevFocus);
  const spec = action?.kind === "query" ? action.spec : null;
  const entity = spec?.entity;

  const customerFromFilter = filterValue(spec, "customerId");
  if (customerFromFilter) {
    return {
      customerId: String(customerFromFilter),
      customerName: prev?.customerId === String(customerFromFilter) ? prev.customerName : undefined,
      schemeId: filterValue(spec, "schemeId")
        ? String(filterValue(spec, "schemeId"))
        : prev?.schemeId,
      schemeLabel: prev?.schemeLabel,
    };
  }

  const rows = bundle?.table?.rows ?? [];
  const sample = rows[0];
  if (sample) {
    if (typeof sample.customer === "string" && sample.customer !== "—") {
      return {
        customerId: prev?.customerId,
        customerName: sample.customer,
        schemeId: prev?.schemeId,
        schemeLabel: prev?.schemeLabel,
      };
    }
    if (sample.name && entity === "customers") {
      return {
        customerId: sample.id ? String(sample.id) : prev?.customerId,
        customerName: String(sample.name),
        schemeId: prev?.schemeId,
        schemeLabel: prev?.schemeLabel,
      };
    }
  }

  if (entity === "customers" && rows.length >= 1 && rows[0].id) {
    return {
      customerId: String(rows[0].id),
      customerName: rows[0].name ? String(rows[0].name) : prev?.customerName,
      schemeId: prev?.schemeId,
      schemeLabel: prev?.schemeLabel,
    };
  }

  if (entity === "collections" && spec?.limit === 1 && rows.length === 1) {
    const row = rows[0];
    const name = row.customer ?? row.customerName;
    if (row.customerId || name) {
      return {
        customerId: row.customerId ? String(row.customerId) : prev?.customerId,
        customerName: name ? String(name) : prev?.customerName,
        schemeId: row.schemeId ? String(row.schemeId) : prev?.schemeId,
        schemeLabel: row.scheme ? String(row.scheme) : prev?.schemeLabel,
      };
    }
  }

  return prev;
}

export { normalizeFocus as normalizeConversationFocus };
