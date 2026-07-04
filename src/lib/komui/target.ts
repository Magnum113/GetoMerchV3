export const KOMUI_TARGET_COOKIE = "komui_api_target";

export type KomuiTarget = "prod" | "stage";

export function normalizeKomuiTarget(value: unknown): KomuiTarget | null {
  return value === "prod" || value === "stage" ? value : null;
}
