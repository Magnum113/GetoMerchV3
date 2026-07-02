import { NextResponse } from "next/server";
import { createOzonImportPreview } from "@/lib/ozon-import";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const preview = await createOzonImportPreview();
    return NextResponse.json(preview);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
