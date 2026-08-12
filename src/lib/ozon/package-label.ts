import "server-only";

import { ozonPostPdf } from "@/lib/ozon/client";

const POSTING_NUMBER_PATTERN = /^[0-9A-Za-z-]{3,80}$/;

export function fetchOzonPackageLabels(
  postingNumbers: readonly string[],
  options: { signal?: AbortSignal; attempts?: number } = {},
) {
  if (postingNumbers.length < 1 || postingNumbers.length > 20) {
    throw new Error("Для этикеток Ozon нужно передать от 1 до 20 отправлений.");
  }
  const normalized = postingNumbers.map((value) => value.trim());
  if (normalized.some((value) => !POSTING_NUMBER_PATTERN.test(value))) {
    throw new Error("Некорректный номер отправления Ozon.");
  }
  return ozonPostPdf(
    "/v2/posting/fbs/package-label",
    { posting_number: normalized },
    { signal: options.signal, attempts: options.attempts },
  );
}

export function ozonPackageLabelFilename(postingNumber: string) {
  const safePosting = postingNumber.replace(/[^0-9A-Za-z-]+/g, "-").slice(0, 80);
  return `ozon-labels-${safePosting || "posting"}-58x40.pdf`;
}
