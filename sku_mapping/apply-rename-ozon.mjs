// ФАЗА 3: переименование offer_id в Ozon через API (/v1/product/update/offer-id).
// Идемпотентно: переименовываем только те, у кого в Ozon ещё стоит старый offer_id.
//
//   node sku_mapping/apply-rename-ozon.mjs            # dry-run (список)
//   node sku_mapping/apply-rename-ozon.mjs --canary   # переименовать 1 + проверить
//   node sku_mapping/apply-rename-ozon.mjs --full      # переименовать всё

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
const H = { "Client-Id": env.OZON_CLIEN_ID, "Api-Key": env.OZON_API_KEY, "Content-Type": "application/json" };
async function ozon(path, body) {
  const r = await fetch(`https://api-seller.ozon.ru${path}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`Ozon ${path} ${r.status}: ${text}`);
  return text ? JSON.parse(text) : {};
}
async function currentOfferIds() {
  const set = new Set();
  let lastId = "";
  while (true) {
    const r = await ozon("/v3/product/list", { filter: { visibility: "ALL" }, last_id: lastId, limit: 1000 });
    const items = r.result?.items ?? [];
    for (const it of items) if (it.offer_id) set.add(String(it.offer_id));
    lastId = r.result?.last_id ?? "";
    if (!lastId || items.length === 0) break;
  }
  return set;
}

const rows = parseCsv(readFileSync(join(__dirname, "sku-mapping.csv"), "utf8"))
  .filter((r) => r.old_offer_id && r.new_article);

console.log(`Режим: ${MODE.toUpperCase()}`);
const present = await currentOfferIds();
console.log(`Ozon offer_id сейчас: ${present.size}`);

const todo = [], done = [], missing = [];
for (const r of rows) {
  if (present.has(r.new_article)) done.push(r.new_article);          // уже переименован
  else if (present.has(r.old_offer_id)) todo.push({ offer_id: r.old_offer_id, new_offer_id: r.new_article });
  else missing.push(r.old_offer_id);                                  // ни старого, ни нового
}
console.log(`К переименованию: ${todo.length}; уже done: ${done.length}; не найдено в Ozon: ${missing.length} [${missing.join(", ")}]`);

async function renameBatch(batch) {
  const res = await ozon("/v1/product/update/offer-id", { update_offer_id: batch });
  const errors = (res.errors ?? res.result ?? []).filter?.((e) => e && (e.message || e.error)) ?? [];
  return { res, errors };
}

if (MODE === "dry") {
  for (const t of todo.slice(0, 15)) console.log(`   ${t.offer_id}  ->  ${t.new_offer_id}`);
  if (todo.length > 15) console.log(`   … и ещё ${todo.length - 15}`);
  console.log("Dry-run: ничего не изменено.");
  process.exit(0);
}

if (todo.length === 0) { console.log("Нечего переименовывать."); process.exit(0); }

const batches = MODE === "canary" ? [todo.slice(0, 1)] : [];
if (MODE === "full") for (let i = 0; i < todo.length; i += 25) batches.push(todo.slice(i, i + 25)); // лимит Ozon: 25/запрос

let renamed = 0;
for (const b of batches) {
  const { res, errors } = await renameBatch(b);
  console.log(`Батч ${b.length}: ответ ${JSON.stringify(res).slice(0, 200)}`);
  if (errors.length) { console.error("ОШИБКИ:", JSON.stringify(errors)); process.exit(1); }
  renamed += b.length;
}

// Проверка: перечитываем Ozon, новые артикулы должны присутствовать.
const after = await currentOfferIds();
const verified = batches.flat().filter((t) => after.has(t.new_offer_id)).length;
console.log(`Переименовано: ${renamed}; подтверждено в Ozon: ${verified}/${renamed}`);
if (verified !== renamed) { console.error("ВНИМАНИЕ: не все подтвердились — проверь вручную."); process.exit(1); }
console.log(MODE === "canary" ? "Канарейка ок. Запусти с --full." : "Готово.");
