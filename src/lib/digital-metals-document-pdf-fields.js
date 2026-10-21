function formatMetalAssetLabel(metal, finenessPpm) {
  const purity = finenessPpm != null ? `${(Number(finenessPpm) / 1000).toFixed(1)}‰` : "";
  return [String(metal ?? "Metal"), purity].filter(Boolean).join(" ");
}

export function formatInrFromPaise(paise) {
  if (paise == null || paise === "" || Number.isNaN(Number(paise))) return "—";
  return `₹${(Number(paise) / 100).toFixed(2)}`;
}

export function ugToGramsDisplay(ug) {
  const n = Number(ug);
  if (Number.isNaN(n)) return "—";
  return `${(n / 1_000_000).toFixed(3)} g`;
}

export function resolveSellSettlementPaise(order) {
  if (!order || typeof order !== "object") return null;
  if (order.settlementPaise != null && !Number.isNaN(Number(order.settlementPaise))) {
    return Number(order.settlementPaise);
  }
  const snap = order.snapshot && typeof order.snapshot === "object" ? order.snapshot : null;
  if (snap?.settlementPaise != null && !Number.isNaN(Number(snap.settlementPaise))) {
    return Number(snap.settlementPaise);
  }
  if (order.netSettlementPaise != null && !Number.isNaN(Number(order.netSettlementPaise))) {
    return Number(order.netSettlementPaise);
  }
  if (order.totalPaise != null && !Number.isNaN(Number(order.totalPaise))) {
    return Number(order.totalPaise);
  }
  return null;
}

export function sellAcknowledgementPdfRows(order) {
  const snap = order.snapshot && typeof order.snapshot === "object" ? order.snapshot : {};
  const rateSnap = snap.rateSnapshot && typeof snap.rateSnapshot === "object" ? snap.rateSnapshot : {};
  const settlementPaise = resolveSellSettlementPaise(order);
  const feeLines = Array.isArray(snap.feeLines) ? snap.feeLines : [];
  const feeTotal = feeLines.reduce((sum, line) => sum + Number(line?.amountPaise ?? 0), 0);
  const taxPaise = snap.taxPaise != null ? Number(snap.taxPaise) : 0;
  const grossPaise =
    snap.grossPaise != null
      ? Number(snap.grossPaise)
      : settlementPaise != null
        ? settlementPaise + feeTotal + taxPaise
        : null;

  const metalLabel = formatMetalAssetLabel(order.metal, order.finenessPpm);

  const rows = [
    ["Sell order", String(order._id ?? order.id ?? "—")],
    ["Metal / purity", metalLabel],
    ["Quantity sold", ugToGramsDisplay(order.quantityUg)],
    [
      "Sell rate (per gram)",
      rateSnap.sellRatePerGramPaise != null
        ? formatInrFromPaise(rateSnap.sellRatePerGramPaise)
        : "—",
    ],
  ];

  if (grossPaise != null) rows.push(["Gross value", formatInrFromPaise(grossPaise)]);
  if (feeTotal > 0) rows.push(["Fees", formatInrFromPaise(feeTotal)]);
  if (taxPaise > 0) rows.push(["Taxes", formatInrFromPaise(taxPaise)]);

  rows.push([
    "Net settlement (INR payable to customer)",
    settlementPaise != null ? formatInrFromPaise(settlementPaise) : "—",
  ]);

  if (order.executedAt) {
    rows.push(["Sale executed at", new Date(order.executedAt).toISOString()]);
  } else if (order.confirmedAt) {
    rows.push(["Quote confirmed at", new Date(order.confirmedAt).toISOString()]);
  }

  rows.push(["Order status", String(order.status ?? "—")]);
  rows.push([
    "Payout",
    order.status === "SETTLED"
      ? "INR payout recorded (see payout receipt if issued)"
      : "INR payout is a separate staff step after metal debit",
  ]);

  return rows;
}
