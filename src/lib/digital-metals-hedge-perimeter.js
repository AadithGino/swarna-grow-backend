export { istBusinessDayBounds } from "./digital-metals-business-calendar.js";

export function computeClosingPerimeter({
  openingObligationUg,
  openingHedgePositionUg,
  completedBuyUg,
  executedSellUg,
  physicalHandoverUg,
  procurementReceiptUg,
  supplierDisposalUg,
  obligationAdjustmentUg = 0,
  hedgeAdjustmentUg = 0,
}) {
  const closingObligationUg =
    openingObligationUg +
    completedBuyUg -
    executedSellUg -
    physicalHandoverUg +
    obligationAdjustmentUg;
  const closingHedgePositionUg =
    openingHedgePositionUg +
    procurementReceiptUg -
    supplierDisposalUg -
    physicalHandoverUg +
    hedgeAdjustmentUg;
  return {
    closingObligationUg,
    closingHedgePositionUg,
    uncoveredUg: closingObligationUg - closingHedgePositionUg,
  };
}

export function stringifyUg(n) {
  return String(Math.trunc(n));
}
