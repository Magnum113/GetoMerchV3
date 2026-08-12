import "server-only";

import { PDFDocument } from "pdf-lib";
import { OzonApiError, ozonPostPdf } from "@/lib/ozon/client";

const POSTING_NUMBER_PATTERN = /^[0-9A-Za-z-]{3,80}$/;
const OZON_LABEL_BATCH_SIZE = 20;

export class OzonPackageLabelsNotReadyError extends Error {
  readonly postingNumbers: string[];

  constructor(postingNumbers: readonly string[]) {
    super("Ozon has not prepared every requested package label");
    this.name = "OzonPackageLabelsNotReadyError";
    this.postingNumbers = [...postingNumbers];
  }
}

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

export async function fetchOzonPackageLabelBundle(
  postingNumbers: readonly string[],
  options: { signal?: AbortSignal; attempts?: number } = {},
) {
  const normalized = normalizePostingNumbers(postingNumbers, 100);
  const pdfs: Uint8Array[] = [];
  const notReady: string[] = [];

  for (let offset = 0; offset < normalized.length; offset += OZON_LABEL_BATCH_SIZE) {
    const batch = normalized.slice(offset, offset + OZON_LABEL_BATCH_SIZE);
    const result = await fetchBatchWithDiagnostics(batch, options);
    pdfs.push(...result.pdfs);
    notReady.push(...result.notReady);
  }

  if (notReady.length > 0) {
    throw new OzonPackageLabelsNotReadyError(notReady);
  }
  if (pdfs.length === 1) return pdfs[0];
  return mergePdfDocuments(pdfs);
}

export function ozonPackageLabelBundleFilename(count: number) {
  return `ozon-labels-${count}-postings-58x40.pdf`;
}

async function fetchBatchWithDiagnostics(
  postingNumbers: string[],
  options: { signal?: AbortSignal; attempts?: number },
): Promise<{ pdfs: Uint8Array[]; notReady: string[] }> {
  try {
    return {
      pdfs: [await fetchOzonPackageLabels(postingNumbers, options)],
      notReady: [],
    };
  } catch (error) {
    if (!isLabelsNotReadyError(error)) throw error;
    if (postingNumbers.length === 1) {
      return { pdfs: [], notReady: postingNumbers };
    }
    const middle = Math.ceil(postingNumbers.length / 2);
    const left = await fetchBatchWithDiagnostics(postingNumbers.slice(0, middle), options);
    const right = await fetchBatchWithDiagnostics(postingNumbers.slice(middle), options);
    return {
      pdfs: [...left.pdfs, ...right.pdfs],
      notReady: [...left.notReady, ...right.notReady],
    };
  }
}

function isLabelsNotReadyError(error: unknown) {
  return error instanceof OzonApiError && (error.status === 400 || error.status === 409);
}

async function mergePdfDocuments(documents: readonly Uint8Array[]) {
  const target = await PDFDocument.create();
  for (const bytes of documents) {
    const source = await PDFDocument.load(bytes, { updateMetadata: false });
    const pages = await target.copyPages(source, source.getPageIndices());
    for (const page of pages) target.addPage(page);
  }
  return target.save({ useObjectStreams: false });
}

function normalizePostingNumbers(postingNumbers: readonly string[], max: number) {
  if (postingNumbers.length < 1 || postingNumbers.length > max) {
    throw new Error(`Для этикеток Ozon нужно передать от 1 до ${max} отправлений.`);
  }
  const normalized = postingNumbers.map((value) => value.trim());
  if (normalized.some((value) => !POSTING_NUMBER_PATTERN.test(value))) {
    throw new Error("Некорректный номер отправления Ozon.");
  }
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("Номера отправлений Ozon не должны повторяться.");
  }
  return normalized;
}
