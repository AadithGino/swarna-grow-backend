import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";

function walk(directory) { return readdirSync(directory).flatMap((name) => { const item = path.join(directory, name); return statSync(item).isDirectory() ? walk(item) : item.endsWith(".js") ? [item] : []; }); }
const files = [...walk("src"), ...walk("scripts"), ...walk("tests")].filter((file) => !file.endsWith("check-syntax.js"));
for (const file of files) execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
console.log(`Syntax check passed for ${files.length} JavaScript files.`);
