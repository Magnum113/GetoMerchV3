import "server-only";

// Server-only helpers for KOMUI migration API. NEVER import this from
// client components — the bearer token and Basic-Auth credentials must stay
// on the server.

export type KomuiFetchInit = {
  method: "GET" | "POST";
  path: string; // e.g. "/admin/ozon/products/import-preview"
  body?: unknown;
  idempotencyKey?: string;
};

function readEnv(): { baseUrl: string; token: string; basicAuth: string | null } {
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

function buildHeaders(opts: { hasBody: boolean; idempotencyKey?: string }) {
  const { token, basicAuth } = readEnv();
  // API-токен передаём в собственном заголовке X-Komui-Admin-Token, чтобы он
  // не конфликтовал с Authorization, который на staging занят Basic Auth.
  // Backend KOMUI читает токен именно из этого заголовка.
  const headers: Record<string, string> = {
    "X-Komui-Admin-Token": token,
    Accept: "application/json",
  };
  if (opts.hasBody) headers["Content-Type"] = "application/json";
  if (opts.idempotencyKey) headers["X-Idempotency-Key"] = opts.idempotencyKey;

  if (basicAuth) {
    const b64 = Buffer.from(basicAuth, "utf8").toString("base64");
    headers["Authorization"] = `Basic ${b64}`;
  } else {
    // На проде без Basic Auth прокси API всё равно ожидает Bearer как fallback —
    // оставляем его, если staging-логин не настроен.
    headers["Authorization"] = `Bearer ${token}`;
  }
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
