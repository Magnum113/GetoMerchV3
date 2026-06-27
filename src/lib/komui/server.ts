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

export async function komuiFetch({ method, path, body, idempotencyKey }: KomuiFetchInit) {
  const { baseUrl, token, basicAuth } = readEnv();
  const url = `${baseUrl}${path.startsWith("/") ? path : `/${path}`}`;

  // API-токен передаём в собственном заголовке X-Komui-Admin-Token, чтобы он
  // не конфликтовал с Authorization, который на staging занят Basic Auth.
  // Backend KOMUI читает токен именно из этого заголовка.
  const headers: Record<string, string> = {
    "X-Komui-Admin-Token": token,
    Accept: "application/json",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["X-Idempotency-Key"] = idempotencyKey;

  if (basicAuth) {
    const b64 = Buffer.from(basicAuth, "utf8").toString("base64");
    headers["Authorization"] = `Basic ${b64}`;
  } else {
    // На проде без Basic Auth прокси API всё равно ожидает Bearer как fallback —
    // оставляем его, если staging-логин не настроен.
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });

  const text = await res.text();
  let json: unknown = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response — keep as text below.
    }
  }

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

export class KomuiApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "KomuiApiError";
    this.status = status;
  }
}
