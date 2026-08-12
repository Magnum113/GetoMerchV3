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
  await downloadPdfResponse(
    response,
    `ozon-labels-${safeFilenamePart(input.postingNumber)}-58x40.pdf`,
  );
}

export async function downloadOzonPackageLabelBundle(input: {
  orders: readonly { id: string; postingNumber: string }[];
}) {
  const response = await fetch("/api/admin/ozon/orders/labels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ orderIds: input.orders.map((order) => order.id) }),
    cache: "no-store",
  });
  await downloadPdfResponse(
    response,
    `ozon-labels-${input.orders.length}-postings-58x40.pdf`,
  );
}

async function downloadPdfResponse(response: Response, fallbackFilename: string) {
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
  anchor.download = responseFilename(response) ?? fallbackFilename;
  anchor.hidden = true;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

function responseFilename(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? "";
  const match = disposition.match(/filename="([^"\r\n]+)"/i);
  return match?.[1] ? safeFilenamePartWithDots(match[1]) : null;
}

function safeFilenamePart(value: string) {
  return value.replace(/[^0-9A-Za-z-]+/g, "-").slice(0, 80) || "posting";
}

function safeFilenamePartWithDots(value: string) {
  return value.replace(/[^0-9A-Za-z._-]+/g, "-").slice(0, 160) || "ozon-labels.pdf";
}
