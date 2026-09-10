import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse, adminJson } from "@/lib/admin/http";
import { loadAnalyticsDashboard } from "@/lib/analytics-dashboard-server";

export const dynamic = "force-dynamic";

const MAX_PERIOD_MS = 370 * 24 * 60 * 60 * 1_000;

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession();
    const filter = parsePeriod(request.nextUrl.searchParams);
    const { snapshot, timing } = await loadAnalyticsDashboard(filter);

    return adminJson(
      { data: snapshot, meta: { timing } },
      {
        headers: {
          "Cache-Control": "private, no-store",
          "Server-Timing": [
            `db;dur=${timing.databaseMs}`,
            `calculate;dur=${timing.calculationMs}`,
            `total;dur=${timing.totalMs}`,
          ].join(", "),
        },
      },
    );
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function parsePeriod(params: URLSearchParams) {
  const from = parseDate(params.get("from"), "from");
  const to = parseDate(params.get("to"), "to");
  const duration = to.getTime() - from.getTime();

  if (duration <= 0) {
    throw new AdminApiError(400, "bad_request", "Дата окончания периода должна быть позже даты начала.");
  }
  if (duration > MAX_PERIOD_MS) {
    throw new AdminApiError(400, "bad_request", "Период аналитики не может превышать 370 дней.");
  }

  return { from, to };
}

function parseDate(value: string | null, name: string) {
  if (!value) {
    throw new AdminApiError(400, "bad_request", `Не указан параметр ${name}.`);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new AdminApiError(400, "bad_request", `Некорректный параметр ${name}.`);
  }
  return date;
}
