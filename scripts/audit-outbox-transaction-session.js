#!/usr/bin/env node
/**
 * P0 guardrail: flag outbox enqueue calls that omit `session` (must co-commit with domain writes).
 * Exit 1 if any violation is found in src/services and src/lib (excluding tests).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "src");

const ENQUEUE_RE = /enqueue(?:Ecommerce|DigitalMetal|FlexPolicyClosed)Outbox(?:Event)?\s*\(/g;

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (p.endsWith(".js")) out.push(p);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

const violations = [];

for (const file of walk(root)) {
  const text = fs.readFileSync(file, "utf8");
  let match;
  while ((match = ENQUEUE_RE.exec(text)) !== null) {
    const start = match.index;
    let depth = 0;
    let i = text.indexOf("(", start);
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const block = text.slice(start, i + 1);
    if (!block.includes("session:") && !block.includes("session,")) {
      violations.push({ file, line: lineOf(text, start) });
    }
  }
}

if (violations.length) {
  console.error("Outbox enqueue calls missing `session` (co-commit required):\n");
  for (const v of violations) {
    console.error(`  ${path.relative(path.resolve(__dirname, ".."), v.file)}:${v.line}`);
  }
  process.exit(1);
}

console.log("audit-outbox-transaction-session: OK (all enqueue calls include session).");
