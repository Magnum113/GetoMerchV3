// Бэкфилл merch_products.design_version / hoodie_fit / hoodie_fabric из sku-mapping.csv.
// Матч по ozon_sku (стабильный якорь). design_version берётся из сегмента Vxx нового артикула.
//
//   node sku_mapping/backfill-variant-dims.mjs            # запись
//   node sku_mapping/backfill-variant-dims.mjs --dry-run  # показать, без записи

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = []; let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const obj = {}; header.forEach((h, i) => (obj[h] = (cells[i] ?? "").trim()));
    return obj;
  });
}

const env = loadEnv();
const rows = parseCsv(readFileSync(join(__dirname, "sku-mapping.csv"), "utf8"));

// ozon_sku -> {version, fit, fabric}
const dimsBySku = new Map();
for (const r of rows) {
  if (!r.ozon_sku) continue;
  const vm = (r.new_article || "").match(/-(V\d+)-/);
  dimsBySku.set(String(r.ozon_sku), {
    design_version: vm ? vm[1] : null,
    hoodie_fit: r.hoodie_fit || null,
    hoodie_fabric: r.hoodie_fabric || null,
  });
}

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { data: products, error } = await sb
  .from("merch_products")
  .select("id, sku, ozon_sku, design_version, hoodie_fit, hoodie_fabric")
  .not("ozon_sku", "is", null);
if (error) throw error;

const updates = [];
for (const p of products) {
  const d = dimsBySku.get(String(p.ozon_sku));
  if (!d) continue;
  if (p.design_version === d.design_version && p.hoodie_fit === d.hoodie_fit && p.hoodie_fabric === d.hoodie_fabric) continue;
  updates.push({ id: p.id, sku: p.sku, ...d });
}

console.log(`Режим: ${DRY_RUN ? "DRY-RUN" : "ЗАПИСЬ"}`);
console.log(`Каталог с ozon_sku: ${products.length}, в маппинге: ${dimsBySku.size}, к обновлению: ${updates.length}`);
for (const u of updates.slice(0, 12)) console.log(`   ${u.sku}: ${u.design_version ?? "—"} ${u.hoodie_fit ?? ""} ${u.hoodie_fabric ?? ""}`.trimEnd());
if (updates.length > 12) console.log(`   … и ещё ${updates.length - 12}`);

if (!DRY_RUN) {
  let ok = 0;
  for (const u of updates) {
    const { error: e } = await sb.from("merch_products")
      .update({ design_version: u.design_version, hoodie_fit: u.hoodie_fit, hoodie_fabric: u.hoodie_fabric })
      .eq("id", u.id);
    if (e) throw new Error(`${u.sku}: ${e.message}`);
    ok++;
  }
  console.log(`Обновлено строк: ${ok}`);
}
console.log("Готово.");
