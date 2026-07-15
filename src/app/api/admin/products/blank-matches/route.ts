import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  assertNoSupabaseError,
  requireUuidParam,
} from "@/lib/admin/http";
import { adminDbQuery, hasAdminPostgres } from "@/lib/admin/postgres";
import { ADMIN_PRODUCT_COLUMNS, hydrateProductsViaPostgres } from "@/lib/admin/product-postgres";
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

    if (hasAdminPostgres()) {
      return adminJson({ data: await fetchBlankProductsViaPostgres(keys) });
    }

    const wanted = new Set(keys.map((key) => blankKey(key)));
    const blanks = await fetchBlankProducts();
    const matched = blanks.filter((product) => wanted.has(blankKey(product)));
    return adminJson({ data: await hydrateProducts(matched) });
  } catch (error) {
    return adminErrorResponse(error);
  }
}

async function fetchBlankProductsViaPostgres(keys: BlankMatchKey[]) {
  const result = await adminDbQuery<Product>(
    `
      WITH wanted AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS x(
          category_id uuid,
          fabric_id uuid,
          color_id uuid,
          size_id uuid
        )
      )
      SELECT ${ADMIN_PRODUCT_COLUMNS}
      FROM merch_products p
      JOIN wanted w
        ON w.category_id = p.category_id
       AND w.fabric_id = p.fabric_id
       AND w.color_id = p.color_id
       AND w.size_id = p.size_id
      WHERE p.is_blank = true
      ORDER BY p.sku
    `,
    [JSON.stringify(keys)],
  );

  return hydrateProductsViaPostgres(result.rows);
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
