import { NextRequest, NextResponse } from "next/server";
import { verifyAdminPassword } from "@/lib/auth/password";
import {
  createSessionPayload,
  getAuthCookieName,
  getSessionMaxAgeSeconds,
  signSession,
} from "@/lib/auth/session";

export const dynamic = "force-dynamic";

const WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILED_ATTEMPTS = 5;
const attempts = new Map<string, { failed: number; resetAt: number }>();

export async function POST(request: NextRequest) {
  const ip = clientIp(request);
  const limit = rateLimitState(ip);
  if (limit.blocked) {
    return NextResponse.json(
      { error: "Слишком много попыток. Повторите позже." },
      { status: 429 },
    );
  }

  const body = await request.json().catch(() => null);
  const password = typeof body?.password === "string" ? body.password : "";
  if (!password) {
    registerFailedAttempt(ip);
    return NextResponse.json({ error: "Введите пароль." }, { status: 400 });
  }

  const passwordHash = process.env.ADMIN_AUTH_PASSWORD_HASH;
  const cookieSecret = process.env.ADMIN_AUTH_COOKIE_SECRET;
  if (!passwordHash || !cookieSecret || passwordHash.startsWith("TODO_")) {
    return NextResponse.json(
      { error: "Авторизация не настроена на сервере." },
      { status: 500 },
    );
  }

  const ok = await verifyAdminPassword(password, passwordHash);
  if (!ok) {
    registerFailedAttempt(ip);
    return NextResponse.json({ error: "Неверный пароль." }, { status: 401 });
  }

  attempts.delete(ip);
  const token = await signSession(createSessionPayload(), cookieSecret);
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: getAuthCookieName(),
    value: token,
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: getSessionMaxAgeSeconds(),
  });
  return response;
}

function clientIp(request: NextRequest) {
  const forwardedFor = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwardedFor || request.headers.get("x-real-ip") || "unknown";
}

function rateLimitState(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { failed: 0, resetAt: now + WINDOW_MS });
    return { blocked: false };
  }
  return { blocked: current.failed >= MAX_FAILED_ATTEMPTS };
}

function registerFailedAttempt(ip: string) {
  const now = Date.now();
  const current = attempts.get(ip);
  if (!current || current.resetAt <= now) {
    attempts.set(ip, { failed: 1, resetAt: now + WINDOW_MS });
    return;
  }
  current.failed += 1;
}
