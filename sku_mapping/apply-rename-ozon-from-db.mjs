// Переименование offer_id в Ozon по СТЕКУЩЕМУ состоянию БД (merch_products.sku).
// Матч по ozon_sku: текущий offer_id в Ozon -> новый sku из БД. Идемпотентно.
//
//   node sku_mapping/apply-rename-ozon-from-db.mjs            # dry-run
//   node sku_mapping/apply-rename-ozon-from-db.mjs --canary    # 1 шт + проверка
//   node sku_mapping/apply-rename-ozon-from-db.mjs --full       # всё
// (запускать с dangerouslyDisableSandbox — egress к Ozon режется песочницей)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MODE = process.argv.includes("--full") ? "full" : process.argv.includes("--canary") ? "canary" : "dry";

function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env.local"), "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].trim();
  }
  return env;
}
const env = loadEnv();
const H = { "Client-Id": env.OZON_CLIEN_ID, "Api-Key": env.OZON_API_KEY, "Content-Type": "application/json" };
async function ozon(path, body) {
  const r = await fetch(`https://api-seller.ozon.ru${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`Ozon ${path} ${r.status}: ${t}`);
  return t ? JSON.parse(t) : {};
}
async function ozonSkuToOffer() {
  // offer_id list -> info -> {ozon_sku -> offer_id}
  const offers = [];
  let lastId = "";
  while (true) {
    const r = await ozon("/v3/product/list", { filter: { visibility: "ALL" }, last_id: lastId, limit: 1000 });
    const items = r.result?.items ?? [];
    for (const it of items) if (it.offer_id) offers.push(String(it.offer_id));
    lastId = r.result?.last_id ?? "";
    if (!lastId || items.length === 0) break;
  }
  const map = new Map();
  for (let i = 0; i < offers.length; i += 1000) {
    const r = await ozon("/v3/product/info/list", { offer_id: offers.slice(i, i + 1000) });
    for (const it of (r.items ?? [])) {
      const sk = it.sku ?? (it.sources ?? []).map((s) => s.sku).find(Boolean);
      if (sk && it.offer_id) map.set(String(sk), String(it.offer_id));
    }
  }
  return map;
}

console.log(`Режим: ${MODE.toUpperCase()}`);
const ozonMap = await ozonSkuToOffer();
console.log(`Ozon товаров: ${ozonMap.size}`);

const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
const { data: products, error } = await sb.from("merch_products").select("sku, ozon_sku").not("ozon_sku", "is", null);
if (error) throw error;

const todo = [], skip = [], missing = [];
for (const p of products) {
  const cur = ozonMap.get(String(p.ozon_sku));
  if (!cur) { missing.push(p.sku); continue; }
  if (cur === p.sku) { skip.push(p.sku); continue; }
  todo.push({ offer_id: cur, new_offer_id: p.sku });
}
console.log(`К переименованию: ${todo.length}; уже актуальны: ${skip.length}; нет в Ozon: ${missing.length} [${missing.join(", ")}]`);

if (MODE === "dry") {
  for (const t of todo.slice(0, 15)) console.log(`   ${t.offer_id}  ->  ${t.new_offer_id}`);
  if (todo.length > 15) console.log(`   … и ещё ${todo.length - 15}`);
  process.exit(0);
}
if (todo.length === 0) { console.log("Нечего делать."); process.exit(0); }

const batches = [];
const src = MODE === "canary" ? todo.slice(0, 1) : todo;
for (let i = 0; i < src.length; i += 25) batches.push(src.slice(i, i + 25)); // лимит Ozon 25

let done = 0;
const failed = [];
for (const b of batches) {
  const res = await ozon("/v1/product/update/offer-id", { update_offer_id: b });
  const errs = (res.errors ?? []).filter((e) => e && (e.message || e.error));
  for (const e of errs) failed.push(`${e.offer_id}: ${(e.message || e.error || "").split("\n")[0]}`);
  done += b.length - errs.length;
}
const after = await ozonSkuToOffer();
const ok = src.filter((t) => [...after.values()].includes(t.new_offer_id)).length;
console.log(`Переименовано (примерно): ${done}; подтверждено в Ozon: ${ok}/${src.length}`);
if (failed.length) console.error(`НЕ УДАЛОСЬ (${failed.length}, проблема карточки на Ozon):\n  ${failed.join("\n  ")}`);
console.log(MODE === "canary" ? "Канарейка ок — запусти --full." : "Готово.");
