import "server-only";

import type { NextRequest } from "next/server";
import { requireAdminSession } from "@/lib/admin/auth";
import { AdminApiError } from "@/lib/admin/http";
import type { ServerMutationContext } from "@/lib/db/mutations/runner";
import { DatabaseBusinessError } from "@/lib/db/errors";
import { MarkingConfigurationError } from "@/lib/marking/config";
import { MarkingDomainError } from "@/lib/marking/domain/errors";
import { MarkingKeyringError } from "@/lib/marking/security/keyring";

export async function requireMarkingMutationContext(
  request: NextRequest,
): Promise<ServerMutationContext> {
  const session = await requireAdminSession();
  assertSameOrigin(request);
  const idempotencyKey = request.headers.get("x-idempotency-key")?.trim() ?? "";
  if (
    idempotencyKey.length < 8
    || idempotencyKey.length > 200
    || !/^[A-Za-z0-9._:@/-]+$/.test(idempotencyKey)
  ) {
    throw new AdminApiError(
      400,
      "bad_request",
      "Missing or invalid idempotency key",
    );
  }
  const requestedId = request.headers.get("x-request-id")?.trim() ?? "";
  return {
    actor: session.sub,
    sessionId: session.sessionId,
    requestId: isUuid(requestedId) ? requestedId : crypto.randomUUID(),
    idempotencyKey,
  };
}

export function markingMutationError(error: unknown) {
  if (error instanceof AdminApiError) return error;
  if (error instanceof DatabaseBusinessError) {
    return new AdminApiError(
      error.status,
      error.status === 404
        ? "not_found"
        : error.status === 409
          ? "conflict"
          : "bad_request",
      error.publicMessage,
      { cause: error },
    );
  }
  if (error instanceof MarkingDomainError) {
    const notFound = [
      "profile_not_found",
      "code_not_found",
      "assignment_not_found",
      "return_not_found",
      "suz_order_not_found",
    ].includes(error.code);
    const conflict = [
      "profile_revision_conflict",
      "code_revision_conflict",
      "assignment_revision_conflict",
      "return_revision_conflict",
      "suz_order_revision_conflict",
    ].includes(error.code);
    const forbidden = error.code === "assignment_access_denied";
    const unavailable = error.code === "crpt_read_disabled"
      || error.code === "crpt_write_disabled"
      || error.code === "suz_write_disabled";
    return new AdminApiError(
      notFound ? 404 : conflict ? 409 : forbidden ? 403 : unavailable ? 503 : 400,
      notFound
        ? "not_found"
        : conflict
          ? "conflict"
          : forbidden
            ? "unauthorized"
            : unavailable
              ? "server_config_error"
            : "bad_request",
      error.message,
      { cause: error },
    );
  }
  if (
    error instanceof MarkingConfigurationError
    || error instanceof MarkingKeyringError
  ) {
    return new AdminApiError(
      503,
      "server_config_error",
      "Контур маркировки не настроен",
      { cause: error },
    );
  }

  const postgresCode = findPostgresCode(error);
  const mapped = POSTGRES_MARKING_ERRORS[postgresCode ?? ""];
  if (mapped) {
    return new AdminApiError(mapped.status, mapped.code, mapped.message, {
      cause: error instanceof Error ? error : undefined,
    });
  }
  return error;
}

