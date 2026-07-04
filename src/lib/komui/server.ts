import "server-only";

// Server-only helpers for KOMUI migration API. NEVER import this from
// client components — the bearer token and Basic-Auth credentials must stay
// on the server.

export type KomuiFetchInit = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string; // e.g. "/admin/ozon/products/import-preview"
  body?: unknown;
  idempotencyKey?: string;
};

type KomuiEnv = { baseUrl: string; token: string; basicAuth: string | null };

function readEnv(): KomuiEnv {
  const baseUrl = process.env.KOMUI_MIGRATION_API_BASE_URL;
  const token = process.env.KOMUI_ADMIN_API_TOKEN;
  if (!baseUrl) {
    throw new Error("KOMUI_MIGRATION_API_BASE_URL не настроен в .env.local");
  }
  if (!token) {
    throw new Error("KOMUI_ADMIN_API_TOKEN не настроен в .env.local");
  }
  const basicAuth = process.env.KOMUI_STAGE_BASIC_AUTH || null;
  return { baseUrl: baseUrl.replace(/\/$/, ""), token, basicAuth };
}

function hostnameFromBaseUrl(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function isStageBaseUrl(baseUrl: string): boolean {
  const hostname = hostnameFromBaseUrl(baseUrl);
  return hostname === "stage.komui.ru" || hostname.startsWith("stage.");
}

export function getKomuiConfigSummary(): {
  baseUrl: string;
  hostname: string;
  target: "prod" | "stage" | "custom";
  basicAuthConfigured: boolean;
  basicAuthSent: boolean;
} {
  const { baseUrl, basicAuth } = readEnv();
  const hostname = hostnameFromBaseUrl(baseUrl);
  const target =
    hostname === "komui.ru" || hostname === "www.komui.ru"
      ? "prod"
      : isStageBaseUrl(baseUrl)
        ? "stage"
        : "custom";

  return {
    baseUrl,
    hostname,
    target,
    basicAuthConfigured: !!basicAuth,
    basicAuthSent: !!basicAuth && isStageBaseUrl(baseUrl),
  };
}

function buildHeaders(opts: { hasBody: boolean; idempotencyKey?: string }) {
  const { baseUrl, token, basicAuth } = readEnv();
  // API-токен передаём в собственном заголовке X-Komui-Admin-Token, чтобы он
  // не конфликтовал с Authorization, который на staging занят Basic Auth.
  // Backend KOMUI читает токен именно из этого заголовка.
  const headers: Record<string, string> = {
    "X-Komui-Admin-Token": token,
    Accept: "application/json",
  };
  if (opts.hasBody) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;

  if (basicAuth && isStageBaseUrl(baseUrl)) {
    // На staging Authorization уже занят Basic Auth прокси (nginx). Bearer
    // сюда класть нельзя — он замаскирует Basic и фронт-прокси отдаст 401.
    const b64 = Buffer.from(basicAuth, "utf8").toString("base64");
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
  const { baseUrl } = readEnv();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = buildHeaders({ hasBody: body !== undefined, idempotencyKey });

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
  const { baseUrl } = readEnv();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;
  const headers = buildHeaders({ hasBody: body !== undefined, idempotencyKey });

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
