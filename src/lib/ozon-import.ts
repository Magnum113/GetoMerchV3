import "server-only";

import { getAdminSupabaseClient } from "@/lib/supabase/server";
import { ozonPost as resilientOzonPost } from "@/lib/ozon/client";

type JsonObject = Record<string, unknown>;

export type CatalogRow = {
  id: string;
  name: string;
  slug?: string;
  code?: string | null;
  type?: string;
  sort_order?: number;
};

type ProductRow = {
  id: string;
  category_id: string;
  fabric_id: string;
  color_id: string;
  size_id: string;
  design_id: string | null;
  decoration_type_id: string | null;
  sku: string | null;
  ozon_sku: number | null;
  legacy_skus: string[] | null;
  design_version: string | null;
  hoodie_fit: string | null;
  hoodie_fabric: string | null;
  is_blank: boolean;
  sale_price: number | string | null;
};

type OzonInfoItem = {
  id?: number | string;
  product_id?: number | string;
  offer_id?: string;
  sku?: number | string;
  sources?: { sku?: number | string }[];
  name?: string;
  archived?: boolean;
  visible?: boolean;
  primary_image?: string | string[];
  images?: string[];
  marketing_price?: string | number;
  price?: string | number;
  old_price?: string | number;
};

type OzonPriceItem = {
  offer_id?: string;
  product_id?: number | string;
  price?: {
    price?: number | string;
    old_price?: number | string;
    min_price?: number | string;
    marketing_seller_price?: number | string;
  };
};

export type OzonProduct = {
  offerId: string;
  productId: number | null;
  ozonSku: number | null;
  name: string;
  salePrice: number | null;
  oldPrice: number | null;
  minPrice: number | null;
  primaryImageUrl: string | null;
  imageUrls: string[];
  raw: JsonObject;
};

export type ParsedOffer = {
  designCode: string;
  garmentCode: string;
  decorCode: string;
  colorCode: string;
  rawSize: string;
  sizeName: string;
  categorySlug: string;
  fabricSlug: string;
  decorationSlug: "print" | "embroidery";
  designType: "print" | "embroidery";
  hoodieFit: string | null;
  hoodieFabric: string | null;
};

export type ImportAction =
  | { type: "create_design"; code: string; designType: "print" | "embroidery"; name: string; imageUrl: string | null }
  | { type: "create_product"; payload: ProductInsertPlan }
  | { type: "update_product"; productId: string; patch: ProductUpdatePlan };

export type ProductInsertPlan = {
  sku: string;
  ozonSku: number | null;
  categoryId: string;
  fabricId: string;
  colorId: string;
  sizeId: string;
  designCode: string;
  designType: "print" | "embroidery";
  decorationTypeId: string;
  salePrice: number | null;
  designVersion: string;
  hoodieFit: string | null;
  hoodieFabric: string | null;
};

export type ProductUpdatePlan = {
  sku?: string;
  addLegacySku?: string;
  ozonSku?: number;
  salePrice?: number | null;
};

export type OzonImportItem = {
  id?: string;
  offerId: string;
  ozonProductId: number | null;
  ozonSku: number | null;
  ozonName: string;
  status: "new_design" | "new_product" | "update" | "noop" | "conflict" | "skipped" | "applied" | "error";
  severity: "info" | "warning" | "error";
  matchReason: "ozon_sku" | "offer_id" | "legacy_sku" | "none";
  targetProductId: string | null;
  parsed: ParsedOffer | null;
  actions: ImportAction[];
  errors: string[];
  warnings: string[];
  raw: JsonObject;
};

export type OzonImportSummary = {
  totalOzonItems: number;
  createDesigns: number;
  createProducts: number;
  updateProducts: number;
  noop: number;
  conflicts: number;
  skipped: number;
  actionable: number;
};

export type OzonImportPreview = {
  runId: string;
  createdAt: string;
  summary: OzonImportSummary;
  items: OzonImportItem[];
  designSuggestions: DesignSuggestion[];
  canApply: boolean;
};

export type DesignSuggestion = {
  key: string;
  code: string;
  designType: "print" | "embroidery";
  name: string;
  imageUrl: string | null;
  offers: string[];
};

