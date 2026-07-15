import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  requireUuidParam,
} from "@/lib/admin/http";
import { hydrateProducts } from "@/lib/admin/product-hydration";
import { getAdminSupabaseClient } from "@/lib/supabase/server";
import type { Product } from "@/lib/types";

export const dynamic = "force-dynamic";

type BlankMatchKey = {
  category_id: string;
  fabric_id: string;
  color_id: string;
  size_id: string;
};

const PAGE_SIZE = 500;
const MAX_BLANKS = 10_000;

export async function POST(request: NextRequest) {
  try {
    await requireAdminSession();
    const keys = parseKeys(await request.json().catch(() => null));
    if (keys.length === 0) return adminJson({ data: [] });

    const wanted = new Set(keys.map((key) => blankKey(key)));
    const blanks = await fetchBlankProducts();
    const matched = blanks.filter((product) => wanted.has(blankKey(product)));
    return adminJson({ data: await hydrateProducts(matched) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

function parseKeys(payload: unknown): BlankMatchKey[] {
  if (!payload || typeof payload !== "object") {
    throw new AdminApiError(400, "bad_request", "Invalid request body");
  }

  const rawKeys = (payload as { keys?: unknown }).keys;
  if (!Array.isArray(rawKeys)) {
    throw new AdminApiError(400, "bad_request", "keys must be an array");
  }
  if (rawKeys.length > 500) {
    throw new AdminApiError(400, "bad_request", "Too many blank match keys");
  }

  const unique = new Map<string, BlankMatchKey>();
  for (const raw of rawKeys) {
    if (!raw || typeof raw !== "object") {
      throw new AdminApiError(400, "bad_request", "Invalid blank match key");
    }
    const source = raw as Record<string, unknown>;
    const key = {
      category_id: requireUuidField(source.category_id, "category_id"),
      fabric_id: requireUuidField(source.fabric_id, "fabric_id"),
      color_id: requireUuidField(source.color_id, "color_id"),
      size_id: requireUuidField(source.size_id, "size_id"),
    };
    unique.set(blankKey(key), key);
  }

  return Array.from(unique.values());
}

function requireUuidField(value: unknown, name: string) {
  if (typeof value !== "string") {
    throw new AdminApiError(400, "bad_request", `Invalid ${name}`);
  }
  const parsed = requireUuidParam(value, name);
  if (!parsed) throw new AdminApiError(400, "bad_request", `Invalid ${name}`);
  return parsed;
}

async function fetchBlankProducts() {
  const out: Product[] = [];
  let offset = 0;

  while (out.length < MAX_BLANKS) {
    const { data, error } = await getAdminSupabaseClient()
      .from("merch_products")
      .select("*")
      .eq("is_blank", true)
      .order("sku", { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    assertNoSupabaseError(error);

    const page = (data ?? []) as Product[];
    out.push(...page);
    if (page.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return out;
}

function blankKey(product: BlankMatchKey) {
  return `${product.category_id}|${product.fabric_id}|${product.color_id}|${product.size_id}`;
}
