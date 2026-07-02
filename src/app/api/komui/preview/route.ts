import { NextResponse } from "next/server";
import { komuiFetch, KomuiApiError } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

type PreviewBody = {
  targets?: { serverPostgres?: boolean; supabase?: boolean };
  mode?: "preview";
  limit?: number;
  includeArchived?: boolean;
  updatePrices?: boolean;
  syncSizes?: "add" | "off";
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
        supabase: raw.targets?.supabase ?? false,
      },
      mode: "preview" as const,
      limit: typeof raw.limit === "number" ? raw.limit : 200,
      includeArchived: Boolean(raw.includeArchived),
      // Безопасный дефолт по контракту KOMUI: цены сайта не трогаем, если
      // админ явно не попросил обратного.
      updatePrices: raw.updatePrices === true,
      syncSizes: raw.syncSizes === "off" ? ("off" as const) : ("add" as const),
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
