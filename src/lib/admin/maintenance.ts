import "server-only";

import { AdminApiError } from "@/lib/admin/http";
import { getMaintenanceState } from "@/lib/maintenance";

export function assertAdminWritesEnabled() {
  const maintenance = getMaintenanceState();
  if (!maintenance.enabled) return;
  throw new AdminApiError(
    503,
    "maintenance",
    "Админка временно работает только для чтения. Повторите действие после завершения обслуживания.",
  );
}
