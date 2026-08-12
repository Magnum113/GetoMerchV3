import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { queryServerDatabase } from "@/lib/db/pool";
import { OzonApiError } from "@/lib/ozon/client";
import {
  fetchOzonPackageLabels,
  ozonPackageLabelFilename,
} from "@/lib/ozon/package-label";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ orderId: string }> },
) {
  try {
    await requireAdminSession();
    const { orderId } = await context.params;
    assertUuid(orderId);
    const order = (
      await queryServerDatabase<{
        posting_number: string;
        source: string;
        status: string;
      }>(
        `
          SELECT posting_number, source, status
          FROM public.merch_ozon_orders
          WHERE id = $1::uuid
          LIMIT 1
        `,
        [orderId],
      )
    ).rows[0];
    if (!order) {
      throw new AdminApiError(404, "not_found", "Заказ Ozon не найден.");
    }
    if (order.source === "fbo") {
      throw new AdminApiError(409, "conflict", "Этикетки доступны только для заказов Ozon FBS.");
    }
    if (order.status === "cancelled") {
      throw new AdminApiError(409, "conflict", "Нельзя скачать этикетки отменённого заказа.");
    }

    const pdf = await fetchOzonPackageLabels([order.posting_number], {
      signal: request.signal,
    });
    const filename = ozonPackageLabelFilename(order.posting_number);
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
    return adminErrorResponse(publicLabelError(error));
  }
}

function assertUuid(value: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new AdminApiError(400, "bad_request", "Некорректный идентификатор заказа.");
  }
}

function publicLabelError(error: unknown) {
  if (!(error instanceof OzonApiError)) return error;
  if (error.status === 400 || error.status === 409) {
    return new AdminApiError(
      409,
      "conflict",
      "Этикетки Ozon ещё не готовы. Соберите заказ и повторите через минуту.",
      { cause: error },
    );
  }
  if (error.status === 404) {
    return new AdminApiError(
      404,
      "not_found",
      "Ozon не нашёл этикетки для этого отправления.",
      { cause: error },
    );
  }
  return new AdminApiError(
    502,
    "upstream_error",
    "Не удалось получить этикетки от Ozon. Повторите действие позже.",
    { cause: error },
  );
}
