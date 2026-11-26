/**
 * Generates a client-shareable Excel for ecommerce product intake (Google Drive image links).
 *
 * Usage: npm run template:ecommerce-products
 * Output: docs/templates/SwarnaGrow_Ecommerce_Product_Intake.xlsx
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(__dirname, "../docs/templates");
const OUT_FILE = path.join(OUT_DIR, "SwarnaGrow_Ecommerce_Product_Intake.xlsx");

const PRODUCT_HEADERS = [
  "product_name",
  "sku",
  "category_name",
  "description",
  "featured",
  "list_on_shop",
  "allow_scheme_purchase",
  "pricing_type",
  "list_price_inr",
  "sale_price_inr",
  "gold_purity",
  "gold_weight_grams",
  "making_charge_type",
  "making_charge_value",
  "stone_charges_inr",
  "other_charges_inr",
  "stones_notes",
  "stock_type",
  "quantity_in_stock",
  "image_link_1",
  "image_link_2",
  "image_link_3",
  "image_link_4",
  "image_link_5",
  "client_notes",
];

const EXAMPLE_ROW = {
  product_name: "Temple Peacock Choker (sample — delete or replace)",
  sku: "NCK-PEACOCK-001",
  category_name: "Necklaces",
  description:
    "Broad temple-style peacock choker with filigree work. Mention weight, occasion, and any stone details here.",
  featured: "YES",
  list_on_shop: "YES",
  allow_scheme_purchase: "DEFAULT",
  pricing_type: "Fixed price",
  list_price_inr: 185000,
  sale_price_inr: "",
  gold_purity: "",
  gold_weight_grams: "",
  making_charge_type: "",
  making_charge_value: "",
  stone_charges_inr: "",
  other_charges_inr: "",
  stones_notes: "",
  stock_type: "Made to order",
  quantity_in_stock: "",
  image_link_1: "https://drive.google.com/file/d/EXAMPLE/view?usp=sharing",
  image_link_2: "",
  image_link_3: "",
  image_link_4: "",
  image_link_5: "",
  client_notes: "Optional notes for your team only",
};

const INSTRUCTIONS = [
  ["SwarnaGrow — Online shop product intake"],
  [],
  ["Fill one row per product in the “Products” sheet. Do not rename sheet or column headers."],
  [],
  ["Images (Google Drive)"],
  ["• Upload each product photo to Google Drive."],
  ["• Share the file: Anyone with the link → Viewer (or your org policy)."],
  ["• Paste the full share link in image_link_1 (required). Add up to 4 more links in image_link_2 … image_link_5."],
  ["• First image is the main photo in the app. Use clear, well-lit photos on a plain background."],
  [],
  ["Pricing"],
  ["• Fixed price — set pricing_type = Fixed price and list_price_inr (MRP / shop price in ₹, numbers only)."],
  ["  Optional sale_price_inr if the item is on discount."],
  ["• Gold rate based — set pricing_type = Gold rate based, gold_purity (18K / 22K / 24K), gold_weight_grams,"],
  ["  making_charge_type, and making_charge_value. Shop price updates with your published gold rate."],
  [],
  ["Making charge type (gold rate based only)"],
  ["• Fixed (total) — one-time making charge in ₹ (e.g. 8500)."],
  ["• Per gram — making charge ₹ per gram of gold."],
  ["• % of gold value — percent number only (e.g. 12 for 12%)."],
  [],
  ["Stock"],
  ["• Made to order — no stock count needed."],
  ["• Track quantity — set quantity_in_stock to the number available."],
  [],
  ["Other fields"],
  ["• category_name — group products (e.g. Necklaces, Bangles, Rings). We create categories from your list."],
  ["• featured — YES to highlight on the shop home."],
  ["• list_on_shop — YES to publish; NO keeps as draft until you are ready."],
  ["• allow_scheme_purchase — YES / NO / DEFAULT (follows category default)."],
  [],
  ["What we configure on our side (you can leave blank)"],
  ["GST / HSN, tax codes, banners, delivery rules, and payment setup."],
  [],
  ["Return the completed file to SwarnaGrow. We will upload products to your shop and confirm before go-live."],
];

function colLetter(n) {
  let s = "";
  let x = n;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

function addListColumn(sheet, col, values) {
  values.forEach((v, i) => {
    sheet.getCell(i + 1, col).value = v;
  });
  return `$${colLetter(col)}$1:$${colLetter(col)}$${values.length}`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const wb = new ExcelJS.Workbook();
  wb.creator = "SwarnaGrow";
  wb.created = new Date();

  const lists = wb.addWorksheet("_lists", { state: "veryHidden" });
  addListColumn(lists, 1, ["YES", "NO"]);
  const featured = addListColumn(lists, 2, ["YES", "NO"]);
  const scheme = addListColumn(lists, 3, ["DEFAULT", "YES", "NO"]);
  const pricing = addListColumn(lists, 4, ["Fixed price", "Gold rate based"]);
  const purity = addListColumn(lists, 5, ["18K", "22K", "24K"]);
  const making = addListColumn(lists, 6, ["Fixed (total)", "Per gram", "% of gold value"]);
  const stock = addListColumn(lists, 7, ["Made to order", "Track quantity"]);
  const listShop = addListColumn(lists, 8, ["YES", "NO"]);

  const inst = wb.addWorksheet("Instructions");
  inst.getColumn(1).width = 100;
  for (const [i, row] of INSTRUCTIONS.entries()) {
    const cell = inst.getCell(i + 1, 1);
    cell.value = row[0] ?? "";
    if (i === 0) {
      cell.font = { bold: true, size: 14 };
    }
    if (String(row[0] ?? "").endsWith(")") || String(row[0] ?? "").includes("—")) {
      cell.font = { bold: true };
    }
  }

  const products = wb.addWorksheet("Products");
  products.views = [{ state: "frozen", ySplit: 1 }];

  const headerRow = products.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4A148C" },
  };
  headerRow.alignment = { vertical: "middle", wrapText: true };
  products.rowHeight = 22;

  PRODUCT_HEADERS.forEach((h, idx) => {
    const col = idx + 1;
    products.getCell(1, col).value = h;
    products.getColumn(col).width = Math.min(42, Math.max(14, h.length + 4));
  });

  const example = products.getRow(2);
  PRODUCT_HEADERS.forEach((h, idx) => {
    example.getCell(idx + 1).value = EXAMPLE_ROW[h] ?? "";
  });
  example.font = { italic: true, color: { argb: "FF666666" } };

  const dataStart = 3;
  const dataEnd = 500;
  const validations = [
    { header: "featured", formula: featured },
    { header: "list_on_shop", formula: listShop },
    { header: "allow_scheme_purchase", formula: scheme },
    { header: "pricing_type", formula: pricing },
    { header: "gold_purity", formula: purity },
    { header: "making_charge_type", formula: making },
    { header: "stock_type", formula: stock },
  ];

  for (const v of validations) {
    const colIdx = PRODUCT_HEADERS.indexOf(v.header) + 1;
    const letter = colLetter(colIdx);
    for (let r = dataStart; r <= dataEnd; r++) {
      products.getCell(r, colIdx).dataValidation = {
        type: "list",
        allowBlank: true,
        formulae: [v.formula],
        showErrorMessage: true,
        errorTitle: "Pick from list",
        error: "Choose a value from the dropdown.",
      };
    }
    products.getColumn(colIdx).alignment = { vertical: "top" };
  }

  products.getColumn(PRODUCT_HEADERS.indexOf("description") + 1).alignment = { wrapText: true, vertical: "top" };
  products.getColumn(PRODUCT_HEADERS.indexOf("client_notes") + 1).alignment = { wrapText: true, vertical: "top" };

  const legend = wb.addWorksheet("Column reference");
  legend.columns = [
    { header: "Column", key: "col", width: 22 },
    { header: "Required", key: "req", width: 12 },
    { header: "When", key: "when", width: 28 },
    { header: "Description", key: "desc", width: 70 },
  ];
  const refRows = [
    ["product_name", "Yes", "Always", "Display name in the customer app (max ~200 characters)."],
    ["sku", "No", "Always", "Your internal code; helpful for billing (unique per product)."],
    ["category_name", "Yes", "Always", "Shop category label — e.g. Necklaces, Earrings."],
    ["description", "No", "Always", "Product details for customers."],
    ["featured", "No", "Always", "YES to show in featured section."],
    ["list_on_shop", "No", "Always", "YES = live on shop; NO = draft."],
    ["allow_scheme_purchase", "No", "Always", "Can customers pay using scheme balance? DEFAULT / YES / NO."],
    ["pricing_type", "Yes", "Always", "Fixed price OR Gold rate based."],
    ["list_price_inr", "Yes", "Fixed price", "Selling price in rupees (integer or decimals)."],
    ["sale_price_inr", "No", "Fixed price", "Discounted price if on sale."],
    ["gold_purity", "Yes", "Gold rate based", "18K, 22K, or 24K."],
    ["gold_weight_grams", "Yes", "Gold rate based", "Net gold weight in grams (e.g. 12.5)."],
    ["making_charge_type", "Yes", "Gold rate based", "How making is calculated — see Instructions."],
    ["making_charge_value", "Yes", "Gold rate based", "Amount matching making_charge_type."],
    ["stone_charges_inr", "No", "Gold rate based", "Total stone charges in ₹ if any."],
    ["other_charges_inr", "No", "Gold rate based", "Any other fixed charges in ₹."],
    ["stones_notes", "No", "Optional", "Stone types/counts for your records (display copy optional)."],
    ["stock_type", "No", "Always", "Made to order or Track quantity."],
    ["quantity_in_stock", "Yes", "Track quantity", "Whole number available to sell."],
    ["image_link_1 … 5", "Yes (link 1)", "Always", "Google Drive share links — link 1 required per product."],
    ["client_notes", "No", "Optional", "Notes for SwarnaGrow team only."],
  ];
  for (const row of refRows) {
    legend.addRow({ col: row[0], req: row[1], when: row[2], desc: row[3] });
  }
  legend.getRow(1).font = { bold: true };

  await wb.xlsx.writeFile(OUT_FILE);
  console.log(`Wrote ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});