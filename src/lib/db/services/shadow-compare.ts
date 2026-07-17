import "server-only";

import { createHash } from "node:crypto";
import {
  DatabaseContractMismatchError,
  DatabaseQueryError,
} from "@/lib/db/errors";

export type SettledShadowResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: unknown };

export function settleShadowResult<T>(promise: Promise<T>): Promise<SettledShadowResult<T>> {
  return promise.then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

export async function runShadowedRead<T>(options: {
  operation: string;
  primary: () => Promise<T>;
  shadow: (() => Promise<T>) | null;
  strict: boolean;
  normalize?: (value: T) => T;
}) {
  const normalize = options.normalize ?? ((value: T) => value);
  const shadowPromise = options.shadow
    ? settleShadowResult(options.shadow().then(normalize))
    : null;
  const result = normalize(await options.primary());
  await compareShadowResult(options.operation, result, shadowPromise, options.strict);
  return result;
}

export async function compareShadowResult<T>(
  operation: string,
  primary: T,
  shadowPromise: Promise<SettledShadowResult<T>> | null,
  strict: boolean,
) {
  if (!shadowPromise) return;

  const settled = await shadowPromise;
  if (!settled.ok) {
    console.error("[database-shadow] query failed", {
      operation,
      name: settled.error instanceof Error ? settled.error.name : "UnknownError",
    });
    if (strict) throw new DatabaseQueryError("Shadow database query failed");
    return;
  }

  const shadow = settled.value;
  const primaryHash = digest(primary);
  const shadowHash = digest(shadow);
  if (primaryHash === shadowHash) return;

  console.error("[database-shadow] contract mismatch", {
    operation,
    primaryHash,
    shadowHash,
  });
  if (strict) throw new DatabaseContractMismatchError(operation);
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && isIsoDate(value)) return new Date(value).toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalize(item)]),
    );
  }
  return value;
}

function isIsoDate(value: string) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}