export function requireObjectBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdminApiError(400, "bad_request", "JSON object body is required");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) {
    throw new AdminApiError(400, "bad_request", "Request body is too large");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  key: string,
): string {
  const value = body[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new AdminApiError(400, "bad_request", `${key} is required`);
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  key: string,
): string | null {
  const value = body[key];
  if (value == null || value === "") return null;
  if (typeof value !== "string") {
    throw new AdminApiError(400, "bad_request", `${key} must be a string`);
  }
  return value.trim() || null;
}

export function requiredInteger(
  body: Record<string, unknown>,
  key: string,
): number {
  const value = body[key];
  if (!Number.isSafeInteger(value)) {
    throw new AdminApiError(400, "bad_request", `${key} must be an integer`);
  }
  return value as number;
}

export function requiredBoolean(
  body: Record<string, unknown>,
  key: string,
): boolean {
  const value = body[key];
  if (typeof value !== "boolean") {
    throw new AdminApiError(400, "bad_request", `${key} must be a boolean`);
  }
  return value;
}

export function optionalObject(
  body: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value = body[key];
  if (value == null) return {};
  return requireObjectBody(value);
}

function assertSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
    || request.headers.get("host")?.trim()
    || request.nextUrl.host;
  if (!origin || !host) {
    throw new AdminApiError(403, "unauthorized", "Origin check failed");
  }
  try {
    if (new URL(origin).host !== host) {
      throw new AdminApiError(403, "unauthorized", "Origin check failed");
    }
  } catch (error) {
    if (error instanceof AdminApiError) throw error;
    throw new AdminApiError(403, "unauthorized", "Origin check failed");
  }
}

function findPostgresCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth += 1) {
    if (typeof current === "object" && "code" in current) {
      const value = String((current as { code?: unknown }).code ?? "");
      if (/^MZ[A-Z0-9]{3}$/.test(value)) return value;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(value);
}

const POSTGRES_MARKING_ERRORS: Record<
  string,
  { status: number; code: "bad_request" | "not_found" | "conflict"; message: string }
> = {
  MZ101: { status: 409, code: "conflict", message: "Профиль не подтвержден для работы" },
  MZ102: { status: 409, code: "conflict", message: "Не подтверждена связь товара и GTIN" },
  MZ103: { status: 409, code: "conflict", message: "Общий GTIN требует отдельного подтверждения" },
  MZ104: { status: 400, code: "bad_request", message: "Профиль нельзя создать для пустого изделия" },
  MZ105: { status: 409, code: "conflict", message: "Сначала подтвердите требование маркировки" },
  MZ106: { status: 409, code: "conflict", message: "Цвет или размер не совпадает с карточкой НК" },
  MZ107: { status: 409, code: "conflict", message: "Требование Ozon не совпадает с профилем" },
  MZ400: { status: 400, code: "bad_request", message: "Некорректный GTIN" },
  MZ401: { status: 404, code: "not_found", message: "Товар не найден" },
  MZ402: { status: 409, code: "conflict", message: "Сначала приостановите активный профиль" },
  MZ403: { status: 404, code: "not_found", message: "Профиль маркировки не найден" },
  MZ404: { status: 409, code: "conflict", message: "Профиль уже был изменён. Обновите страницу" },
  MZ405: { status: 409, code: "conflict", message: "GTIN имеет несовместимые атрибуты" },
  MZ406: { status: 400, code: "bad_request", message: "Некорректный рабочий статус профиля" },
  MZ407: { status: 400, code: "bad_request", message: "Некорректный состав preview" },
  MZ408: { status: 404, code: "not_found", message: "Preview не найден" },
  MZ409: { status: 409, code: "conflict", message: "Preview уже нельзя применить" },
  MZ500: { status: 400, code: "bad_request", message: "Некорректный файл импорта КМ" },
  MZ501: { status: 409, code: "conflict", message: "GTIN не подтверждён в каталоге маркировки" },
  MZ502: { status: 409, code: "conflict", message: "Для GTIN нет включённого товарного профиля" },
  MZ503: { status: 400, code: "bad_request", message: "Некорректная строка импорта КМ" },
  MZ504: { status: 400, code: "bad_request", message: "Некорректный оператор импорта" },
  MZ505: { status: 404, code: "not_found", message: "Импорт КМ не найден" },
  MZ506: { status: 409, code: "conflict", message: "Этот импорт уже нельзя применить" },
  MZ507: { status: 409, code: "conflict", message: "Срок действия preview импорта истёк" },
  MZ508: { status: 409, code: "conflict", message: "Товарный профиль больше не готов к маркировке" },
  MZ509: { status: 409, code: "conflict", message: "Конфликт версий HMAC при импорте" },
  MZ510: { status: 400, code: "bad_request", message: "Некорректные параметры карантина" },
  MZ511: { status: 404, code: "not_found", message: "Код маркировки не найден" },
  MZ512: { status: 409, code: "conflict", message: "Код уже был изменён. Обновите страницу" },
  MZ513: { status: 409, code: "conflict", message: "Код нельзя поместить в карантин из текущего состояния" },
  MZ514: { status: 400, code: "bad_request", message: "Подтвердите уничтожение всех распечатанных копий" },
  MZ515: { status: 409, code: "conflict", message: "Код не находится в карантине" },
  MZ516: { status: 400, code: "bad_request", message: "Некорректный лимит очистки staging" },
  MZ600: { status: 400, code: "bad_request", message: "Некорректные параметры назначения КМ" },
  MZ601: { status: 404, code: "not_found", message: "Строка заказа не найдена" },
  MZ602: { status: 409, code: "conflict", message: "Заказ уже нельзя подготавливать" },
  MZ603: { status: 409, code: "conflict", message: "Товар не готов к JIT-маркировке" },
  MZ604: { status: 409, code: "conflict", message: "Канал или данные Ozon не готовы к маркировке" },
  MZ605: { status: 409, code: "conflict", message: "Склад не соответствует месту изготовления" },
  MZ606: { status: 409, code: "conflict", message: "Все единицы строки заказа уже получили КМ" },
  MZ607: { status: 409, code: "conflict", message: "Для GTIN нет доступных кодов маркировки" },
  MZ608: { status: 409, code: "conflict", message: "Код успел занять другой процесс. Повторите действие" },
  MZ610: { status: 400, code: "bad_request", message: "Некорректное подтверждение нанесения КМ" },
  MZ611: { status: 404, code: "not_found", message: "Назначение КМ не найдено" },
  MZ612: { status: 409, code: "conflict", message: "Назначение уже изменилось. Обновите страницу" },
  MZ613: { status: 409, code: "conflict", message: "Назначение ещё не готово к нанесению КМ" },
  MZ614: { status: 409, code: "conflict", message: "Не найдена подходящая пустая футболка" },
  MZ615: { status: 409, code: "conflict", message: "Складская операция не соответствует единице" },
  MZ616: { status: 400, code: "bad_request", message: "Некорректная причина отмены назначения" },
  MZ617: { status: 409, code: "conflict", message: "Нанесённый КМ нельзя отвязать автоматически" },
  MZ700: { status: 400, code: "bad_request", message: "Некорректный запрос этикетки" },
  MZ701: { status: 404, code: "not_found", message: "Назначение КМ не найдено" },
  MZ702: { status: 409, code: "conflict", message: "Назначение уже изменилось. Обновите страницу" },
  MZ703: { status: 409, code: "conflict", message: "Этикетка недоступна в текущем состоянии" },
  MZ704: { status: 409, code: "conflict", message: "Привязка КМ изменилась. Обновите страницу" },
  MZ800: { status: 400, code: "bad_request", message: "Некорректные параметры пакета Ozon" },
  MZ801: { status: 404, code: "not_found", message: "Заказ для передачи КМ в Ozon не найден" },
  MZ802: { status: 409, code: "conflict", message: "Заказ не поддерживает передачу экземпляров в Ozon" },
  MZ803: { status: 409, code: "conflict", message: "Заказ Ozon уже нельзя изменять" },
  MZ804: { status: 409, code: "conflict", message: "В заказе нет товаров с обязательной маркировкой" },
  MZ805: { status: 409, code: "conflict", message: "Ozon не передал все данные экземпляров для заказа" },
  MZ806: { status: 409, code: "conflict", message: "Не для всех единиц заказа подготовлен и нанесён КМ" },
  MZ810: { status: 400, code: "bad_request", message: "Ozon вернул некорректное сопоставление экземпляров" },
  MZ811: { status: 409, code: "conflict", message: "Пакет Ozon уже нельзя сопоставлять" },
  MZ812: { status: 409, code: "conflict", message: "Количество экземпляров Ozon не совпадает с заказом" },
  MZ820: { status: 400, code: "bad_request", message: "Некорректный запрос данных для передачи в Ozon" },
  MZ821: { status: 404, code: "not_found", message: "Пакет передачи КМ в Ozon не найден" },
  MZ822: { status: 409, code: "conflict", message: "Пакет Ozon находится в несовместимом состоянии" },
  MZ823: { status: 409, code: "conflict", message: "Заказ или назначение КМ изменились. Подготовьте пакет заново" },
  MZ830: { status: 400, code: "bad_request", message: "Ozon вернул некорректный результат проверки КМ" },
  MZ831: { status: 409, code: "conflict", message: "Пакет сейчас нельзя завершить проверкой Ozon" },
  MZ832: { status: 409, code: "conflict", message: "Результат проверки Ozon не покрывает все единицы заказа" },
  MZ840: { status: 400, code: "bad_request", message: "Ozon вернул некорректный результат передачи КМ" },
  MZ841: { status: 409, code: "conflict", message: "Пакет сейчас нельзя передать в Ozon" },
  MZ850: { status: 400, code: "bad_request", message: "Ozon вернул некорректный статус экземпляров" },
  MZ851: { status: 409, code: "conflict", message: "Статус пакета Ozon сейчас нельзя обновить" },
  MZ852: { status: 409, code: "conflict", message: "Итоговый статус Ozon не содержит результат для каждой единицы" },
  MZ860: { status: 400, code: "bad_request", message: "Некорректный результат ошибки Ozon" },
  MZ861: { status: 409, code: "conflict", message: "Для пакета Ozon нельзя записать эту ошибку" },
  MZ900: { status: 400, code: "bad_request", message: "Некорректный запрос чтения ГИС МТ" },
  MZ901: { status: 400, code: "bad_request", message: "Некорректный КМ для проверки ГИС МТ" },
  MZ902: { status: 404, code: "not_found", message: "Код маркировки не найден" },
  MZ903: { status: 400, code: "bad_request", message: "Некорректный идентификатор документа ГИС МТ" },
  MZ910: { status: 400, code: "bad_request", message: "Некорректный запуск проверки ГИС МТ" },
  MZ911: { status: 404, code: "not_found", message: "Проверка ГИС МТ не найдена" },
  MZ912: { status: 409, code: "conflict", message: "Проверка ГИС МТ уже завершена" },
  MZ920: { status: 400, code: "bad_request", message: "ГИС МТ вернула некорректный результат" },
  MZ921: { status: 409, code: "conflict", message: "Проверка ГИС МТ сейчас не выполняется" },
  MZ922: { status: 400, code: "bad_request", message: "Неизвестное состояние КМ в ГИС МТ" },
  MZ930: { status: 400, code: "bad_request", message: "Некорректная ошибка проверки ГИС МТ" },
  MZ931: { status: 409, code: "conflict", message: "Проверка ГИС МТ сейчас не выполняется" },
  MZC01: { status: 400, code: "bad_request", message: "Ozon вернул некорректные данные возврата" },
  MZC10: { status: 400, code: "bad_request", message: "Некорректное подтверждение направления возврата" },
  MZC11: { status: 404, code: "not_found", message: "Возврат не найден" },
  MZC12: { status: 409, code: "conflict", message: "Возврат уже изменён. Обновите страницу" },
  MZC13: { status: 409, code: "conflict", message: "Возврат не связан с одной физической единицей" },
  MZC14: { status: 409, code: "conflict", message: "Завершённый возврат нельзя изменить" },
  MZC15: { status: 409, code: "conflict", message: "Дождитесь завершения операции ГИС МТ" },
  MZC16: { status: 409, code: "conflict", message: "После формирования документа нельзя менять признак оплаты" },
  MZC20: { status: 400, code: "bad_request", message: "Некорректный запрос возврата КМ в оборот" },
  MZC21: { status: 409, code: "conflict", message: "Сначала подтвердите направление возврата и оплату" },
  MZC22: { status: 409, code: "conflict", message: "Сначала завершите сверку исходного вывода КМ" },
  MZC23: { status: 409, code: "conflict", message: "Состояние КМ не совпадает с исходным выводом" },
  MZC24: { status: 409, code: "conflict", message: "Документ возврата нельзя заменить в текущем состоянии" },
  MZC25: { status: 404, code: "not_found", message: "Документ возврата не найден" },
  MZC26: { status: 409, code: "conflict", message: "Документ возврата находится в несовместимом состоянии" },
  MZC30: { status: 400, code: "bad_request", message: "Некорректные данные приёмки возврата" },
  MZC31: { status: 409, code: "conflict", message: "Возврат ещё не готов к физической приёмке" },
  MZC40: { status: 400, code: "bad_request", message: "Укажите подтверждения FBO и ЭДО" },
  MZC41: { status: 409, code: "conflict", message: "Возврат ещё не готов к передаче на FBO" },
  MZC50: { status: 409, code: "conflict", message: "Историю возврата нельзя изменить" },
  MZD00: { status: 400, code: "bad_request", message: "Некорректная политика пула КМ" },
  MZD01: { status: 409, code: "conflict", message: "Политика пула уже изменена. Обновите страницу" },
  MZD02: { status: 400, code: "bad_request", message: "Некорректный черновик заказа КМ" },
  MZD03: { status: 409, code: "conflict", message: "GTIN не готов к заказу кодов" },
  MZD04: { status: 409, code: "conflict", message: "Количество превышает лимит политики GTIN" },
  MZD05: { status: 400, code: "bad_request", message: "Некорректное подтверждение заказа КМ" },
  MZD06: { status: 409, code: "conflict", message: "Заказ КМ уже изменён или не является черновиком" },
  MZD07: { status: 400, code: "bad_request", message: "Некорректная отмена заказа КМ" },
  MZD08: { status: 409, code: "conflict", message: "Заказ КМ уже нельзя отменить" },
  MZD09: { status: 409, code: "conflict", message: "Заказ КМ нельзя отправить из текущего состояния" },
  MZD10: { status: 409, code: "conflict", message: "Состояние отправки заказа КМ изменилось" },
  MZD11: { status: 400, code: "bad_request", message: "СУЗ вернула некорректный статус заказа" },
  MZD12: { status: 409, code: "conflict", message: "Статус заказа КМ изменился во время проверки" },
  MZD13: { status: 400, code: "bad_request", message: "Некорректный блок кодов СУЗ" },
  MZD14: { status: 404, code: "not_found", message: "Строка заказа КМ не найдена" },
  MZD15: { status: 409, code: "conflict", message: "Количество в блоке СУЗ не совпадает с заказом" },
  MZD16: { status: 409, code: "conflict", message: "Безопасный импорт блока СУЗ не найден" },
  MZD17: { status: 409, code: "conflict", message: "Количество импортированных кодов не совпало" },
  MZD18: { status: 400, code: "bad_request", message: "Некорректный отчёт REPORT_UTILIZE" },
  MZD19: { status: 409, code: "conflict", message: "Заказ КМ не готов к подтверждению отчёта" },
  MZD20: { status: 409, code: "conflict", message: "Количество кодов в защищённом пуле не совпало" },
  MZD21: { status: 409, code: "conflict", message: "Заказ КМ ещё не ожидает отчёт о нанесении" },
  MZD22: { status: 400, code: "bad_request", message: "Некорректная остановка заказа КМ" },
  MZD23: { status: 409, code: "conflict", message: "Завершённый заказ КМ нельзя остановить" },
};
