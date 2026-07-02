import { NextResponse } from "next/server";
import { komuiFetch, KomuiApiError } from "@/lib/komui/server";

export const dynamic = "force-dynamic";

type ImportBody = {
  previewId?: string;
  targets?: { serverPostgres?: boolean; supabase?: boolean };
  confirm?: boolean;
  itemIds?: string[];
  offerIds?: string[];
};

function sanitizeIds(v: unknown, maxLen: number): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter((x) => x.length > 0 && x.length <= maxLen)
    .slice(0, 10_000);
  return out.length > 0 ? out : undefined;
}

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
    const body: Record<string, unknown> = {
      previewId: raw.previewId,
      targets: {
        serverPostgres: raw.targets?.serverPostgres ?? true,
        supabase: raw.targets?.supabase ?? false,
      },
      confirm: true as const,
    };
    // Выборочный импорт: без itemIds/offerIds backend применит весь preview,
    // поэтому прокидываем только валидные непустые списки.
    const itemIds = sanitizeIds(raw.itemIds, 64);
    const offerIds = sanitizeIds(raw.offerIds, 160);
    if (itemIds) body.itemIds = itemIds;
    if (offerIds) body.offerIds = offerIds;

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
