import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { createOzonImportPreview } from "@/lib/ozon-import";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await requireAdminSession();
    const preview = await createOzonImportPreview();
    return NextResponse.json(preview);
  } catch (error) {
    if (error instanceof AdminApiError) return adminErrorResponse(error);
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
