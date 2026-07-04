import "server-only";

import { cookies } from "next/headers";
import { KOMUI_TARGET_COOKIE, type KomuiTarget, normalizeKomuiTarget } from "./target";

// Server-only helpers for KOMUI migration API. NEVER import this from
// client components — the bearer token and Basic-Auth credentials must stay
// on the server.

export type KomuiFetchInit = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string; // e.g. "/admin/ozon/products/import-preview"
  body?: unknown;
  idempotencyKey?: string;
};

type KomuiEnv = {
  target: KomuiTarget;
  baseUrl: string;
  token: string;
  basicAuth: string | null;
};

function targetFromBaseUrl(baseUrl: string | undefined): "prod" | "stage" | "custom" {
  if (!baseUrl) return "custom";
  const hostname = hostnameFromBaseUrl(baseUrl);
  if (hostname === "komui.ru" || hostname === "www.komui.ru") return "prod";
  if (hostname === "stage.komui.ru" || hostname.startsWith("stage.")) return "stage";
  return "custom";
}

function fallbackTarget(): KomuiTarget {
  return targetFromBaseUrl(process.env.KOMUI_MIGRATION_API_BASE_URL) === "stage"
    ? "stage"
    : "prod";
}

async function readSelectedTarget(): Promise<KomuiTarget> {
  try {
    const store = await cookies();
    const cookieTarget = normalizeKomuiTarget(store.get(KOMUI_TARGET_COOKIE)?.value);
    if (cookieTarget) return cookieTarget;
  } catch {
    // During non-request contexts, fall back to env.
  }
  return fallbackTarget();
}

function baseUrlForTarget(target: KomuiTarget): string | undefined {
  if (target === "prod") {
    return (
      process.env.KOMUI_PROD_API_BASE_URL ||
      (targetFromBaseUrl(process.env.KOMUI_MIGRATION_API_BASE_URL) === "prod"
        ? process.env.KOMUI_MIGRATION_API_BASE_URL
        : undefined) ||
      "https://komui.ru/api"
    );
  }

  return (
    process.env.KOMUI_STAGE_API_BASE_URL ||
    (targetFromBaseUrl(process.env.KOMUI_MIGRATION_API_BASE_URL) === "stage"
      ? process.env.KOMUI_MIGRATION_API_BASE_URL
      : undefined) ||
    "https://stage.komui.ru/api"
  );
}

function tokenForTarget(target: KomuiTarget): string | undefined {
  if (target === "prod") {
    return process.env.KOMUI_PROD_ADMIN_API_TOKEN || process.env.KOMUI_ADMIN_API_TOKEN;
  }
  return process.env.KOMUI_STAGE_ADMIN_API_TOKEN || process.env.KOMUI_ADMIN_API_TOKEN;
}

function readEnv(target: KomuiTarget): KomuiEnv {
  const baseUrl = baseUrlForTarget(target);
  const token = tokenForTarget(target);
  if (!baseUrl) {
    throw new Error(`Komui ${target} API URL не настроен в .env.local`);
  }
  if (!token) {
    throw new Error(`Komui ${target} admin token не настроен в .env.local`);
  }
  const basicAuth = target === "stage" ? process.env.KOMUI_STAGE_BASIC_AUTH || null : null;
  return { target, baseUrl: baseUrl.replace(/\/$/, ""), token, basicAuth };
}

function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

export async function getKomuiConfigSummary(): Promise<{
  baseUrl: string;
  hostname: string;
  target: KomuiTarget;
  basicAuthConfigured: boolean;
  basicAuthSent: boolean;
}> {
  const target = await readSelectedTarget();
  const { baseUrl, basicAuth } = readEnv(target);
  const hostname = hostnameFromBaseUrl(baseUrl);

  return {
    baseUrl,
    hostname,
    target,
    basicAuthConfigured: !!basicAuth,
    basicAuthSent: !!basicAuth && target === "stage",
  };
}

function buildHeaders(
  env: KomuiEnv,
  opts: { hasBody: boolean; idempotencyKey?: string },
) {
  // API-токен передаём в собственном заголовке X-Komui-Admin-Token, чтобы он
  // не конфликтовал с Authorization, который на staging занят Basic Auth.
  // Backend KOMUI читает токен именно из этого заголовка.
  const headers: Record<string, string> = {
    "X-Komui-Admin-Token": env.token,
    Accept: "application/json",
  };
  if (opts.hasBody) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;

  if (env.basicAuth && env.target === "stage") {
    // На staging Authorization уже занят Basic Auth прокси (nginx). Bearer
    // сюда класть нельзя — он замаскирует Basic и фронт-прокси отдаст 401.
    const b64 = Buffer.from(env.basicAuth, "utf8").toString("base64");
    headers["Authorization"] = `Basic ${b64}`;
  }
  // На проде без Basic Auth Authorization не нужен вообще — admin token
  // backend читает из X-Komui-Admin-Token.
  return headers;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function komuiFetch({ method, path, body, idempotencyKey }: KomuiFetchInit) {
  const target = await readSelectedTarget();
  const env = readEnv(target);
  const url = `${env.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = buildHeaders(env, { hasBody: body !== undefined, idempotencyKey });

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  const json = parseBody(text);

  if (!res.ok) {
    const msg =
      (json && typeof json === "object" && "error" in json && typeof (json as { error: unknown }).error === "string"
        ? (json as { error: string }).error
        : null) ||
      (json && typeof json === "object" && "message" in json && typeof (json as { message: unknown }).message === "string"
        ? (json as { message: string }).message
        : null) ||
      text ||
      `KOMUI API ${res.status}`;
    throw new KomuiApiError(`${path}: ${msg}`, res.status);
  }

  return json;
}

// Вариант, который НЕ бросает на 2xx и 202 — нужен для runtime/fallback,
// где 202 = pending и клиент должен начать polling. Возвращает status и body
// напрямую, чтобы прокси-роут мог их передать дальше.
export async function komuiFetchRaw({ method, path, body, idempotencyKey }: KomuiFetchInit): Promise<{
  status: number;
  body: unknown;
  rawText: string;
}> {
  const target = await readSelectedTarget();
  const env = readEnv(target);
  const url = `${env.baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = buildHeaders(env, { hasBody: body !== undefined, idempotencyKey });

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  return { status: res.status, body: parseBody(text), rawText: text };
}

export class KomuiApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KomuiApiError";
    this.status = status;
  }
}
