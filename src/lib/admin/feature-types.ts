export const ADMIN_FEATURE_KEYS = ["chestny_znak"] as const;

export type AdminFeatureKey = (typeof ADMIN_FEATURE_KEYS)[number];

export type AdminFeatureFlag = {
  key: AdminFeatureKey;
  label: string;
  description: string;
  enabled: boolean;
  revision: number;
  updatedAt: string;
  updatedBy: string;
};

export type AdminFeatureSnapshot = Record<AdminFeatureKey, boolean>;

export const DEFAULT_ADMIN_FEATURES: AdminFeatureSnapshot = Object.freeze({
  chestny_znak: false,
});

export function isAdminFeatureKey(value: unknown): value is AdminFeatureKey {
  return typeof value === "string"
    && (ADMIN_FEATURE_KEYS as readonly string[]).includes(value);
}