export type OzonImportApplyResult = {
  runId: string;
  status: "applied" | "partial" | "failed";
  summary: {
    createdDesigns: number;
    createdProducts: number;
    updatedProducts: number;
    skipped: number;
    errors: number;
  };
  errors: { offerId: string; message: string }[];
};

type DesignOverride = {
  name?: string;
  imageUrl?: string | null;
};

export type Catalog = {
  categoriesBySlug: Map<string, CatalogRow>;
  fabricsBySlug: Map<string, CatalogRow>;
  colorsByCode: Map<string, CatalogRow>;
  sizesByName: Map<string, CatalogRow>;
  decorationBySlug: Map<string, CatalogRow>;
  designsByCodeType: Map<string, CatalogRow>;
  productsBySku: Map<string, ProductRow>;
  productsByLegacySku: Map<string, ProductRow>;
  productsByOzonSku: Map<string, ProductRow>;
};

function supabase() {
  return getAdminSupabaseClient();
}

function asArray<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function numberOrNull(value: unknown): number | null {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export async function fetchOzonProducts(options: {
  signal?: AbortSignal;
  onProgress?: (progress: Record<string, unknown>) => void | Promise<void>;
} = {}): Promise<OzonProduct[]> {
  const offerIds: string[] = [];
  let lastId = "";
  const seenLastIds = new Set<string>();
  for (let page = 1; page <= 10_000; page += 1) {
    const r = await resilientOzonPost<{ result?: { items?: { offer_id?: string }[]; last_id?: string } }>("/v3/product/list", {
      filter: { visibility: "ALL" },
      last_id: lastId,
      limit: 1000,
    }, { signal: options.signal });
    const items = r.result?.items ?? [];
    for (const item of items) if (item.offer_id) offerIds.push(String(item.offer_id));
    await options.onProgress?.({ phase: "fetch_product_ids", page, fetched: offerIds.length });
    const nextLastId = r.result?.last_id ?? "";
    if (!nextLastId || items.length === 0) break;
    if (seenLastIds.has(nextLastId)) throw new Error("Ozon product pagination cursor repeated");
    seenLastIds.add(nextLastId);
    lastId = nextLastId;
    if (page === 10_000) throw new Error("Ozon product pagination exceeded safety guard");
  }

  const infoByOffer = new Map<string, OzonInfoItem>();
  const offerChunks = chunks(offerIds, 1000);
  for (let index = 0; index < offerChunks.length; index += 1) {
    const part = offerChunks[index];
    const r = await resilientOzonPost<{ items?: OzonInfoItem[]; result?: { items?: OzonInfoItem[] } }>("/v3/product/info/list", {
      offer_id: part,
    }, { signal: options.signal });
    for (const item of r.items ?? r.result?.items ?? []) {
      if (item.offer_id) infoByOffer.set(String(item.offer_id), item);
    }
    await options.onProgress?.({ phase: "fetch_product_info", batch: index + 1, batches: offerChunks.length });
  }

  const priceByOffer = new Map<string, OzonPriceItem>();
  let cursor = "";
  const seenPriceCursors = new Set<string>();
  for (let page = 1; page <= 10_000; page += 1) {
    const r = await resilientOzonPost<{ items?: OzonPriceItem[]; cursor?: string }>("/v5/product/info/prices", {
      filter: { visibility: "ALL" },
      cursor,
      limit: 1000,
    }, { signal: options.signal });
    const items = r.items ?? [];
    for (const item of items) if (item.offer_id) priceByOffer.set(String(item.offer_id), item);
    await options.onProgress?.({ phase: "fetch_product_prices", page, fetched: priceByOffer.size });
    const nextCursor = r.cursor ?? "";
    if (!nextCursor) break;
    if (seenPriceCursors.has(nextCursor)) throw new Error("Ozon import price cursor repeated");
    seenPriceCursors.add(nextCursor);
    cursor = nextCursor;
    if (page === 10_000) throw new Error("Ozon import price pagination exceeded safety guard");
  }

  return offerIds.map((offerId) => {
    const info = infoByOffer.get(offerId) ?? {};
    const price = priceByOffer.get(offerId)?.price ?? {};
    const images = asArray(info.images).filter(Boolean);
    const primary = Array.isArray(info.primary_image) ? info.primary_image[0] : info.primary_image;
    const ozonSku = numberOrNull(info.sku) ?? numberOrNull(info.sources?.map((s) => s.sku).find(Boolean));
    const productId = numberOrNull(info.id ?? info.product_id ?? priceByOffer.get(offerId)?.product_id);
    return {
      offerId,
      productId,
      ozonSku,
      name: String(info.name ?? ""),
      salePrice: numberOrNull(price.marketing_seller_price) ?? numberOrNull(price.price) ?? numberOrNull(info.price),
      oldPrice: numberOrNull(price.old_price) ?? numberOrNull(info.old_price),
      minPrice: numberOrNull(price.min_price),
      primaryImageUrl: primary ? String(primary) : images[0] ?? null,
      imageUrls: images,
      raw: { info: info as JsonObject, price: price as JsonObject },
    };
  });
}

async function loadCatalog(): Promise<Catalog> {
  const sb = supabase();
  const [
    categories,
    fabrics,
    colors,
    sizes,
    decorations,
    designs,
    products,
  ] = await Promise.all([
    sb.from("merch_product_categories").select("*"),
    sb.from("merch_fabric_types").select("*"),
    sb.from("merch_colors").select("*"),
    sb.from("merch_sizes").select("*"),
    sb.from("merch_decoration_types").select("*"),
    sb.from("merch_designs").select("*"),
    sb.from("merch_products").select("id, category_id, fabric_id, color_id, size_id, design_id, decoration_type_id, sku, ozon_sku, legacy_skus, design_version, hoodie_fit, hoodie_fabric, is_blank, sale_price"),
  ]);

  for (const result of [categories, fabrics, colors, sizes, decorations, designs, products]) {
    if (result.error) throw new Error(result.error.message);
  }

  const colorCodeByName: Record<string, string> = {
    "Чёрный": "BLK",
    "Черный": "BLK",
    "Белый": "WHT",
    "Серый": "WGRY",
    "Бежевый": "WBEG",
    "Синий": "BLU",
  };
  const colorRows = (colors.data ?? []) as CatalogRow[];
  const colorsByCode = new Map(colorRows.map((row) => [colorCodeByName[row.name] ?? row.name.toUpperCase(), row]));
  const blue = colorRows.find((row) => row.name === "Синий");
  if (blue) colorsByCode.set("WBLU", blue);

  const productsBySku = new Map<string, ProductRow>();
  const productsByLegacySku = new Map<string, ProductRow>();
  const productsByOzonSku = new Map<string, ProductRow>();
  for (const product of (products.data ?? []) as ProductRow[]) {
    if (product.sku) productsBySku.set(product.sku, product);
    for (const legacy of product.legacy_skus ?? []) productsByLegacySku.set(legacy, product);
    if (product.ozon_sku) productsByOzonSku.set(String(product.ozon_sku), product);
  }

  return {
    categoriesBySlug: new Map(((categories.data ?? []) as CatalogRow[]).map((row) => [String(row.slug), row])),
    fabricsBySlug: new Map(((fabrics.data ?? []) as CatalogRow[]).map((row) => [String(row.slug), row])),
    colorsByCode,
    sizesByName: new Map(((sizes.data ?? []) as CatalogRow[]).map((row) => [row.name, row])),
    decorationBySlug: new Map(((decorations.data ?? []) as CatalogRow[]).map((row) => [String(row.slug), row])),
    designsByCodeType: new Map(((designs.data ?? []) as CatalogRow[])
      .filter((row) => row.code && row.type)
      .map((row) => [`${row.code}|${row.type}`, row])),
    productsBySku,
    productsByLegacySku,
    productsByOzonSku,
  };
}

const SIZE_ALIASES: Record<string, string> = {
  "2XL": "XXL",
  "3XL": "XXXL",
};

function parseOfferId(offerId: string): ParsedOffer | null {
  const parts = offerId.split("-");
  if (parts.length < 5) return null;
  const [designCode, garmentCode, decorCode] = parts;
  if (!/^D\d+$/.test(designCode)) return null;

  let colorCode = "";
  let rawSize = "";
  let hoodieFit: string | null = null;
  let hoodieFabric: string | null = null;

  if (garmentCode === "HDY") {
    if (parts.length !== 7) return null;
    colorCode = parts[3];
    hoodieFit = parts[4];
    hoodieFabric = parts[5];
    rawSize = parts[6];
  } else {
    if (parts.length !== 5) return null;
    colorCode = parts[3];
    rawSize = parts[4];
  }

  const categorySlugByGarment: Record<string, string> = {
    TSH: "tshirt",
    HDY: "hoodie",
    SWT: "sweatshirt",
  };
  const decorationSlugByDecor: Record<string, "print" | "embroidery"> = {
    PRT: "print",
    EMB: "embroidery",
  };
  const categorySlug = categorySlugByGarment[garmentCode];
  const decorationSlug = decorationSlugByDecor[decorCode];
  if (!categorySlug || !decorationSlug) return null;

  return {
    designCode,
    garmentCode,
    decorCode,
    colorCode,
    rawSize,
    sizeName: SIZE_ALIASES[rawSize] ?? rawSize,
    categorySlug,
    fabricSlug: categorySlug === "tshirt" && (colorCode === "WGRY" || colorCode === "WBEG" || colorCode === "WBLU") ? "vrn" : "reg",
    decorationSlug,
    designType: decorationSlug,
    hoodieFit,
    hoodieFabric,
  };
}

function designKey(code: string, type: "print" | "embroidery") {
  return `${code}|${type}`;
}

function cleanDesignName(productName: string, parsed: ParsedOffer) {
  const label = parsed.designType === "print" ? "Принт" : "Вышивка";
  const fallback = `${label} ${parsed.designCode}`;
  const cleaned = productName
    .replace(/\b(размер|р-р)\s*(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/gi, "")
    .replace(/\b(XS|S|M|L|XL|XXL|XXXL|2XL|3XL)\b/g, "")
    .replace(/\b(футболка|футболку|толстовка|толстовку|худи|свитшот)\b/gi, "")
    .replace(/\b(вареная|варёная|варенка|варёнка|варенная|варёная|черная|чёрная|белая|серая|синяя|бежевая)\b/gi, "")
    .replace(/\b(черный|чёрный|белый|серый|синий|бежевый)\b/gi, "")
    .replace(/\b(с\s+принтом|с\s+вышивкой|принтом|вышивкой|принт|вышивка)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  const normalized = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return `${label} ${normalized}`;
}

function findProduct(catalog: Catalog, ozon: OzonProduct) {
  if (ozon.ozonSku) {
    const bySku = catalog.productsByOzonSku.get(String(ozon.ozonSku));
    if (bySku) return { product: bySku, reason: "ozon_sku" as const };
  }
  const byOffer = catalog.productsBySku.get(ozon.offerId);
  if (byOffer) return { product: byOffer, reason: "offer_id" as const };
  const byLegacy = catalog.productsByLegacySku.get(ozon.offerId);
  if (byLegacy) return { product: byLegacy, reason: "legacy_sku" as const };
  return { product: null, reason: "none" as const };
}

function validateParsed(catalog: Catalog, parsed: ParsedOffer) {
  const errors: string[] = [];
  const warnings: string[] = [];
  const category = catalog.categoriesBySlug.get(parsed.categorySlug);
  const fabric = catalog.fabricsBySlug.get(parsed.fabricSlug);
  const color = catalog.colorsByCode.get(parsed.colorCode);
  const size = catalog.sizesByName.get(parsed.sizeName);
  const decoration = catalog.decorationBySlug.get(parsed.decorationSlug);
  const design = catalog.designsByCodeType.get(designKey(parsed.designCode, parsed.designType));

  if (!category) errors.push(`Неизвестная категория ${parsed.garmentCode}`);
  if (!fabric) errors.push(`Неизвестный тип ткани ${parsed.fabricSlug}`);
  if (!color) errors.push(`Неизвестный цвет ${parsed.colorCode}`);
  if (!size) errors.push(`Неизвестный размер ${parsed.rawSize}`);
  if (!decoration) errors.push(`Неизвестный тип нанесения ${parsed.decorCode}`);
  if (parsed.rawSize !== parsed.sizeName) warnings.push(`Размер ${parsed.rawSize} будет сохранён как ${parsed.sizeName}`);

  return { category, fabric, color, size, decoration, design, errors, warnings };
}

function expectedMatches(product: ProductRow, expected: {
  categoryId?: string;
  fabricId?: string;
  colorId?: string;
  sizeId?: string;
  designId?: string | null;
  decorationTypeId?: string;
  hoodieFit?: string | null;
  hoodieFabric?: string | null;
}) {
  const mismatches: string[] = [];
  if (expected.categoryId && product.category_id !== expected.categoryId) mismatches.push("категория");
  if (expected.fabricId && product.fabric_id !== expected.fabricId) mismatches.push("ткань");
  if (expected.colorId && product.color_id !== expected.colorId) mismatches.push("цвет");
  if (expected.sizeId && product.size_id !== expected.sizeId) mismatches.push("размер");
  if (expected.designId && product.design_id !== expected.designId) mismatches.push("дизайн");
  if (expected.decorationTypeId && product.decoration_type_id !== expected.decorationTypeId) mismatches.push("нанесение");
  if ((expected.hoodieFit ?? null) !== (product.hoodie_fit ?? null)) mismatches.push("посадка худи");
  if ((expected.hoodieFabric ?? null) !== (product.hoodie_fabric ?? null)) mismatches.push("ткань худи");
  return mismatches;
}

export function buildItemPlan(ozon: OzonProduct, catalog: Catalog): OzonImportItem {
  const parsed = parseOfferId(ozon.offerId);
  const errors: string[] = [];
  const warnings: string[] = [];
  const actions: ImportAction[] = [];
  const { product, reason } = findProduct(catalog, ozon);

  if (!parsed) {
    return {
      offerId: ozon.offerId,
      ozonProductId: ozon.productId,
      ozonSku: ozon.ozonSku,
      ozonName: ozon.name,
      status: "conflict",
      severity: "error",
      matchReason: reason,
      targetProductId: product?.id ?? null,
      parsed: null,
      actions: [],
      errors: ["Артикул не соответствует поддерживаемому шаблону"],
      warnings: [],
      raw: ozon.raw,
    };
  }

  const refs = validateParsed(catalog, parsed);
  errors.push(...refs.errors);
  warnings.push(...refs.warnings);

  const design = refs.design ?? null;
  if (product && ozon.ozonSku && product.ozon_sku && product.ozon_sku !== ozon.ozonSku) {
    errors.push(`Ozon SKU ${ozon.ozonSku} уже не совпадает с привязанным ${product.ozon_sku}`);
  }

  if (product && errors.length === 0) {
    const mismatches = expectedMatches(product, {
      categoryId: refs.category?.id,
      fabricId: refs.fabric?.id,
      colorId: refs.color?.id,
      sizeId: refs.size?.id,
      designId: design?.id ?? null,
      decorationTypeId: refs.decoration?.id,
      hoodieFit: parsed.hoodieFit,
      hoodieFabric: parsed.hoodieFabric,
    });
    if (design && mismatches.length > 0) {
      errors.push(`Существующий SKU не совпадает по полям: ${mismatches.join(", ")}`);
    }
  }

  if (errors.length > 0) {
    return {
      offerId: ozon.offerId,
      ozonProductId: ozon.productId,
      ozonSku: ozon.ozonSku,
      ozonName: ozon.name,
      status: "conflict",
      severity: "error",
      matchReason: reason,
      targetProductId: product?.id ?? null,
      parsed,
      actions,
      errors,
      warnings,
      raw: ozon.raw,
    };
  }

  if (!design) {
    actions.push({
      type: "create_design",
      code: parsed.designCode,
      designType: parsed.designType,
      name: cleanDesignName(ozon.name, parsed),
      imageUrl: ozon.primaryImageUrl,
    });
  }

  if (!product) {
    actions.push({
      type: "create_product",
      payload: {
        sku: ozon.offerId,
        ozonSku: ozon.ozonSku,
        categoryId: refs.category!.id,
        fabricId: refs.fabric!.id,
        colorId: refs.color!.id,
        sizeId: refs.size!.id,
        designCode: parsed.designCode,
        designType: parsed.designType,
        decorationTypeId: refs.decoration!.id,
        salePrice: ozon.salePrice,
        designVersion: "V01",
        hoodieFit: parsed.hoodieFit,
        hoodieFabric: parsed.hoodieFabric,
      },
    });

    return {
      offerId: ozon.offerId,
      ozonProductId: ozon.productId,
      ozonSku: ozon.ozonSku,
      ozonName: ozon.name,
      status: actions.some((a) => a.type === "create_design") ? "new_design" : "new_product",
      severity: "info",
      matchReason: reason,
      targetProductId: null,
      parsed,
      actions,
      errors,
      warnings,
      raw: ozon.raw,
    };
  }

  const patch: ProductUpdatePlan = {};
  if (ozon.ozonSku && !product.ozon_sku) patch.ozonSku = ozon.ozonSku;
  if (ozon.salePrice != null && Number(product.sale_price ?? 0) !== ozon.salePrice) patch.salePrice = ozon.salePrice;
  if (reason === "ozon_sku" && product.sku !== ozon.offerId) {
    if (product.sku) patch.addLegacySku = product.sku;
    patch.sku = ozon.offerId;
  }
  if (Object.keys(patch).length > 0) actions.push({ type: "update_product", productId: product.id, patch });

  return {
    offerId: ozon.offerId,
    ozonProductId: ozon.productId,
    ozonSku: ozon.ozonSku,
    ozonName: ozon.name,
    status: actions.length > 0 ? "update" : "noop",
    severity: actions.length > 0 ? "info" : "info",
    matchReason: reason,
    targetProductId: product.id,
    parsed,
    actions,
    errors,
    warnings,
    raw: ozon.raw,
  };
}

export function summarize(items: OzonImportItem[]): OzonImportSummary {
  const createDesignKeys = new Set<string>();
  let createProducts = 0;
  let updateProducts = 0;
  let noop = 0;
  let conflicts = 0;
  let skipped = 0;

  for (const item of items) {
    if (item.status === "conflict") conflicts++;
    if (item.status === "skipped") skipped++;
    if (item.status === "noop") noop++;
    if (item.actions.some((a) => a.type === "create_product")) createProducts++;
    if (item.actions.some((a) => a.type === "update_product")) updateProducts++;
    for (const action of item.actions) {
      if (action.type === "create_design") createDesignKeys.add(designKey(action.code, action.designType));
    }
  }

  return {
    totalOzonItems: items.length,
    createDesigns: createDesignKeys.size,
    createProducts,
    updateProducts,
    noop,
    conflicts,
    skipped,
    actionable: createProducts + updateProducts + createDesignKeys.size,
  };
}

export function collectDesignSuggestions(items: OzonImportItem[]): DesignSuggestion[] {
  const map = new Map<string, DesignSuggestion>();
  for (const item of items) {
    for (const action of item.actions) {
      if (action.type !== "create_design") continue;
      const key = designKey(action.code, action.designType);
      const current = map.get(key);
      if (current) {
        current.offers.push(item.offerId);
      } else {
        map.set(key, {
          key,
          code: action.code,
          designType: action.designType,
          name: action.name,
          imageUrl: action.imageUrl,
          offers: [item.offerId],
        });
      }
    }
  }
  return [...map.values()].sort((a, b) => a.code.localeCompare(b.code, "en", { numeric: true }));
}

async function persistPreview(items: OzonImportItem[], summary: OzonImportSummary) {
  const sb = supabase();
  const { data: run, error: runError } = await sb
    .from("merch_ozon_import_runs")
    .insert({ status: "preview", mode: "ozon_products", summary })
    .select("id, created_at")
    .single();
  if (runError) throw new Error(runError.message);

  const rows = items.map((item) => ({
    run_id: run.id,
    offer_id: item.offerId,
    ozon_product_id: item.ozonProductId,
    ozon_sku: item.ozonSku,
    ozon_name: item.ozonName,
    status: item.status,
    severity: item.severity,
    match_reason: item.matchReason,
    target_product_id: item.targetProductId,
    parsed: item.parsed,
    plan: { actions: item.actions },
    raw: item.raw,
    errors: item.errors,
    warnings: item.warnings,
  }));

  const { data: saved, error: itemsError } = await sb
    .from("merch_ozon_import_items")
    .insert(rows)
    .select("id, offer_id");
  if (itemsError) throw new Error(itemsError.message);

  const idByOffer = new Map((saved ?? []).map((row: { id: string; offer_id: string }) => [row.offer_id, row.id]));
  const savedItems = items.map((item) => ({ ...item, id: idByOffer.get(item.offerId) }));
  return { runId: String(run.id), createdAt: String(run.created_at), items: savedItems };
}

export async function createOzonImportPreview(): Promise<OzonImportPreview> {
  const [ozonProducts, catalog] = await Promise.all([fetchOzonProducts(), loadCatalog()]);
  const items = ozonProducts
    .map((product) => buildItemPlan(product, catalog))
    .sort((a, b) => a.offerId.localeCompare(b.offerId, "en", { numeric: true }));
  const summary = summarize(items);
  const persisted = await persistPreview(items, summary);

  return {
    runId: persisted.runId,
    createdAt: persisted.createdAt,
    summary,
    items: persisted.items,
    designSuggestions: collectDesignSuggestions(items),
    canApply: summary.actionable > 0,
  };
}

export function normalizeStoredItem(row: JsonObject): OzonImportItem {
  const plan = (row.plan ?? {}) as { actions?: ImportAction[] };
  return {
    id: String(row.id),
    offerId: String(row.offer_id),
    ozonProductId: numberOrNull(row.ozon_product_id),
    ozonSku: numberOrNull(row.ozon_sku),
    ozonName: String(row.ozon_name ?? ""),
    status: String(row.status) as OzonImportItem["status"],
    severity: String(row.severity) as OzonImportItem["severity"],
    matchReason: String(row.match_reason ?? "none") as OzonImportItem["matchReason"],
    targetProductId: row.target_product_id ? String(row.target_product_id) : null,
    parsed: (row.parsed ?? null) as ParsedOffer | null,
    actions: plan.actions ?? [],
    errors: Array.isArray(row.errors) ? row.errors.map(String) : [],
    warnings: Array.isArray(row.warnings) ? row.warnings.map(String) : [],
    raw: (row.raw ?? {}) as JsonObject,
  };
}

async function loadRunItems(runId: string) {
  const sb = supabase();
  const [{ data: run, error: runError }, { data: rows, error: itemsError }] = await Promise.all([
    sb.from("merch_ozon_import_runs").select("*").eq("id", runId).single(),
    sb.from("merch_ozon_import_items").select("*").eq("run_id", runId).order("offer_id"),
  ]);
  if (runError) throw new Error(runError.message);
  if (itemsError) throw new Error(itemsError.message);
  return { run: run as JsonObject, items: ((rows ?? []) as JsonObject[]).map(normalizeStoredItem) };
}

async function getDesignId(
  code: string,
  type: "print" | "embroidery",
  overrides: Record<string, DesignOverride>,
  fallback: { name: string; imageUrl: string | null },
) {
  const sb = supabase();
  const { data: existing, error: existingError } = await sb
    .from("merch_designs")
    .select("id")
    .eq("code", code)
    .eq("type", type)
    .limit(1);
  if (existingError) throw new Error(existingError.message);
  if (existing && existing.length > 0) return { id: String(existing[0].id), created: false };

  const override = overrides[designKey(code, type)];
  const { data: inserted, error: insertError } = await sb
    .from("merch_designs")
    .insert({
      code,
      type,
      name: override?.name?.trim() || fallback.name,
      image_url: override && "imageUrl" in override ? override.imageUrl : fallback.imageUrl,
      description: "Импортировано из Ozon",
    })
    .select("id")
    .single();
  if (insertError) throw new Error(insertError.message);
  return { id: String(inserted.id), created: true };
}

function collectDesignFallbacks(items: OzonImportItem[]) {
  const map = new Map<string, { name: string; imageUrl: string | null }>();
  for (const item of items) {
    for (const action of item.actions) {
      if (action.type === "create_design") {
        map.set(designKey(action.code, action.designType), { name: action.name, imageUrl: action.imageUrl });
      }
    }
  }
  return map;
}

async function applyUpdateProduct(productId: string, patch: ProductUpdatePlan) {
  const sb = supabase();
  const update: JsonObject = {};
  if (patch.ozonSku !== undefined) update.ozon_sku = patch.ozonSku;
  if (patch.salePrice !== undefined) update.sale_price = patch.salePrice;
  if (patch.sku !== undefined) update.sku = patch.sku;

  if (patch.addLegacySku) {
    const { data: product, error } = await sb
      .from("merch_products")
      .select("legacy_skus")
      .eq("id", productId)
      .single();
    if (error) throw new Error(error.message);
    const legacy = new Set<string>(asArray((product as { legacy_skus?: string[] | null }).legacy_skus));
    legacy.add(patch.addLegacySku);
    update.legacy_skus = [...legacy];
  }

  if (Object.keys(update).length === 0) return false;
  const { error } = await sb.from("merch_products").update(update).eq("id", productId);
  if (error) throw new Error(error.message);
  return true;
}

async function applyCreateProduct(action: Extract<ImportAction, { type: "create_product" }>, designIds: Map<string, string>) {
  const sb = supabase();
  const payload = action.payload;
  const designId = designIds.get(designKey(payload.designCode, payload.designType));
  if (!designId) throw new Error(`Дизайн ${payload.designCode} ${payload.designType} не найден`);

  const existingBySku = await sb.from("merch_products").select("id").eq("sku", payload.sku).limit(1);
  if (existingBySku.error) throw new Error(existingBySku.error.message);
  if ((existingBySku.data ?? []).length > 0) return false;

  if (payload.ozonSku) {
    const existingByOzonSku = await sb.from("merch_products").select("id").eq("ozon_sku", payload.ozonSku).limit(1);
    if (existingByOzonSku.error) throw new Error(existingByOzonSku.error.message);
    if ((existingByOzonSku.data ?? []).length > 0) return false;
  }

  const { error } = await sb.from("merch_products").insert({
    category_id: payload.categoryId,
    fabric_id: payload.fabricId,
    color_id: payload.colorId,
    size_id: payload.sizeId,
    design_id: designId,
    decoration_type_id: payload.decorationTypeId,
    sku: payload.sku,
    ozon_sku: payload.ozonSku,
    sale_price: payload.salePrice,
    is_blank: false,
    design_version: payload.designVersion,
    hoodie_fit: payload.hoodieFit,
    hoodie_fabric: payload.hoodieFabric,
  });
  if (error) throw new Error(error.message);
  return true;
}

export async function applyOzonImport(runId: string, overrides: Record<string, DesignOverride> = {}): Promise<OzonImportApplyResult> {
  const sb = supabase();
  const { run, items } = await loadRunItems(runId);
  if (run.status !== "preview" && run.status !== "partial") {
    throw new Error("Этот импорт уже применён или находится в неподходящем статусе");
  }

  await sb.from("merch_ozon_import_runs").update({ status: "applying", error: null }).eq("id", runId);

  const result: OzonImportApplyResult = {
    runId,
    status: "applied",
    summary: { createdDesigns: 0, createdProducts: 0, updatedProducts: 0, skipped: 0, errors: 0 },
    errors: [],
  };

  const designFallbacks = collectDesignFallbacks(items);
  const designIds = new Map<string, string>();

  try {
    for (const [key, fallback] of designFallbacks) {
      const [code, type] = key.split("|") as [string, "print" | "embroidery"];
      const design = await getDesignId(code, type, overrides, fallback);
      designIds.set(key, design.id);
      if (design.created) result.summary.createdDesigns++;
    }

    const catalog = await loadCatalog();
    for (const [key, design] of catalog.designsByCodeType) designIds.set(key, design.id);

    for (const item of items) {
      if (item.status === "conflict" || item.status === "noop" || item.status === "skipped") {
        result.summary.skipped++;
        continue;
      }

      try {
        let changed = false;
        for (const action of item.actions) {
          if (action.type === "create_design") continue;
          if (action.type === "create_product") {
            const created = await applyCreateProduct(action, designIds);
            if (created) result.summary.createdProducts++;
            changed = changed || created;
          }
          if (action.type === "update_product") {
            const updated = await applyUpdateProduct(action.productId, action.patch);
            if (updated) result.summary.updatedProducts++;
            changed = changed || updated;
          }
        }
        await sb
          .from("merch_ozon_import_items")
          .update({ status: changed ? "applied" : "skipped", applied_at: new Date().toISOString(), apply_error: null })
          .eq("id", item.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.summary.errors++;
        result.errors.push({ offerId: item.offerId, message });
        await sb
          .from("merch_ozon_import_items")
          .update({ status: "error", apply_error: message })
          .eq("id", item.id);
      }
    }

    result.status = result.summary.errors > 0 ? "partial" : "applied";
    await sb
      .from("merch_ozon_import_runs")
      .update({ status: result.status, summary: result.summary, applied_at: new Date().toISOString() })
      .eq("id", runId);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sb.from("merch_ozon_import_runs").update({ status: "failed", error: message }).eq("id", runId);
    throw error;
  }
}
