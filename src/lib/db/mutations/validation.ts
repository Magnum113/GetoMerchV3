import "server-only";

import { DatabaseBusinessError } from "@/lib/db/errors";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function objectValue(value: unknown, name = "input") {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    invalid(`${name}: ожидался объект`);
  }
  return value as Record<string, unknown>;
}

export function uuidValue(value: unknown, name: string) {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    invalid(`${name}: некорректный идентификатор`);
  }
  return value;
}

export function stringValue(value: unknown, name: string, max = 500) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > max) {
    invalid(`${name}: некорректное значение`);
  }
  return value.trim();
}

export function optionalString(value: unknown, name: string, max = 2000) {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > max) invalid(`${name}: некорректное значение`);
  return value;
}

export function positiveInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    invalid(`${name}: требуется целое число больше нуля`);
  }
  return value;
}

export function nonZeroInteger(value: unknown, name: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value === 0) {
    invalid(`${name}: требуется ненулевое целое число`);
  }
  return value;
}

export function moneyValue(value: unknown, name: string, nullable = true) {
  if (value == null && nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    invalid(`${name}: некорректная сумма`);
  }
  return value;
}

export function dateValue(value: unknown, name: string) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    invalid(`${name}: ожидается дата YYYY-MM-DD`);
  }
  return value;
}

export function oneOf<T extends string>(value: unknown, values: readonly T[], name: string): T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    invalid(`${name}: неподдерживаемое значение`);
  }
  return value as T;
}

export function invalid(message: string): never {
  throw new DatabaseBusinessError("invalid_input", message, 400);
}

export function notFound(message: string): never {
  throw new DatabaseBusinessError("not_found", message, 404);
}

export function conflict(code: string, message: string): never {
  throw new DatabaseBusinessError(code, message, 409);
}
