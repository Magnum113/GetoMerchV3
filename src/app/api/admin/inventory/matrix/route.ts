import { requireAdminSession } from "@/lib/admin/auth";
import { adminErrorResponse, adminJson } from "@/lib/admin/http";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireAdminSession();
    const data = await createDatabaseReadServices().inventory.getMatrix();
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
