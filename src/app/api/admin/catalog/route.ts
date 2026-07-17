import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";
import { getAdminSupabaseKeyMode } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(_request: NextRequest) {
  try {
    await requireAdminSession();
    const services = createDatabaseReadServices();
    const data = await services.catalog.listCatalog();

    return adminJson({
      data,
      meta:
        services.readSource === "supabase"
          ? { supabaseKeyMode: getAdminSupabaseKeyMode() }
          : { databaseReadSource: services.readSource, shadowSource: services.shadowSource },
    });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
