// Сверка: что есть в Ozon vs sku-mapping.csv vs merch_products.
// Находит: новые товары Ozon, которых нет в маппинге и/или в каталоге.
//
//   node sku_mapping/reconcile-ozon.mjs

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

function loadEnv() {
  const raw = readFileSync(join(ROOT, ".env.local"), "utf8");
  const env = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const OZON_HEADERS = {
  "Client-Id": env.OZON_CLIEN_ID,
  "Api-Key": env.OZON_API_KEY,
  "Content-Type": "application/json",
};
async function ozonPost(path, body) {
  const res = await fetch(`https://api-seller.ozon.ru${path}`, {
    method: "POST", headers: OZON_HEADERS, body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ozon ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

async function fetchOzon() {
  // 1) все offer_id
  const offers = [];
  let lastId = "";
  while (true) {
    const r = await ozonPost("/v3/product/list", { filter: { visibility: "ALL" }, last_id: lastId, limit: 1000 });
    const items = r.result?.items ?? [];
    for (const it of items) if (it.offer_id) offers.push(String(it.offer_id));
    lastId = r.result?.last_id ?? "";
    if (!lastId || items.length === 0) break;
  }
  // 2) offer_id -> {sku, name}
  const byOffer = new Map();
  for (let i = 0; i < offers.length; i += 1000) {
    const r = await ozonPost("/v3/product/info/list", { offer_id: offers.slice(i, i + 1000) });
    for (const it of (r.items ?? r.result?.items ?? [])) {
      const sku = it.sku ? Number(it.sku) : (it.sources ?? []).map((s) => s.sku).find(Boolean);
      byOffer.set(String(it.offer_id), { sku: sku ? Number(sku) : null, name: it.name ?? null, product_id: it.id ?? null });
    }
  }
  return byOffer;
}

// очень простой парсер CSV с кавычками (без экранированных кавычек внутри)
function parseCsv(text) {
  const lines = text.split("\n").filter((l) => l.trim());
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = [];
    let cur = "", q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === "," && !q) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const obj = {};
    header.forEach((h, i) => (obj[h] = (cells[i] ?? "").trim()));
    rows.push(obj);
  }
  return rows;
}

async function main() {
  console.log("Тяну Ozon…");
  const ozon = await fetchOzon();
  console.log(`  Ozon offer_id: ${ozon.size}`);

  const mapRows = parseCsv(readFileSync(join(__dirname, "sku-mapping.csv"), "utf8"));
  const mapByOffer = new Set(mapRows.map((r) => r.old_offer_id));
  const mapBySku = new Set(mapRows.map((r) => String(r.ozon_sku)).filter(Boolean));
  console.log(`  Маппинг строк: ${mapRows.length}`);

  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: products, error } = await sb
    .from("merch_products")
    .select("id, sku, legacy_skus, ozon_sku, is_blank");
  if (error) throw error;
  const dbBySku = new Set(products.filter((p) => p.ozon_sku).map((p) => String(p.ozon_sku)));
  const dbByOffer = new Set();
  for (const p of products) {
    if (p.sku) dbByOffer.add(p.sku);
    for (const l of p.legacy_skus ?? []) dbByOffer.add(l);
  }
  console.log(`  Каталог товаров: ${products.length}`);

  const newInOzon = [];      // в Ozon есть, в маппинге нет
  const notInCatalog = [];   // в Ozon есть, в каталоге нет
  for (const [offer, info] of ozon) {
    const inMap = mapByOffer.has(offer) || (info.sku && mapBySku.has(String(info.sku)));
    const inDb = (info.sku && dbBySku.has(String(info.sku))) || dbByOffer.has(offer);
    if (!inMap) newInOzon.push({ offer, sku: info.sku, name: info.name });
    if (!inDb) notInCatalog.push({ offer, sku: info.sku, name: info.name });
  }

  const ozonSkus = new Set([...ozon.values()].map((v) => v.sku && String(v.sku)).filter(Boolean));
  const inDbNotOzon = products
    .filter((p) => !p.is_blank && p.ozon_sku && !ozonSkus.has(String(p.ozon_sku)))
    .map((p) => ({ sku: p.sku, ozon_sku: p.ozon_sku }));

  const report = { ozonCount: ozon.size, mappingRows: mapRows.length, catalogRows: products.length, newInOzon, notInCatalog, inDbNotOzon };
  writeFileSync(join(__dirname, "reconcile-report.json"), JSON.stringify(report, null, 2));

  console.log(`\n── A) В Ozon есть, в МАППИНГЕ нет (${newInOzon.length}) — нужны новые артикулы:`);
  for (const x of newInOzon) console.log(`   ${x.offer}  sku=${x.sku}  ${x.name}`);
  console.log(`\n── B) В Ozon есть, в КАТАЛОГЕ нет (${notInCatalog.length}) — добавить в merch_products:`);
  for (const x of notInCatalog) console.log(`   ${x.offer}  sku=${x.sku}  ${x.name}`);
  console.log(`\n── C) В каталоге есть, в Ozon нет (${inDbNotOzon.length}):`);
  for (const x of inDbNotOzon) console.log(`   ${x.sku}  ozon_sku=${x.ozon_sku}`);
  console.log("\nОтчёт: sku_mapping/reconcile-report.json");
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
