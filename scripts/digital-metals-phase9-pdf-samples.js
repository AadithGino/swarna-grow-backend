/**
 * Generates representative Phase 9 PDFs for visual inspection.
 * Run: NODE_ENV=test node scripts/digital-metals-phase9-pdf-samples.js
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { renderDigitalMetalStatementPdfBuffer } from "../src/lib/digital-metals-statement-pdf.js";
import {
  renderPhysicalHandoverReceiptPdf,
  renderPayoutReceiptPdf,
  renderRedemptionChargeReceiptPdf,
  renderSellAcknowledgementPdf,
} from "../src/lib/digital-metals-document-pdf.js";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/phase9-pdf-samples");

const tenant = { _id: "tnt_sample", name: "Swarna Jewellers Demo" };
const customer = { _id: "cus_sample", name: "Priya Sharma" };

const shortLines = [
  {
    createdAt: "2026-10-01T04:30:00.000Z",
    entryType: "BUY_CREDIT",
    quantityUgDelta: "1000000",
    reservedUgDelta: "0",
  },
];

const multipageLines = Array.from({ length: 55 }, (_, i) => ({
  createdAt: new Date(Date.UTC(2026, 9, 1, 4, 0, i * 15)).toISOString(),
  entryType: i % 3 === 0 ? "BUY_CREDIT" : i % 3 === 1 ? "SELL_DEBIT" : "RESERVE",
  quantityUgDelta: String((i + 1) * 10_000),
  reservedUgDelta: String(i % 5 === 0 ? 5000 : 0),
}));

const opening = [{ metal: "GOLD", finenessPpm: 916000, heldUg: "5000000", reservedUg: "2000000" }];
const closing = [{ metal: "GOLD", finenessPpm: 916000, heldUg: "4800000", reservedUg: "1500000" }];

async function writePdf(name, buffer) {
  const pdfPath = path.join(outDir, `${name}.pdf`);
  await fs.writeFile(pdfPath, buffer);
  return pdfPath;
}

async function maybeThumbnail(pdfPath) {
  try {
    execFileSync("qlmanage", ["-t", "-s", "1200", "-o", outDir, pdfPath], { stdio: "ignore" });
  } catch {
    // qlmanage optional
  }
}

const samples = [
  {
    name: "statement-short",
    buffer: () =>
      renderDigitalMetalStatementPdfBuffer({
        tenant,
        customer,
        documentNumber: "STM-2026-000001",
        fromBusinessDate: "2026-10-01",
        toBusinessDate: "2026-10-07",
        lines: shortLines,
        openingByAsset: opening,
        closingByAsset: closing,
      }),
  },
  {
    name: "statement-multipage",
    buffer: () =>
      renderDigitalMetalStatementPdfBuffer({
        tenant,
        customer,
        documentNumber: "STM-2026-000002",
        fromBusinessDate: "2026-10-01",
        toBusinessDate: "2026-10-31",
        lines: multipageLines,
        openingByAsset: opening,
        closingByAsset: closing,
      }),
  },
  {
    name: "redemption-charge-receipt",
    buffer: () =>
      renderRedemptionChargeReceiptPdf({
        documentNumber: "RCR-2026-000010",
        order: {
          _id: "dmro_sample",
          chargeTotalPaise: 250_000,
          quantityUg: 2_000_000,
        },
      }),
  },
  {
    name: "handover-receipt",
    buffer: () =>
      renderPhysicalHandoverReceiptPdf({
        documentNumber: "HOR-2026-000011",
        event: {
          _id: "dmpe_sample",
          redemptionOrderId: "dmro_sample",
          quantityUg: 2_000_000,
          businessDate: "2026-10-18",
          fulfilmentMode: "PICKUP",
        },
        order: { _id: "dmro_sample" },
      }),
  },
  {
    name: "sell-acknowledgement",
    buffer: () =>
      renderSellAcknowledgementPdf({
        documentNumber: "SLA-2026-000012",
        order: {
          _id: "dmso_sample",
          quantityUg: 1_500_000,
          netSettlementPaise: 890_000,
          status: "SETTLED",
        },
      }),
  },
  {
    name: "payout-receipt-staff-attested",
    buffer: () =>
      renderPayoutReceiptPdf({
        documentNumber: "PYR-2026-000013",
        payout: {
          _id: "dmpo_sample",
          amountPaise: 890_000,
          status: "SETTLED",
          settlementReference: "NEFT-REF-8821",
        },
      }),
  },
];

await fs.mkdir(outDir, { recursive: true });
for (const sample of samples) {
  const pdfPath = await writePdf(sample.name, await sample.buffer());
  await maybeThumbnail(pdfPath);
  const stat = await fs.stat(pdfPath);
  if (stat.size < 400) throw new Error(`${sample.name} PDF suspiciously small`);
}
process.stdout.write(`Wrote ${samples.length} PDFs to ${outDir}\n`);
