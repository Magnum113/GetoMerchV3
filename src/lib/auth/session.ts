const encoder = new TextEncoder();

export type AdminSessionPayload = {
  sub: "owner";
  iat: number;
  exp: number;
};

export function getAuthCookieName() {
  return process.env.ADMIN_AUTH_COOKIE_NAME || "getomerch_admin_session";
}

export function getSessionMaxAgeSeconds() {
  const days = Number(process.env.ADMIN_AUTH_SESSION_DAYS || "60");
  const safeDays = Number.isFinite(days) && days > 0 ? days : 60;
  return Math.floor(safeDays * 24 * 60 * 60);
}

export function createSessionPayload(nowSeconds = currentUnixSeconds()): AdminSessionPayload {
  return {
    sub: "owner",
    iat: nowSeconds,
    exp: nowSeconds + getSessionMaxAgeSeconds(),
  };
}

export async function signSession(payload: AdminSessionPayload, secret: string) {
  const body = base64UrlEncodeString(JSON.stringify(payload));
  const signature = await hmacSha256(body, secret);
  return `${body}.${signature}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string | undefined,
  nowSeconds = currentUnixSeconds(),
) {
  if (!token || !secret) return false;

  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return false;

  const expectedSignature = await hmacSha256(body, secret);
  if (!constantTimeEqual(signature, expectedSignature)) return false;

  let payload: AdminSessionPayload;
  try {
    payload = JSON.parse(base64UrlDecodeString(body)) as AdminSessionPayload;
  } catch {
    return false;
  }

  return payload.sub === "owner" && Number.isFinite(payload.exp) && payload.exp > nowSeconds;
}

function currentUnixSeconds() {
  return Math.floor(Date.now() / 1000);
}

async function hmacSha256(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

function base64UrlEncodeString(value: string) {
  return base64UrlEncodeBytes(encoder.encode(value));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecodeString(value: string) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}
