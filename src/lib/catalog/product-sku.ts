export type CanonicalProductSkuInput = {
  categorySlug: string;
  fabricSlug: string;
  colorName: string;
  sizeName: string;
  designCode: string | null;
  decorationSlug: string;
  hoodieFit?: string | null;
  hoodieFabric?: string | null;
};

const GARMENT_CODES: Record<string, string> = {
  tshirt: "TSH",
  hoodie: "HDY",
  sweatshirt: "SWT",
};

const DECORATION_CODES: Record<string, string> = {
  print: "PRT",
  embroidery: "EMB",
};

const COLOR_CODES: Record<string, string> = {
  "бежевый": "BEG",
  "белый": "WHT",
  "серый": "GRY",
  "синий": "BLU",
  "черный": "BLK",
};

const WASHED_COLOR_CODES: Record<string, string> = {
  "бежевый": "WBEG",
  "серый": "WGRY",
  "синий": "WBLU",
};

export function buildCanonicalFinishedProductSku(input: CanonicalProductSkuInput) {
  const designCode = input.designCode?.trim().toUpperCase() ?? "";
  if (!/^D[1-9][0-9]*$/.test(designCode)) {
    throw new Error("У дизайна должен быть код вида D16.");
  }

  const categorySlug = input.categorySlug.trim().toLowerCase();
  const garmentCode = GARMENT_CODES[categorySlug];
  if (!garmentCode) {
    throw new Error(`Для категории «${input.categorySlug}» не задан код артикула.`);
  }

  const decorationCode = DECORATION_CODES[input.decorationSlug.trim().toLowerCase()];
  if (!decorationCode) {
    throw new Error(`Для типа нанесения «${input.decorationSlug}» не задан код артикула.`);
  }

  const normalizedColor = normalizeRussian(input.colorName);
  const colorCode = input.fabricSlug.trim().toLowerCase() === "vrn"
    ? WASHED_COLOR_CODES[normalizedColor]
    : COLOR_CODES[normalizedColor];
  if (!colorCode) {
    throw new Error(`Для цвета «${input.colorName}» не задан код артикула.`);
  }

  const size = input.sizeName.trim().toUpperCase();
  if (!/^(?:XS|S|M|L|XL|XXL|XXXL|2XL|3XL)$/.test(size)) {
    throw new Error(`Размер «${input.sizeName}» нельзя использовать в артикуле.`);
  }

  const segments = [designCode, garmentCode, decorationCode, colorCode];
  if (categorySlug === "hoodie") {
    const fit = input.hoodieFit?.trim().toUpperCase() ?? "";
    const fabric = input.hoodieFabric?.trim().toUpperCase() ?? "";
    if (!/^(?:REG|CRP)$/.test(fit) || !/^(?:FLC|NF)$/.test(fabric)) {
      throw new Error("Для худи нужно указать посадку REG/CRP и ткань FLC/NF.");
    }
    segments.push(fit, fabric);
  }
  segments.push(size);
  return segments.join("-");
}

function normalizeRussian(value: string) {
  return value.trim().toLowerCase().replaceAll("ё", "е");
}
