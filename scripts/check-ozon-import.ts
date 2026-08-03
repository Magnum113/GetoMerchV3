#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildItemPlan,
  type Catalog,
  type CatalogRow,
  type OzonProduct,
} from "@/lib/ozon-import";

const category = row("category-tshirt", "Футболка", { slug: "tshirt" });
const fabric = row("fabric-regular", "Обычная", { slug: "reg" });
const color = row("color-black", "Чёрный");
const size = row("size-l", "L");
const decoration = row("decoration-print", "Принт", { slug: "print" });
const design = row("design-d1", "Принт D1", { code: "D1", type: "print" });
const product = {
  id: "product-d1-black-l",
  category_id: category.id,
  fabric_id: fabric.id,
  color_id: color.id,
  size_id: size.id,
  design_id: design.id,
  decoration_type_id: decoration.id,
  sku: "D1-TSH-PRT-BLK-L",
  ozon_sku: "3298863962",
  legacy_skus: [],
  design_version: "V01",
  hoodie_fit: null,
  hoodie_fabric: null,
  is_blank: false,
  sale_price: 6700,
};
const catalog: Catalog = {
  categoriesBySlug: new Map([["tshirt", category]]),
  fabricsBySlug: new Map([["reg", fabric]]),
  colorsByCode: new Map([["BLK", color]]),
  sizesByName: new Map([["L", size]]),
  decorationBySlug: new Map([["print", decoration]]),
  designsByCodeType: new Map([["D1|print", design]]),
  productsBySku: new Map([[product.sku, product]]),
  productsByLegacySku: new Map(),
  productsByOzonSku: new Map([[product.ozon_sku, product]]),
};
const ozon: OzonProduct = {
  offerId: product.sku,
  productId: 123456789,
  ozonSku: 3298863962,
  name: "Футболка с принтом D1 чёрная L",
  salePrice: 6700,
  oldPrice: null,
  minPrice: null,
  primaryImageUrl: null,
  imageUrls: [],
  raw: {},
};

const equal = buildItemPlan(ozon, catalog);
assert.equal(equal.status, "noop");
assert.deepEqual(equal.errors, []);

const changed = buildItemPlan({ ...ozon, ozonSku: 3298863963 }, catalog);
assert.equal(changed.status, "conflict");
assert.match(changed.errors[0] ?? "", /уже не совпадает/);

console.log("Ozon import bigint SKU normalization checks passed");

function row(
  id: string,
  name: string,
  extra: Partial<CatalogRow> = {},
): CatalogRow {
  return { id, name, ...extra };
}
