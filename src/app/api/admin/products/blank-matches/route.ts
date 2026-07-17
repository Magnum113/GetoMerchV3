import { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import {
  AdminApiError,
  adminErrorResponse,
  adminJson,
  requireUuidParam,
} from "@/lib/admin/http";
import type { BlankMatchKey } from "@/lib/db/repositories/products";
import { createDatabaseReadServices } from "@/lib/db/services/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    await requireAdminSession();
    const keys = parseKeys(await request.json().catch(() => null));
    if (keys.length === 0) return adminJson({ data: [] });
    const data = await createDatabaseReadServices().products.findBlankMatches(keys);
    return adminJson({ data });
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

function blankKey(product: BlankMatchKey) {
  return `${product.category_id}|${product.fabric_id}|${product.color_id}|${product.size_id}`;
}
