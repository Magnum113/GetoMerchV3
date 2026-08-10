export const OZON_EXEMPLAR_CONTRACT_VERSION = "ozon-exemplar-2026-07-26";

export const OZON_EXEMPLAR_ENDPOINTS = Object.freeze({
  createOrGet: "/v6/fbs/posting/product/exemplar/create-or-get",
  validate: "/v5/fbs/posting/product/exemplar/validate",
  set: "/v6/fbs/posting/product/exemplar/set",
  status: "/v5/fbs/posting/product/exemplar/status",
  update: "/v1/fbs/posting/product/exemplar/update",
});

export const OZON_EXEMPLAR_STATUSES = [
  "ship_available",
  "ship_not_available",
  "validation_in_process",
  "update_available",
  "update_not_available",
] as const;

export type OzonExemplarRemoteStatus = (typeof OZON_EXEMPLAR_STATUSES)[number];
