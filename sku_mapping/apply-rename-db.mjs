// ФАЗА 2: переименование артикулов в БД.
//   sku := новый артикул (D###), старый sku уходит в legacy_skus.
// Матч по ozon_sku (стабильный якорь). Идемпотентно (уже переименованные пропускаются).
//
//   node sku_mapping/apply-rename-db.mjs --dry-run   # показать
//   node sku_mapping/apply-rename-db.mjs             # применить

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
    const o = {}; header.forEach((h, i) => (o[h] = (cells[i] ?? "").trim()));
    return o;
  });
}

const env = loadEnv();
const rows = parseCsv(readFileSync(join(__dirname, "sku-mapping.csv"), "utf8"));

// Валидация: уникальность новых артикулов и длина ≤ 50 (лимит Ozon).
const seen = new Map();
const dups = [], tooLong = [];
for (const r of rows) {
  if (!r.new_article) continue;
  if (r.new_article.length > 50) tooLong.push(r.new_article);
  if (seen.has(r.new_article)) dups.push(`${r.new_article} (${seen.get(r.new_article)} и ${r.old_offer_id})`);
  else seen.set(r.new_article, r.old_offer_id);
}
if (dups.length) { console.error("ДУБЛИ новых артикулов:\n  " + dups.join("\n  ")); process.exit(1); }
if (tooLong.length) { console.error("Слишком длинные (>50):\n  " + tooLong.join("\n  ")); process.exit(1); }

const newBySku = new Map(); // ozon_sku -> new_article
for (const r of rows) if (r.ozon_sku) newBySku.set(String(r.ozon_sku), r.new_article);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { data: products, error } = await sb
  .from("merch_products")
  .select("id, sku, legacy_skus, ozon_sku")
  .not("ozon_sku", "is", null);
if (error) throw error;

const updates = [], skipped = [], unmapped = [];
for (const p of products) {
  const newSku = newBySku.get(String(p.ozon_sku));
  if (!newSku) { unmapped.push(p.sku); continue; }
  if (p.sku === newSku) { skipped.push(p.sku); continue; } // уже переименован
  const legacy = Array.from(new Set([...(p.legacy_skus ?? []), p.sku].filter((x) => x && x !== newSku)));
  updates.push({ id: p.id, oldSku: p.sku, newSku, legacy });
}

console.log(`Режим: ${DRY_RUN ? "DRY-RUN" : "ПРИМЕНЕНИЕ"}`);
console.log(`К переименованию: ${updates.length}; уже переименовано: ${skipped.length}; без маппинга: ${unmapped.length} [${unmapped.join(", ")}]`);
for (const u of updates.slice(0, 12)) console.log(`   ${u.oldSku}  ->  ${u.newSku}   legacy=[${u.legacy.join(", ")}]`);
if (updates.length > 12) console.log(`   … и ещё ${updates.length - 12}`);

if (!DRY_RUN) {
  let ok = 0;
  for (const u of updates) {
    const { error: e } = await sb.from("merch_products")
      .update({ sku: u.newSku, legacy_skus: u.legacy }).eq("id", u.id);
    if (e) throw new Error(`${u.oldSku} -> ${u.newSku}: ${e.message}`);
    ok++;
  }
  console.log(`Переименовано: ${ok}`);
}
console.log("Готово.");
