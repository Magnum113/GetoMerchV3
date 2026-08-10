"use client";

type ErrorPayload = {
  ok?: false;
  error?: { message?: string };
};

export async function postMarkingMutation<T = unknown>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as (
    { ok?: true; data?: T } & ErrorPayload
  ) | null;
  if (!response.ok || !payload?.ok) {
    throw new Error(
      payload?.error?.message ?? `Ошибка операции (${response.status})`,
    );
  }
  return payload.data as T;
}

export async function downloadMarkingLabel(input: {
  assignmentId: string;
  expectedRevision: number;
  postingNumber: string | null;
  unitOrdinal: number;
}) {
  const response = await fetch(
    `/api/admin/marking/assignments/${input.assignmentId}/label`,
    {
      method: "POST",
      headers: mutationHeaders(),
      body: JSON.stringify({ expectedRevision: input.expectedRevision }),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ErrorPayload | null;
    throw new Error(
      payload?.error?.message ?? `Ошибка формирования этикетки (${response.status})`,
    );
  }
  if (response.headers.get("content-type") !== "application/pdf") {
    throw new Error("Сервер вернул некорректный формат этикетки");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const posting = safeFilenamePart(input.postingNumber ?? "order");
  anchor.href = objectUrl;
  anchor.download = `marking-label-${posting}-${input.unitOrdinal}.pdf`;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  return {
    assignmentRevision: Number(
      response.headers.get("x-marking-assignment-revision"),
    ),
    renderCount: Number(response.headers.get("x-marking-render-count")),
  };
}

function mutationHeaders() {
  return {
    "Content-Type": "application/json",
    "X-Idempotency-Key": crypto.randomUUID(),
    "X-Request-ID": crypto.randomUUID(),
  };
}

function safeFilenamePart(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return normalized || "order";
}
