export type MaintenanceMode = "off" | "read_only";

export type MaintenanceState = {
  mode: MaintenanceMode;
  reason: string;
  enabled: boolean;
};

export function getMaintenanceState(
  env: Record<string, string | undefined> = process.env,
): MaintenanceState {
  const rawMode = env.GETOMERCH_MAINTENANCE_MODE?.trim().toLowerCase();
  const mode: MaintenanceMode = rawMode === "read_only" ? "read_only" : "off";
  const reason = env.GETOMERCH_MAINTENANCE_REASON?.trim() || "Техническое обслуживание";
  return { mode, reason, enabled: mode === "read_only" };
}

export function isReadOnlyMaintenance(
  env: Record<string, string | undefined> = process.env,
) {
  return getMaintenanceState(env).enabled;
}
