import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  adminErrorResponse,
  adminJson,
  parseLimitParam,
} from "@/lib/admin/http";
import { markingReadRepository } from "@/lib/marking/read-models/repository";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const data = await markingReadRepository.listProfileBackfills(
      parseLimitParam(request.nextUrl.searchParams.get("limit"), {
        defaultValue: 20,
        max: 100,
      }),
    );
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(error);
  }
}
