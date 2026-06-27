import { NextResponse } from "next/server";
import { komuiFetch, KomuiApiError } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

type ImportBody = {
  previewId?: string;
  targets?: { serverPostgres?: boolean; supabase?: boolean };
  confirm?: boolean;
};

export async function POST(req: Request) {
  try {
    let raw: ImportBody = {};
    try {
      raw = (await req.json()) as ImportBody;
    } catch {
      raw = {};
    }
    if (!raw.previewId) {
      return NextResponse.json({ error: "previewId обязателен" }, { status: 400 });
    }
    if (raw.confirm !== true) {
      return NextResponse.json({ error: "confirm должен быть true" }, { status: 400 });
    }
    const body = {
      previewId: raw.previewId,
      targets: {
        serverPostgres: raw.targets?.serverPostgres ?? true,
        supabase: raw.targets?.supabase ?? true,
      },
      confirm: true as const,
    };

    // Idempotency key: берём из заголовка клиента, иначе генерируем сами.
    // Server-side это нормально: ключ нужен только чтобы один и тот же click
    // не запустил job дважды.
    const idempotencyKey =
      req.headers.get("x-idempotency-key") || crypto.randomUUID();

    const data = await komuiFetch({
      method: "POST",
      path: "/admin/ozon/products/import",
      body,
      idempotencyKey,
    });
    return NextResponse.json(data);
  } catch (e) {
    const status = e instanceof KomuiApiError ? e.status : 500;
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: message }, { status });
  }
}
