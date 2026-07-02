import { NextResponse } from "next/server";
import { komuiFetch, KomuiApiError } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

type PreviewBody = {
  targets?: { serverPostgres?: boolean; supabase?: boolean };
  mode?: "preview";
  limit?: number;
  includeArchived?: boolean;
  updatePrices?: boolean;
};

export async function POST(req: Request) {
  try {
    let raw: PreviewBody = {};
    try {
      raw = (await req.json()) as PreviewBody;
    } catch {
      raw = {};
    }
    const body = {
      targets: {
        serverPostgres: raw.targets?.serverPostgres ?? true,
        supabase: raw.targets?.supabase ?? true,
      },
      mode: "preview" as const,
      limit: typeof raw.limit === "number" ? raw.limit : 200,
      includeArchived: Boolean(raw.includeArchived),
      updatePrices: raw.updatePrices !== false,
    };

    const data = await komuiFetch({
      method: "POST",
      path: "/admin/ozon/products/import-preview",
      body,
    });
    return NextResponse.json(data);
  } catch (e) {
    const status = e instanceof KomuiApiError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status });
  }
}
