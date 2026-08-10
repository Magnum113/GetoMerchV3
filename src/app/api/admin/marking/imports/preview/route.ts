import { NextRequest } from "next/server";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { MARKING_IMPORT_MAX_BYTES } from "@/lib/marking/domain/code-pool";
import {
  markingMutationError,
  requireMarkingMutationContext,
} from "@/lib/marking/http";
import { previewMarkingCodeImport } from "@/lib/marking/services/code-pool-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const context = await requireMarkingMutationContext(request);
    const contentLength = request.headers.get("content-length");
    if (
      contentLength
      && (
        !/^\d+$/.test(contentLength)
        || Number(contentLength) < 1
        || Number(contentLength) > MARKING_IMPORT_MAX_BYTES
      )
    ) {
      throw new AdminApiError(413, "bad_request", "Файл импорта слишком большой");
    }
    const expectedGtin = request.headers.get("x-marking-expected-gtin")?.trim() ?? "";
    const filenameHeader = request.headers.get("x-marking-filename")?.trim() ?? "";
    const acquisitionMode = request.headers.get("x-marking-acquisition-mode")?.trim()
      || "own_suz_emission";
    const data = await previewMarkingCodeImport({
      body: request.body,
      expectedGtin,
      filename: decodeFilename(filenameHeader),
      contentType: request.headers.get("content-type"),
      acquisitionMode: acquisitionMode as "own_suz_emission" | "remarking",
    }, context);
    return adminJson({ data });
  } catch (error) {
    return adminErrorResponse(markingMutationError(error));
  }
}

function decodeFilename(value: string) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    throw new AdminApiError(400, "bad_request", "Некорректное имя файла");
  }
}
