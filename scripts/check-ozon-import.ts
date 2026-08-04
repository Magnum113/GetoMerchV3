#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  buildItemPlan,
  type ImportAction,
  type Catalog,
  type CatalogRow,
  type OzonProduct,
} from "@/lib/ozon-import";
import {
  parseOzonImportSelection,
  selectedOzonImportActions,
  type OzonImportSelection,
} from "@/lib/ozon/import-selection";

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

const allSelection: OzonImportSelection = {
  createDesigns: true,
  createProducts: true,
  updateIdentifiers: true,
  updatePrices: true,
};
const actions: ImportAction[] = [
  {
    type: "create_design",
    code: "D99",
    designType: "print",
    name: "Принт D99",
    imageUrl: null,
  },
  {
    type: "create_product",
    payload: {
      sku: "D99-TSH-PRT-BLK-L",
      ozonSku: 123,
      categoryId: category.id,
      fabricId: fabric.id,
      colorId: color.id,
      sizeId: size.id,
      designCode: "D99",
      designType: "print",
      decorationTypeId: decoration.id,
      salePrice: 8000,
      designVersion: "V01",
      hoodieFit: null,
      hoodieFabric: null,
    },
  },
  {
    type: "update_product",
    productId: product.id,
    patch: {
      sku: "D1-TSH-PRT-BLK-L",
      ozonSku: 3298863962,
      addLegacySku: "OLD-D1-L",
      salePrice: 8000,
    },
  },
];
const withoutPrices = selectedOzonImportActions(actions, {
  ...allSelection,
  updatePrices: false,
});
assert.equal(withoutPrices.length, 3);
const newProductWithoutPrice = withoutPrices.find((action) => action.type === "create_product");
assert.equal(newProductWithoutPrice?.type === "create_product" && newProductWithoutPrice.payload.salePrice, null);
const identifierOnly = withoutPrices.find((action) => action.type === "update_product");
assert.equal(identifierOnly?.type === "update_product" && "salePrice" in identifierOnly.patch, false);
assert.equal(identifierOnly?.type === "update_product" && "ozonSku" in identifierOnly.patch, true);

const pricesOnly = selectedOzonImportActions(actions, {
  createDesigns: false,
  createProducts: false,
  updateIdentifiers: false,
  updatePrices: true,
});
assert.deepEqual(pricesOnly, [{
  type: "update_product",
  productId: product.id,
  patch: { salePrice: 8000 },
}]);
assert.deepEqual(parseOzonImportSelection(allSelection), allSelection);
assert.throws(() => parseOzonImportSelection({ ...allSelection, extra: true }));
assert.throws(() => parseOzonImportSelection({
  createDesigns: false,
  createProducts: false,
  updateIdentifiers: false,
  updatePrices: false,
}));

console.log("Ozon import SKU normalization and selective-action checks passed");

function row(
  id: string,
  name: string,
  extra: Partial<CatalogRow> = {},
): CatalogRow {
  return { id, name, ...extra };
}
