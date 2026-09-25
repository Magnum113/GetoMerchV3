import "server-only";

import bwipjs from "bwip-js/node";
import { PDFDocument, StandardFonts, grayscale, rgb } from "pdf-lib";
import { OzonApiError, ozonPost, ozonPostPdf } from "@/lib/ozon/client";

const POSTING_NUMBER_PATTERN = /^[0-9A-Za-z-]{3,80}$/;
const SCANIT_PATTERN = /^[0-9A-Za-z_-]{3,80}$/;
const OZON_LABEL_BATCH_SIZE = 20;
const OZON_LABEL_CONCURRENCY = 4;

type OzonPostingResponse = {
  result?: {
    scanit?: string | null;
  };
};

type LabelFetchResult = { pdf: Uint8Array } | { error: unknown };

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
  return fetchNormalizedOzonPackageLabels(normalized, options);
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
  const results = await mapWithConcurrency<string, LabelFetchResult>(
    postingNumbers,
    OZON_LABEL_CONCURRENCY,
    async (postingNumber) => {
      try {
        return { pdf: await fetchCurrentOzonPackageLabel(postingNumber, options) };
      } catch (error) {
        return { error };
      }
    },
  );
  const pdfs: Uint8Array[] = [];
  const notReady: string[] = [];
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    if ("pdf" in result) {
      pdfs.push(result.pdf);
      continue;
    }
    if (isLabelsNotReadyError(result.error)) {
      notReady.push(postingNumbers[index]);
      continue;
    }
    throw result.error;
  }
  return { pdfs, notReady };
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

async function fetchNormalizedOzonPackageLabels(
  postingNumbers: readonly string[],
  options: { signal?: AbortSignal; attempts?: number },
) {
  const documents = await mapWithConcurrency(
    postingNumbers,
    OZON_LABEL_CONCURRENCY,
    (postingNumber) => fetchCurrentOzonPackageLabel(postingNumber, options),
  );
  if (documents.length === 1) return documents[0];
  return mergePdfDocuments(documents);
}

async function fetchCurrentOzonPackageLabel(
  postingNumber: string,
  options: { signal?: AbortSignal; attempts?: number },
) {
  const [officialPdfResult, postingResult] = await Promise.allSettled([
    ozonPostPdf(
      "/v2/posting/fbs/package-label",
      { posting_number: [postingNumber] },
      { signal: options.signal, attempts: options.attempts },
    ),
    ozonPost<OzonPostingResponse>(
      "/v3/posting/fbs/get",
      {
        posting_number: postingNumber,
        with: {
          analytics_data: false,
          barcodes: true,
          financial_data: false,
          translit: false,
        },
      },
      { signal: options.signal, attempts: options.attempts },
    ),
  ]);
  if (officialPdfResult.status === "rejected") throw officialPdfResult.reason;
  if (postingResult.status === "rejected") throw postingResult.reason;
  const officialPdf = officialPdfResult.value;
  const posting = postingResult.value;
  const scanit = posting.result?.scanit?.trim() ?? "";
  if (!SCANIT_PATTERN.test(scanit)) {
    throw new OzonApiError("Ozon has not prepared the current QR label code", {
      status: 409,
      retryable: false,
      code: "ozon_label_scanit_missing",
    });
  }
  return replacePackagePage(officialPdf, scanit);
}

async function replacePackagePage(officialPdf: Uint8Array, scanit: string) {
  const source = await PDFDocument.load(officialPdf, { updateMetadata: false });
  if (source.getPageCount() < 1) {
    throw new OzonApiError("Ozon package label PDF has no pages", {
      retryable: false,
      code: "ozon_invalid_pdf",
    });
  }
  const firstPage = source.getPage(0);
  const { width, height } = firstPage.getSize();
  const target = await PDFDocument.create();
  const page = target.addPage([width, height]);
  await drawCurrentPackagePage(target, page, scanit);
  if (source.getPageCount() > 1) {
    const productPages = await target.copyPages(
      source,
      source.getPageIndices().slice(1),
    );
    for (const productPage of productPages) target.addPage(productPage);
  }
  return target.save({ useObjectStreams: false });
}

async function drawCurrentPackagePage(
  document: PDFDocument,
  page: ReturnType<PDFDocument["addPage"]>,
  scanit: string,
) {
  const { width, height } = page.getSize();
  const qrBytes = await bwipjs.toBuffer({
    bcid: "qrcode",
    text: scanit,
    version: "2",
    scale: 8,
    paddingwidth: 0,
    paddingheight: 0,
    backgroundcolor: "FFFFFF",
    barcolor: "000000",
  } as Parameters<typeof bwipjs.toBuffer>[0] & { version: string });
  const qr = await document.embedPng(qrBytes);
  const qrSize = Math.min(width * 0.23, height * 0.335);
  const qrY = height * 0.577;
  const sideMargin = width * 0.044;
  page.drawImage(qr, { x: sideMargin, y: qrY, width: qrSize, height: qrSize });
  page.drawImage(qr, {
    x: width - sideMargin - qrSize,
    y: qrY,
    width: qrSize,
    height: qrSize,
  });

  const bold = await document.embedFont(StandardFonts.HelveticaBold);
  const regular = await document.embedFont(StandardFonts.Helvetica);
  const logoSize = height * 0.17;
  const logo = "OZON";
  const logoWidth = bold.widthOfTextAtSize(logo, logoSize);
  page.drawText(logo, {
    x: (width - logoWidth) / 2,
    y: height * 0.665,
    size: logoSize,
    font: bold,
    color: grayscale(0),
  });

  const suffix = scanit.slice(-4);
  const prefix = scanit.slice(0, -4);
  const numberSize = height * 0.18;
  const prefixWidth = regular.widthOfTextAtSize(prefix, numberSize);
  const suffixWidth = bold.widthOfTextAtSize(suffix, numberSize);
  const gap = width * 0.012;
  const horizontalPadding = width * 0.022;
  const boxWidth = suffixWidth + horizontalPadding * 2;
  const boxHeight = numberSize * 1.16;
  const totalWidth = prefixWidth + gap + boxWidth;
  const startX = Math.max(width * 0.04, (width - totalWidth) / 2);
  const numberY = height * 0.225;
  const boxX = startX + prefixWidth + gap;
  const boxY = numberY - numberSize * 0.16;
  page.drawText(prefix, {
    x: startX,
    y: numberY,
    size: numberSize,
    font: regular,
    color: grayscale(0),
  });
  page.drawRectangle({
    x: boxX,
    y: boxY,
    width: boxWidth,
    height: boxHeight,
    color: grayscale(0),
  });
  page.drawText(suffix, {
    x: boxX + horizontalPadding,
    y: numberY,
    size: numberSize,
    font: bold,
    color: rgb(1, 1, 1),
  });
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index], index);
      }
    },
  );
  await Promise.all(workers);
  return results;
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
