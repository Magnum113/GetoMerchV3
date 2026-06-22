// Проставляет ТН ВЭД код (атрибут 22232) худи/свитшотам в Ozon, у которых он пуст.
// Значение: dictionary_value_id 971398509 = ТН ВЭД 6110209900 (трикотаж, хлопок), активное.
//
//   node sku_mapping/set-tnved.mjs            # dry-run (кому нужно)
//   node sku_mapping/set-tnved.mjs --canary    # 1 товар + проверка
//   node sku_mapping/set-tnved.mjs --full       # всем
// (запускать с dangerouslyDisableSandbox — egress к Ozon)

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MODE = process.argv.includes("--full") ? "full" : process.argv.includes("--canary") ? "canary" : "dry";

const TNVED_ATTR_ID = 22232;
const TNVED_VALUE_ID = 971398509; // 6110209900 (активное)

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) Все HDY/SWT offer_id
async function hoodieSweatOfferIds() {
  const offers = [];
  let lastId = "";
  while (true) {
    const r = await ozon("/v3/product/list", { filter: { visibility: "ALL" }, last_id: lastId, limit: 1000 });
    const items = r.result?.items ?? [];
    for (const it of items) {
      const o = String(it.offer_id || "");
      if (/-HDY-|-SWT-/.test(o)) offers.push(o);
    }
    lastId = r.result?.last_id ?? "";
    if (!lastId || items.length === 0) break;
  }
  return offers;
}
// 2) атрибуты -> кому нужен ТН ВЭД
async function needTnved(offers) {
  const need = [];
  for (let i = 0; i < offers.length; i += 100) {
    const r = await ozon("/v4/product/info/attributes", {
      filter: { offer_id: offers.slice(i, i + 100), visibility: "ALL" }, limit: 100,
    });
    for (const it of (r.result ?? [])) {
      const has = (it.attributes ?? []).some((a) => a.id === TNVED_ATTR_ID && (a.values ?? []).length);
      if (!has) need.push({ offer_id: it.offer_id, type_id: it.type_id, dcid: it.description_category_id });
    }
  }
  return need;
}

async function importBatch(items) {
  const r = await ozon("/v3/product/import", {
    items: items.map((it) => ({
      offer_id: it.offer_id,
      description_category_id: it.dcid,
      type_id: it.type_id,
      attributes: [{ complex_id: 0, id: TNVED_ATTR_ID, values: [{ dictionary_value_id: TNVED_VALUE_ID }] }],
    })),
  });
  const taskId = r.result?.task_id;
  if (!taskId) throw new Error("no task_id: " + JSON.stringify(r));
  // poll
  for (let n = 0; n < 20; n++) {
    await sleep(2000);
    const info = await ozon("/v1/product/import/info", { task_id: taskId });
    const items2 = info.result?.items ?? [];
    const pending = items2.some((x) => x.status === "pending" || x.status === "imported" && false);
    if (items2.length && items2.every((x) => x.status !== "pending")) {
      const errs = items2.filter((x) => (x.errors ?? []).length).map((x) => `${x.offer_id}: ${JSON.stringify(x.errors)}`);
      return { errs, statuses: items2.map((x) => x.status) };
    }
  }
  return { errs: ["timeout polling task " + taskId], statuses: [] };
}

console.log(`Режим: ${MODE.toUpperCase()}; значение ТН ВЭД ${TNVED_VALUE_ID} (6110209900)`);
const offers = await hoodieSweatOfferIds();
console.log(`HDY/SWT в Ozon: ${offers.length}`);
const need = await needTnved(offers);
console.log(`Без ТН ВЭД: ${need.length}`);
for (const x of need) console.log(`   ${x.offer_id} (type ${x.type_id})`);

if (MODE === "dry" || need.length === 0) process.exit(0);

const src = MODE === "canary" ? need.slice(0, 1) : need;
let ok = 0;
for (let i = 0; i < src.length; i += 50) {
  const batch = src.slice(i, i + 50);
  const { errs, statuses } = await importBatch(batch);
  console.log(`Импорт ${batch.length}: статусы ${JSON.stringify([...new Set(statuses)])}`);
  if (errs.length) { console.error("ОШИБКИ:", errs.join("\n  ")); process.exit(1); }
  ok += batch.length;
}
// verify
const stillEmpty = (await needTnved(src.map((x) => x.offer_id))).length;
console.log(`Отправлено: ${ok}; ещё без ТН ВЭД после: ${stillEmpty}`);
console.log(MODE === "canary" ? "Канарейка ок — запусти --full." : "Готово.");
