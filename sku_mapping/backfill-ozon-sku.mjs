// Backfill merch_products.ozon_sku from the Ozon Seller API.
//
// Flow:
//   1. /v3/product/list   — собрать все offer_id (с пагинацией по last_id)
//   2. /v3/product/info/list — по offer_id получить числовой Ozon `sku`
//   3. сматчить с merch_products по sku ИЛИ legacy_skus и проставить ozon_sku
//
// Ключи берутся из .env.local (OZON_API_KEY, OZON_CLIEN_ID, NEXT_PUBLIC_SUPABASE_*).
// Результат маппинга пишется в sku_mapping/ozon-sku-map.json для аудита.
//
//   node sku_mapping/backfill-ozon-sku.mjs            # бэкфилл
//   node sku_mapping/backfill-ozon-sku.mjs --dry-run  # только показать, без записи в БД

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createClient } from "@supabase/supabase-js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DRY_RUN = process.argv.includes("--dry-run");

// --- env ---------------------------------------------------------------
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
const OZON_BASE = "https://api-seller.ozon.ru";
const OZON_HEADERS = {
  "Client-Id": env.OZON_CLIEN_ID,
  "Api-Key": env.OZON_API_KEY,
  "Content-Type": "application/json",
};

async function ozonPost(path, body) {
  const res = await fetch(`${OZON_BASE}${path}`, {
    method: "POST",
    headers: OZON_HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Ozon ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

// --- 1) все offer_id -----------------------------------------------------
async function fetchAllOfferIds() {
  const offers = [];
  let lastId = "";
  while (true) {
    const r = await ozonPost("/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    });
    const items = r.result?.items ?? [];
    for (const it of items) if (it.offer_id) offers.push(String(it.offer_id));
    lastId = r.result?.last_id ?? "";
    if (!lastId || items.length === 0) break;
  }
  return [...new Set(offers)];
}

// --- 2) offer_id -> числовой sku ----------------------------------------
function extractSku(item) {
  if (item.sku) return Number(item.sku);
  // fallback: единый sku мог приехать внутри sources
  for (const s of item.sources ?? []) if (s.sku) return Number(s.sku);
  return null;
}

async function fetchOzonSkus(offerIds) {
  const map = new Map(); // offer_id -> sku
  let rawShapeLogged = false;
  for (let i = 0; i < offerIds.length; i += 1000) {
    const batch = offerIds.slice(i, i + 1000);
    const r = await ozonPost("/v3/product/info/list", { offer_id: batch });
    const items = r.items ?? r.result?.items ?? [];
    if (!rawShapeLogged && items[0]) {
      console.log("  пример ответа info/list:", JSON.stringify(items[0]).slice(0, 300));
      rawShapeLogged = true;
    }
    for (const it of items) {
      const sku = extractSku(it);
      if (it.offer_id && sku) map.set(String(it.offer_id), sku);
    }
  }
  return map;
}

// --- main ----------------------------------------------------------------
async function main() {
  console.log(`Режим: ${DRY_RUN ? "DRY-RUN (без записи)" : "БЭКФИЛЛ"}`);

  console.log("1/4 Тяну offer_id из Ozon (/v3/product/list)…");
  const offerIds = await fetchAllOfferIds();
  console.log(`   получено offer_id: ${offerIds.length}`);

  console.log("2/4 Тяну числовые sku (/v3/product/info/list)…");
  const skuByOffer = await fetchOzonSkus(offerIds);
  console.log(`   offer_id с числовым sku: ${skuByOffer.size}`);

  writeFileSync(
    join(__dirname, "ozon-sku-map.json"),
    JSON.stringify(Object.fromEntries(skuByOffer), null, 2),
  );

  console.log("3/4 Тяну каталог из Supabase…");
  const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  const { data: products, error } = await sb
    .from("merch_products")
    .select("id, sku, legacy_skus, ozon_sku")
    .not("sku", "is", null);
  if (error) throw error;

  const updates = []; // {id, offer_id, ozon_sku}
  const unmatched = []; // sku из БД, для которых Ozon не дал числовой sku
  for (const p of products) {
    const candidates = [p.sku, ...(p.legacy_skus ?? [])].filter(Boolean);
    let found = null, via = null;
    for (const c of candidates) {
      if (skuByOffer.has(String(c))) { found = skuByOffer.get(String(c)); via = c; break; }
    }
    if (found == null) {
      if (!/-BLANK$/i.test(p.sku)) unmatched.push(p.sku);
      continue;
    }
    if (Number(p.ozon_sku) === found) continue; // уже стоит
    updates.push({ id: p.id, offer_id: p.sku, via, ozon_sku: found });
  }

  console.log("4/4 Применяю…");
  console.log(`   к обновлению: ${updates.length}`);
  console.log(`   без Ozon-sku (нет на Ozon / только заготовки): ${unmatched.length}`);
  if (unmatched.length) console.log("   ", unmatched.join(", "));

  if (!DRY_RUN) {
    let ok = 0;
    for (const u of updates) {
      const { error: upErr } = await sb
        .from("merch_products")
        .update({ ozon_sku: u.ozon_sku })
        .eq("id", u.id);
      if (upErr) throw new Error(`update ${u.offer_id}: ${upErr.message}`);
      ok++;
    }
    console.log(`   обновлено строк: ${ok}`);
  } else {
    for (const u of updates.slice(0, 10)) console.log("   ", u.offer_id, "->", u.ozon_sku, u.via !== u.offer_id ? `(via ${u.via})` : "");
    if (updates.length > 10) console.log(`    … и ещё ${updates.length - 10}`);
  }

  console.log("Готово.");
}

main().catch((e) => { console.error("ОШИБКА:", e.message); process.exit(1); });
