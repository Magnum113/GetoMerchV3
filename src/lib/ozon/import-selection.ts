import type { ImportAction } from "@/lib/ozon-import";

export type OzonImportSelection = {
  createDesigns: boolean;
  createProducts: boolean;
  updateIdentifiers: boolean;
  updatePrices: boolean;
};

export const DEFAULT_OZON_IMPORT_SELECTION: OzonImportSelection = {
  createDesigns: true,
  createProducts: true,
  updateIdentifiers: true,
  updatePrices: false,
};

const SELECTION_KEYS = [
  "createDesigns",
  "createProducts",
  "updateIdentifiers",
  "updatePrices",
] as const;

const IDENTIFIER_PATCH_KEYS = new Set(["sku", "ozonSku", "addLegacySku"]);

export function parseOzonImportSelection(value: unknown): OzonImportSelection {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Ozon import selection is required");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== SELECTION_KEYS.length
    || Object.keys(input).some((key) => !SELECTION_KEYS.includes(key as keyof OzonImportSelection))
    || SELECTION_KEYS.some((key) => typeof input[key] !== "boolean")
  ) {
    throw new Error("Invalid Ozon import selection");
  }
  const selection = Object.fromEntries(
    SELECTION_KEYS.map((key) => [key, input[key]]),
  ) as OzonImportSelection;
  if (!SELECTION_KEYS.some((key) => selection[key])) {
    throw new Error("Select at least one Ozon import operation");
  }
  return selection;
}

export function selectOzonImportAction(
  action: ImportAction,
  selection: OzonImportSelection,
): ImportAction | null {
  if (action.type === "create_design") {
    return selection.createDesigns ? action : null;
  }
  if (action.type === "create_product") {
    if (!selection.createProducts) return null;
    return selection.updatePrices
      ? action
      : {
          ...action,
          payload: { ...action.payload, salePrice: null },
        };
  }
  if (action.type !== "update_product") {
    throw new Error("Unknown Ozon import action");
  }
  const patch = Object.fromEntries(
    Object.entries(action.patch).filter(([key]) => (
      (key === "salePrice" && selection.updatePrices)
      || (IDENTIFIER_PATCH_KEYS.has(key) && selection.updateIdentifiers)
    )),
  );
  return Object.keys(patch).length > 0
    ? { ...action, patch }
    : null;
}

export function selectedOzonImportActions(
  actions: ImportAction[],
  selection: OzonImportSelection,
) {
  return actions
    .map((action) => selectOzonImportAction(action, selection))
    .filter((action): action is ImportAction => action !== null);
}

export function ozonImportSelectionHasActions(
  actions: ImportAction[],
  selection: OzonImportSelection,
) {
  return selectedOzonImportActions(actions, selection).length > 0;
}
