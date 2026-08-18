import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";
import { getAdminSupabaseKeyMode } from "@/lib/supabase/server";
import { getDatabaseRuntimeConfig } from "@/lib/db/config";
import { markingConfigForHealth } from "@/lib/marking/config";
import { getMaintenanceState } from "@/lib/maintenance";
import { getAdminFeatureSnapshot } from "@/lib/admin/features";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  try {
    await requireAdminSession();
    const services = createDatabaseReadServices();
    const databaseConfig = getDatabaseRuntimeConfig();
    await services.catalog.listCategories();
    const maintenance = getMaintenanceState();
    const features = await getAdminFeatureSnapshot();
    return adminJson({
      data: {
        status: "ok",
        maintenanceMode: maintenance.mode,
        maintenanceReason: maintenance.reason,
        databaseReadSource: services.readSource,
        databaseWriteSource: databaseConfig.writeSource,
        shadowSource: services.shadowSource,
        supabaseKeyMode: getAdminSupabaseKeyMode(),
        features,
        marking: markingConfigForHealth(),
      },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
