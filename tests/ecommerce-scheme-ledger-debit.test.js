import assert from "node:assert/strict";
import test from "node:test";
import { sumEcommerceRedemptionLedgerDebits } from "../src/lib/ecommerce-scheme-ledger-debit.js";
import { LedgerEntryType } from "../src/constants/enums.js";

test("sumEcommerceRedemptionLedgerDebits counts only online shop debits", () => {
  const sum = sumEcommerceRedemptionLedgerDebits([
    {
      type: LedgerEntryType.REDEMPTION_DEBIT,
      amountPaise: 40_000,
      metadata: { source: "ONLINE_SHOP", ecommerceOrderId: "eord_1" },
    },
    {
      type: LedgerEntryType.REDEMPTION_DEBIT,
      amountPaise: 25_000,
      metadata: { billNumber: "BILL-1" },
    },
    {
      type: LedgerEntryType.INSTALLMENT_PAYMENT,
      amountPaise: 5_000,
    },
  ]);
  assert.equal(sum.amountPaise, 40_000);
  assert.equal(sum.weightMg, 0);
});