import "server-only";

import { PDFDocument } from "pdf-lib";
import { OzonApiError, ozonPost } from "@/lib/ozon/client";

const POSTING_NUMBER_PATTERN = /^[0-9A-Za-z-]{3,80}$/;
const OZON_LABEL_API_MAX = 1000;
const OZON_LABEL_TASK_CONCURRENCY = 4;
const DEFAULT_POLL_ATTEMPTS = 6;
const DEFAULT_POLL_DELAY_MS = 1000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

type LabelOptions = {
  signal?: AbortSignal;
  attempts?: number;
  pollAttempts?: number;
  pollDelayMs?: number;
};

type LabelCreateResponse = {
  tasks?: Array<{
    task_id?: number | string;
    task_type?: string;
  }>;
};

type LabelTaskResponse = {
  error?: unknown;
  file_url?: string | null;
  status?: {
    code?: string;
    postings_count?: number;
    printed_postings_count?: number;
    unprinted_postings?: unknown;
  };
};

type LabelTaskResult = {
  pdf?: Uint8Array;
  notReady: string[];
};

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
  options: LabelOptions = {},
) {
  const normalized = normalizePostingNumbers(postingNumbers, OZON_LABEL_API_MAX);
  return fetchOfficialOzonPackageLabels(normalized, options);
}

export function ozonPackageLabelFilename(postingNumber: string) {
  const safePosting = postingNumber.replace(/[^0-9A-Za-z-]+/g, "-").slice(0, 80);
  return `ozon-labels-${safePosting || "posting"}-58x40.pdf`;
}

export function fetchOzonPackageLabelBundle(
  postingNumbers: readonly string[],
  options: LabelOptions = {},
) {
  const normalized = normalizePostingNumbers(postingNumbers, 100);
  return fetchOfficialOzonPackageLabels(normalized, options);
}

export function ozonPackageLabelBundleFilename(count: number) {
  return `ozon-labels-${count}-postings-58x40.pdf`;
}

async function fetchOfficialOzonPackageLabels(
  postingNumbers: string[],
  options: LabelOptions,
) {
  const created = await ozonPost<LabelCreateResponse>(
    "/v3/posting/fbs/package-label/create",
    { posting_numbers: postingNumbers },
    ozonOptions(options),
  );
  const taskIds = normalizeTaskIds(created.tasks);
  if (taskIds.length === 0) {
    throw new OzonApiError("Ozon package label creation returned no tasks", {
      retryable: false,
      code: "ozon_label_tasks_missing",
    });
  }

  const results = await mapWithConcurrency(
    taskIds,
    OZON_LABEL_TASK_CONCURRENCY,
    (taskId) => fetchOfficialLabelTask(taskId, postingNumbers, options),
  );
  const notReady = Array.from(new Set(results.flatMap((result) => result.notReady)));
  if (notReady.length > 0) {
    throw new OzonPackageLabelsNotReadyError(notReady);
  }
  const documents = results.flatMap((result) => result.pdf ? [result.pdf] : []);
  if (documents.length !== taskIds.length) {
    throw new OzonApiError("Ozon package label tasks returned incomplete files", {
      retryable: false,
      code: "ozon_label_files_missing",
    });
  }
  if (documents.length === 1) return documents[0];
  return mergePdfDocuments(documents);
}

async function fetchOfficialLabelTask(
  taskId: number | string,
  postingNumbers: string[],
  options: LabelOptions,
): Promise<LabelTaskResult> {
  const pollAttempts = clampInteger(
    options.pollAttempts ?? options.attempts ?? DEFAULT_POLL_ATTEMPTS,
    1,
    30,
  );
  const pollDelayMs = clampInteger(
    options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS,
    0,
    5000,
  );

  for (let attempt = 1; attempt <= pollAttempts; attempt += 1) {
    const result = await ozonPost<LabelTaskResponse>(
      "/v2/posting/fbs/package-label/get",
      { task_id: taskId },
      ozonOptions(options),
    );
    const notReady = normalizeUnprintedPostings(result.status?.unprinted_postings);
    if (notReady.length > 0) return { notReady };
    if (result.error != null) {
      throw new OzonApiError("Ozon package label task failed", {
        status: 409,
        retryable: false,
        code: "ozon_label_task_failed",
      });
    }
    const fileUrl = result.file_url?.trim() ?? "";
    if (fileUrl) {
      return {
        pdf: await downloadOfficialLabelPdf(fileUrl, options),
        notReady: [],
      };
    }
    if (attempt < pollAttempts) await abortableSleep(pollDelayMs, options.signal);
  }

  return { notReady: postingNumbers };
}

