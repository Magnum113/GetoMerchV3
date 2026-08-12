"use client";

type ErrorPayload = {
  error?: { message?: string };
};

export async function downloadOzonPackageLabels(input: {
  orderId: string;
  postingNumber: string;
}) {
  const response = await fetch(`/api/admin/ozon/orders/${input.orderId}/label`, {
    method: "GET",
    cache: "no-store",
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ErrorPayload | null;
    throw new Error(
      payload?.error?.message ?? `Не удалось скачать этикетки Ozon (${response.status})`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/pdf")) {
    throw new Error("Ozon вернул файл этикеток в неизвестном формате.");
  }
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `ozon-labels-${safeFilenamePart(input.postingNumber)}-58x40.pdf`;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function safeFilenamePart(value: string) {
  return value.replace(/[^0-9A-Za-z-]+/g, "-").slice(0, 80) || "posting";
}
