import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError, adminErrorResponse } from "@/lib/admin/http";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import { getDatabaseRuntimeConfig } from "@/lib/db/config";
import { enqueueOzonJob } from "@/lib/jobs/http";

export const dynamic = "force-dynamic";

const OZON_BASE = "https://api-seller.ozon.ru";

async function ozonPost<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${OZON_BASE}${path}`, {
    method: "POST",
    headers: {
      "Client-Id": process.env.OZON_CLIEN_ID!,
      "Api-Key": process.env.OZON_API_KEY!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Ozon ${path} ${res.status}: ${await res.text()}`);
  return res.json();
}

interface OzonFinanceOperationApi {
  operation_id: number;
  operation_type: string;
  operation_type_name?: string;
  operation_date: string;
  accruals_for_sale?: number;
  sale_commission?: number;
  amount: number;
  type?: string;
  posting?: { posting_number?: string };
  items?: Array<Record<string, unknown>>;
  services?: Array<{ name: string; price: number }>;
}

interface FinanceListResponse {
  result?: {
    operations?: OzonFinanceOperationApi[];
    page_count?: number;
    row_count?: number;
  };
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Ozon allows max ~1 month per request. Walk in 28-day windows to stay safely under the limit.
function monthlyWindows(fromIso: string, toIso: string): Array<{ from: string; to: string }> {
  const windows: Array<{ from: string; to: string }> = [];
  const fromDate = new Date(fromIso);
  const toDate = new Date(toIso);
  let cur = new Date(fromDate);
  while (cur < toDate) {
    const next = new Date(cur);
    next.setUTCDate(next.getUTCDate() + 28);
    const end = next > toDate ? toDate : next;
    windows.push({ from: cur.toISOString(), to: end.toISOString() });
    cur = end;
  }
  return windows;
}

async function fetchWindow(from: string, to: string): Promise<OzonFinanceOperationApi[]> {
  const out: OzonFinanceOperationApi[] = [];
  const pageSize = 1000;
  let page = 1;
  while (page <= 100) {
    const r: FinanceListResponse = await ozonPost("/v3/finance/transaction/list", {
      filter: {
        date: { from, to },
        operation_type: [],
        posting_number: "",
        transaction_type: "all",
      },
      page,
      page_size: pageSize,
    });
    const ops = r.result?.operations ?? [];
    out.push(...ops);
    const pageCount = r.result?.page_count ?? 0;
    if (ops.length < pageSize) break;
    if (pageCount && page >= pageCount) break;
    page += 1;
  }
  return out;
}

async function fetchAllOperations(from: string, to: string): Promise<OzonFinanceOperationApi[]> {
  const windows = monthlyWindows(from, to);
  const all: OzonFinanceOperationApi[] = [];
  // Sequential — Ozon rate-limits aggressively on parallel finance calls.
  for (const w of windows) {
    const chunk = await fetchWindow(w.from, w.to);
    all.push(...chunk);
  }
  return all;
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const fromParam = url.searchParams.get("from");
    const toParam = url.searchParams.get("to");
    const dryRun = parseBoolean(url.searchParams.get("dryRun"), "dryRun");
    const to = parseIsoDate(toParam, new Date(Date.now() + 86400 * 1000), "to");
    const from = parseIsoDate(fromParam, new Date(Date.now() - 365 * 86400 * 1000), "from");
    if (new Date(from) >= new Date(to)) {
      throw new AdminApiError(400, "bad_request", "from must be earlier than to");
    }

    if (getDatabaseRuntimeConfig().writeSource === "server") {
      const queued = await enqueueOzonJob(req, {
        type: "ozon_finance_sync",
        dedupeKey: `finance:${from}:${to}:${dryRun ? "dry" : "apply"}`,
        payload: { from, to, dryRun },
        maxAttempts: 4,
      });
      return NextResponse.json({
        ok: true,
        queued: true,
        reused: queued.reused,
        jobId: queued.job.id,
        status: queued.job.status,
      }, { status: 202 });
    }

    await requireAdminSession();
    if (!process.env.OZON_API_KEY || !process.env.OZON_CLIEN_ID) {
      return NextResponse.json({ error: "OZON_API_KEY / OZON_CLIEN_ID не настроены в .env.local" }, { status: 500 });
    }

    const supabase = getAdminSupabaseClient();

    const opsRaw = await fetchAllOperations(from, to);
    // Dedupe by operation_id — windows can overlap on boundaries and the same
    // operation may also legitimately appear twice in a long page sequence.
    const opsMap = new Map<number, OzonFinanceOperationApi>();
    for (const o of opsRaw) opsMap.set(Number(o.operation_id), o);
    const ops = Array.from(opsMap.values());

    if (ops.length === 0) {
      return NextResponse.json({ ok: true, fetched: 0, created: 0, updated: 0, from, to });
    }

    const opIds = ops.map((o) => o.operation_id);
    const existingIds = new Set<number>();
    for (const ch of chunk(opIds, 500)) {
      const { data: ex, error: exErr } = await supabase
        .from("merch_ozon_finance_operations")
        .select("operation_id")
        .in("operation_id", ch);
      if (exErr) throw exErr;
      for (const r of ex ?? []) existingIds.add(Number(r.operation_id));
    }

    const now = new Date().toISOString();
    const payloads = ops.map((o) => ({
      operation_id: o.operation_id,
      operation_type: o.operation_type,
      operation_type_name: o.operation_type_name ?? null,
      operation_date: o.operation_date,
      posting_number: o.posting?.posting_number ?? null,
      accruals_for_sale: o.accruals_for_sale != null ? Number(o.accruals_for_sale) : null,
      sale_commission: o.sale_commission != null ? Number(o.sale_commission) : null,
      amount: Number(o.amount),
      services: o.services ?? null,
      items: o.items ?? null,
      raw: o as unknown as Record<string, unknown>,
      synced_at: now,
    }));

    for (const ch of chunk(payloads, 500)) {
      const { error: upErr } = await supabase
        .from("merch_ozon_finance_operations")
        .upsert(ch, { onConflict: "operation_id" });
      if (upErr) throw upErr;
    }

    let created = 0;
    for (const id of opIds) if (!existingIds.has(id)) created += 1;
    const updated = ops.length - created;

    return NextResponse.json({ ok: true, fetched: ops.length, created, updated, from, to });
  } catch (e) {
    if (e instanceof AdminApiError) return adminErrorResponse(e);
    console.error("[sync-finance]", e);
    const msg = formatError(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

function parseIsoDate(value: string | null, fallback: Date, name: string) {
  const parsed = value ? new Date(value) : fallback;
  if (!Number.isFinite(parsed.getTime())) {
    throw new AdminApiError(400, "bad_request", `${name} must be a valid date`);
  }
  return parsed.toISOString();
}

function parseBoolean(value: string | null, name: string) {
  if (value == null || value === "") return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AdminApiError(400, "bad_request", `${name} must be true or false`);
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const o = e as Record<string, unknown>;
    const m = (typeof o.message === "string" && o.message)
      || (typeof o.details === "string" && o.details)
      || (typeof o.hint === "string" && o.hint)
      || (typeof o.error === "string" && o.error);
    if (m) return typeof o.code === "string" || typeof o.code === "number" ? `[${o.code}] ${m}` : m;
    try { return JSON.stringify(o); } catch { /* ignore */ }
  }
  return String(e);
}
