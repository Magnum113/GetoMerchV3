import assert from "node:assert/strict";
import { buildCanonicalFinishedProductSku } from "../src/lib/catalog/product-sku";

assert.equal(buildCanonicalFinishedProductSku({
  categorySlug: "tshirt",
  fabricSlug: "reg",
  colorName: "Серый",
  sizeName: "XL",
  designCode: "D23",
  decorationSlug: "print",
}), "D23-TSH-PRT-GRY-XL");

assert.equal(buildCanonicalFinishedProductSku({
  categorySlug: "tshirt",
  fabricSlug: "vrn",
  colorName: "Серый",
  sizeName: "XXL",
  designCode: "D16",
  decorationSlug: "print",
}), "D16-TSH-PRT-WGRY-XXL");

assert.equal(buildCanonicalFinishedProductSku({
  categorySlug: "hoodie",
  fabricSlug: "reg",
  colorName: "Чёрный",
  sizeName: "M",
  designCode: "D2",
  decorationSlug: "embroidery",
  hoodieFit: "REG",
  hoodieFabric: "FLC",
}), "D2-HDY-EMB-BLK-REG-FLC-M");

assert.throws(() => buildCanonicalFinishedProductSku({
  categorySlug: "tshirt",
  fabricSlug: "reg",
  colorName: "Белый",
  sizeName: "S",
  designCode: null,
  decorationSlug: "print",
}), /код вида D16/);

console.log("ok - canonical finished product SKU checks passed");
