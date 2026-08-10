export type MarkingRequirement = "unknown" | "required" | "not_required";

export type OzonMarkingProjection = {
  markingRequirement: MarkingRequirement;
  exemplarFlowAvailable: boolean | null;
};

export type OzonProjectedOrderItem = {
  sourceItemKey: string;
  offerId: string;
  ozonSku: string | null;
  ozonProductId: string | null;
  name: string | null;
  quantity: number;
  price: number | null;
  productId: string | null;
  markingRequirement: MarkingRequirement;
  exemplarFlowAvailable: boolean | null;
};

export function projectOzonOrderItems(input: {
  source: "fbs" | "fbo";
  products: Array<{
    offer_id: string;
    sku?: number | string;
    product_id?: number | string;
    name?: string;
    quantity: number;
    price?: string | number;
  }>;
  mandatoryProductEntries: unknown;
  possibleProductEntries?: unknown;
  productExemplars: unknown;
  productByOffer: ReadonlyMap<string, string>;
}) {
  const projected = new Map<string, OzonProjectedOrderItem>();
  for (const item of input.products) {
    const offerId = String(item.offer_id);
    const ozonSku = item.sku == null ? null : String(item.sku);
    const ozonProductId =
      item.product_id == null
        ? ozonSku
        : String(item.product_id);
    // The historical rows were keyed by offer + SKU. Keep that identity even
    // when a richer Ozon response starts returning product_id later.
    const sourceItemKey = buildOzonSourceItemKey(
      offerId,
      ozonSku ?? ozonProductId,
    );
    const marking = input.source === "fbs"
      ? projectOzonMarkingSignals({
          ozonProductId,
          mandatoryProductEntries: input.mandatoryProductEntries,
          possibleProductEntries: input.possibleProductEntries,
          productExemplars: input.productExemplars,
        })
      : {
          markingRequirement: "unknown" as const,
          exemplarFlowAvailable: null,
        };
    const existing = projected.get(sourceItemKey);
    if (existing) {
      existing.quantity += Number(item.quantity ?? 0);
      continue;
    }
    projected.set(sourceItemKey, {
      sourceItemKey,
      offerId,
      ozonSku,
      ozonProductId,
      name: item.name ?? null,
      quantity: Number(item.quantity ?? 0),
      price: item.price == null ? null : Number(item.price),
      productId: input.productByOffer.get(offerId) ?? null,
      markingRequirement: marking.markingRequirement,
      exemplarFlowAvailable: marking.exemplarFlowAvailable,
    });
  }
  return Array.from(projected.values());
}

export function buildOzonSourceItemKey(
  offerId: string,
  ozonProductId: string | null,
) {
  const offerHex = Buffer.from(offerId, "utf8").toString("hex");
  const productHex = Buffer.from(ozonProductId ?? "", "utf8").toString("hex");
  return `ozon:v1:${offerHex}:${productHex}`;
}

export function projectOzonMarkingSignals(input: {
  ozonProductId: string | null;
  mandatoryProductEntries: unknown;
  possibleProductEntries?: unknown;
  productExemplars: unknown;
}): OzonMarkingProjection {
  const productId = input.ozonProductId;
  const mandatoryIds = productIdsFromObservedArray(input.mandatoryProductEntries);
  const possibleIds = productIdsFromObservedArray(input.possibleProductEntries);
  const exemplar = matchingExemplar(input.productExemplars, productId);

  const requirementFromList =
    mandatoryIds === null || productId === null
      ? null
      : mandatoryIds.has(productId);
  const requirementFromExemplar =
    exemplar && typeof exemplar.is_mandatory_mark_needed === "boolean"
      ? exemplar.is_mandatory_mark_needed
      : null;
  const possibleFromList =
    possibleIds === null || productId === null
      ? null
      : possibleIds.has(productId);
  const possibleFromExemplar =
    exemplar && typeof exemplar.is_mandatory_mark_possible === "boolean"
      ? exemplar.is_mandatory_mark_possible
      : null;

  let markingRequirement: MarkingRequirement = "unknown";
  if (
    requirementFromList !== null
    && requirementFromExemplar !== null
    && requirementFromList !== requirementFromExemplar
  ) {
    markingRequirement = "unknown";
  } else {
    const required = requirementFromList ?? requirementFromExemplar;
    if (required === true) markingRequirement = "required";
    if (required === false) {
      // Ozon's optional list means the seller may submit a code even when the
      // posting does not require one. Expose that as an effective JIT path;
      // the downstream verified product profile remains the legal gate.
      markingRequirement = possibleFromList === true || possibleFromExemplar === true
        ? "required"
        : "not_required";
    }
    if (
      required === null
      && (possibleFromList === true || possibleFromExemplar === true)
    ) {
      markingRequirement = "required";
    }
  }

  const exemplarFlowAvailable =
    requirementFromList === true
      || requirementFromExemplar === true
      || possibleFromList === true
      || possibleFromExemplar === true
      ? true
      : possibleFromList === false || possibleFromExemplar === false
        ? false
        : null;

  return {
    markingRequirement,
    exemplarFlowAvailable,
  };
}

function productIdsFromObservedArray(value: unknown) {
  if (!Array.isArray(value)) return null;
  const ids = new Set<string>();
  for (const entry of value) {
    const id = productIdFromEntry(entry);
    if (id !== null) ids.add(id);
  }
  return ids;
}

function matchingExemplar(value: unknown, productId: string | null) {
  if (!Array.isArray(value) || productId === null) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (productIdFromEntry(record) === productId) return record;
  }
  return null;
}

function productIdFromEntry(value: unknown): string | null {
  if (typeof value === "string" || typeof value === "number") {
    const normalized = String(value).trim();
    return normalized || null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of ["product_id", "sku"]) {
    const candidate = record[key];
    if (typeof candidate === "string" || typeof candidate === "number") {
      const normalized = String(candidate).trim();
      if (normalized) return normalized;
    }
  }
  return null;
}
