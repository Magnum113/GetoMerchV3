import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { queryServerDatabase } from "@/lib/db/pool";
import { OzonApiError } from "@/lib/ozon/client";
import {
  fetchOzonPackageLabelBundle,
  OzonPackageLabelsNotReadyError,
  ozonPackageLabelBundleFilename,
} from "@/lib/ozon/package-label";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ORDERS = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type OrderRow = {
  id: string;
  posting_number: string;
  source: string | null;
  status: string;
};

export async function POST(request: NextRequest) {
  try {
    await requireAdminSession();
    const body = await request.json().catch(() => null) as { orderIds?: unknown } | null;
    const orderIds = parseOrderIds(body?.orderIds);
    const rows = (
      await queryServerDatabase<OrderRow>(
        `
          SELECT id::text, posting_number, source, status
          FROM public.merch_ozon_orders
          WHERE id = ANY($1::uuid[])
        `,
        [orderIds],
      )
    ).rows;
    const byId = new Map(rows.map((row) => [row.id, row]));
    const orders = orderIds.map((id) => byId.get(id));
    if (orders.some((order) => !order)) {
      throw new AdminApiError(404, "not_found", "Один или несколько заказов Ozon не найдены.");
    }
    const invalid = orders.find((order) => order?.source === "fbo" || order?.status === "cancelled");
    if (invalid) {
      throw new AdminApiError(
        409,
        "conflict",
        "Этикетки можно скачать только для неотменённых заказов Ozon FBS.",
      );
    }
    const postingNumbers = orders.map((order) => order!.posting_number);
    const pdf = await fetchOzonPackageLabelBundle(postingNumbers, {
      signal: request.signal,
    });
    const filename = ozonPackageLabelBundleFilename(postingNumbers.length);
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "no-store, private",
        Pragma: "no-cache",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return adminErrorResponse(publicBundleError(error));
  }
}

function parseOrderIds(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ORDERS) {
    throw new AdminApiError(
      400,
      "bad_request",
      `Выберите от 1 до ${MAX_ORDERS} заказов.`,
    );
  }
  if (value.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))) {
    throw new AdminApiError(400, "bad_request", "Некорректный список заказов.");
  }
  if (new Set(value).size !== value.length) {
    throw new AdminApiError(400, "bad_request", "Список заказов содержит повторы.");
  }
  return value as string[];
}

function publicBundleError(error: unknown) {
  if (error instanceof OzonPackageLabelsNotReadyError) {
    const visible = error.postingNumbers.slice(0, 8).join(", ");
    const rest = error.postingNumbers.length - 8;
    return new AdminApiError(
      409,
      "conflict",
      `Ozon ещё не подготовил этикетки: ${visible}${rest > 0 ? ` и ещё ${rest}` : ""}. Соберите эти заказы и повторите через минуту.`,
      { cause: error },
    );
  }
  if (error instanceof OzonApiError) {
    return new AdminApiError(
      502,
      "upstream_error",
      "Не удалось получить комплект этикеток от Ozon. Повторите действие позже.",
      { cause: error },
    );
  }
  return error;
}