async function downloadOfficialLabelPdf(fileUrl: string, options: LabelOptions) {
  const url = validateOfficialLabelUrl(fileUrl);
  const attempts = clampInteger(options.attempts ?? 4, 1, 6);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.signal?.aborted) throw cancelledError(options.signal.reason);
    try {
      const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
      const signal = options.signal
        ? AbortSignal.any([options.signal, timeoutSignal])
        : timeoutSignal;
      const response = await fetch(url, { cache: "no-store", signal });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        const error = new OzonApiError(`Ozon package label file returned ${response.status}`, {
          status: response.status,
          retryable,
          code: `ozon_label_file_http_${response.status}`,
        });
        if (!retryable || attempt >= attempts) throw error;
        lastError = error;
      } else {
        await assertValidPdf(bytes);
        return bytes;
      }
    } catch (error) {
      if (error instanceof OzonApiError) throw error;
      if (options.signal?.aborted) throw cancelledError(options.signal.reason);
      lastError = error;
      if (attempt >= attempts) break;
    }
    await abortableSleep(Math.min(3000, 300 * 2 ** (attempt - 1)), options.signal);
  }
  throw new OzonApiError("Ozon package label file download failed", {
    retryable: true,
    code: "ozon_label_file_download_failed",
    cause: lastError,
  });
}

async function assertValidPdf(bytes: Uint8Array) {
  const signature = new TextDecoder("ascii").decode(bytes.slice(0, 5));
  if (bytes.length < 5 || signature !== "%PDF-") {
    throw new OzonApiError("Ozon package label file is not a PDF", {
      retryable: false,
      code: "ozon_invalid_pdf",
    });
  }
  try {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    if (document.getPageCount() < 1) throw new Error("PDF has no pages");
  } catch (error) {
    throw new OzonApiError("Ozon package label file is invalid", {
      retryable: false,
      code: "ozon_invalid_pdf",
      cause: error,
    });
  }
}

function validateOfficialLabelUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new OzonApiError("Ozon package label file URL is invalid", {
      retryable: false,
      code: "ozon_label_file_url_invalid",
      cause: error,
    });
  }
  if (isAllowedTestUrl(url)) return url;
  const hostname = url.hostname.toLowerCase();
  const isOzonHost = hostname === "ozon.ru"
    || hostname.endsWith(".ozon.ru")
    || hostname === "ozone.ru"
    || hostname.endsWith(".ozone.ru");
  if (url.protocol !== "https:" || !isOzonHost) {
    throw new OzonApiError("Ozon package label file URL is not trusted", {
      retryable: false,
      code: "ozon_label_file_url_untrusted",
    });
  }
  return url;
}

function isAllowedTestUrl(url: URL) {
  if (process.env.GETOMERCH_ALLOW_OZON_BASE_URL_OVERRIDE !== "true") return false;
  const base = process.env.GETOMERCH_OZON_API_BASE_URL?.trim();
  if (!base) return false;
  return url.origin === new URL(base).origin;
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

function normalizeTaskIds(tasks: LabelCreateResponse["tasks"]) {
  if (!Array.isArray(tasks)) return [];
  const ids = tasks
    .map((task) => task?.task_id)
    .filter((value): value is number | string => (
      (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
      || (typeof value === "string" && /^\d+$/.test(value))
    ));
  return Array.from(new Set(ids.map(String)));
}

function normalizeUnprintedPostings(value: unknown) {
  if (!Array.isArray(value)) return [];
  const postings: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && POSTING_NUMBER_PATTERN.test(entry.trim())) {
      postings.push(entry.trim());
      continue;
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const candidate = record.posting_number ?? record.postingNumber;
    if (typeof candidate === "string" && POSTING_NUMBER_PATTERN.test(candidate.trim())) {
      postings.push(candidate.trim());
    }
  }
  return Array.from(new Set(postings));
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

function ozonOptions(options: LabelOptions) {
  return {
    signal: options.signal,
    attempts: options.attempts,
  };
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

function clampInteger(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) throw new Error("Invalid Ozon label integer option");
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

async function abortableSleep(milliseconds: number, signal?: AbortSignal) {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError(signal.reason));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

function cancelledError(reason: unknown) {
  return reason instanceof Error
    ? reason
    : new DOMException("The operation was aborted", "AbortError");
}
