import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { PDFDocument } from "pdf-lib";

const createRequests: string[][] = [];
const taskPostings = new Map<string, string[]>();
const taskPolls = new Map<string, number>();
let nextTaskId = 1000;
let baseUrl = "";

const server = createServer(async (request, response) => {
  if (request.method === "GET" && request.url?.startsWith("/files/")) {
    const taskId = request.url.split("/").at(-1)?.replace(/\.pdf$/, "") ?? "";
    const postings = taskPostings.get(taskId) ?? [];
    if (postings.includes("INVALID-PDF")) {
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("not a PDF");
      return;
    }
    const pdf = await createLabelPdf(postings.length * 2);
    response.writeHead(200, { "Content-Type": "application/octet-stream" });
    response.end(pdf);
    return;
  }

  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    posting_numbers?: string[];
    task_id?: number | string;
  };
  assert.equal(request.method, "POST");
  assert.equal(request.headers["client-id"], "test-client");
  assert.equal(request.headers["api-key"], "test-key");

  if (request.url === "/v3/posting/fbs/package-label/create") {
    const postings = Array.isArray(body.posting_numbers) ? body.posting_numbers : [];
    createRequests.push(postings);
    if (postings.includes("NO-TASKS")) {
      respondJson(response, { tasks: [] });
      return;
    }
    const taskId = String(nextTaskId++);
    taskPostings.set(taskId, postings);
    respondJson(response, { tasks: [{ task_id: Number(taskId), task_type: "small_label" }] });
    return;
  }

  assert.equal(request.url, "/v2/posting/fbs/package-label/get");
  const taskId = String(body.task_id ?? "");
  const postings = taskPostings.get(taskId) ?? [];
  const poll = (taskPolls.get(taskId) ?? 0) + 1;
  taskPolls.set(taskId, poll);
  if (postings.includes("NOT-READY")) {
    respondJson(response, {
      error: null,
      file_url: null,
      status: {
        code: "completed",
        postings_count: postings.length,
        printed_postings_count: postings.length - 1,
        unprinted_postings: ["NOT-READY"],
      },
    });
    return;
  }
  if (postings.includes("PROCESSING") && poll === 1) {
    respondJson(response, {
      error: null,
      file_url: null,
      status: {
        code: "processing",
        postings_count: postings.length,
        printed_postings_count: 0,
        unprinted_postings: [],
      },
    });
    return;
  }
  if (postings.includes("UNTRUSTED")) {
    respondJson(response, {
      error: null,
      file_url: "https://example.com/label.pdf",
      status: { code: "completed", unprinted_postings: [] },
    });
    return;
  }
  respondJson(response, {
    error: null,
    file_url: `${baseUrl}/files/${taskId}.pdf`,
    status: {
      code: "completed",
      postings_count: postings.length,
      printed_postings_count: postings.length,
      unprinted_postings: [],
    },
  });
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    baseUrl = `http://127.0.0.1:${address.port}`;
    process.env.OZON_CLIENT_ID = "test-client";
    process.env.OZON_API_KEY = "test-key";
    process.env.GETOMERCH_ALLOW_OZON_BASE_URL_OVERRIDE = "true";
    process.env.GETOMERCH_OZON_API_BASE_URL = baseUrl;
    const { OzonApiError } = await import("../src/lib/ozon/client");
    const {
      fetchOzonPackageLabelBundle,
      fetchOzonPackageLabels,
      OzonPackageLabelsNotReadyError,
      ozonPackageLabelFilename,
    } = await import("../src/lib/ozon/package-label");

    const single = await PDFDocument.load(
      await fetchOzonPackageLabels(["12345678-0001-1"], { attempts: 1 }),
    );
    assert.equal(single.getPageCount(), 2);
    assert.equal(
      ozonPackageLabelFilename("12345678-0001-1"),
      "ozon-labels-12345678-0001-1-58x40.pdf",
    );

    const processing = await PDFDocument.load(
      await fetchOzonPackageLabels(["PROCESSING"], {
        attempts: 1,
        pollAttempts: 2,
        pollDelayMs: 0,
      }),
    );
    assert.equal(processing.getPageCount(), 2);

    await assert.rejects(
      fetchOzonPackageLabels(["INVALID-PDF"], { attempts: 1 }),
      (error) => error instanceof OzonApiError && error.code === "ozon_invalid_pdf",
    );
    await assert.rejects(
      fetchOzonPackageLabels(["UNTRUSTED"], { attempts: 1 }),
      (error) => error instanceof OzonApiError
        && error.code === "ozon_label_file_url_untrusted",
    );
    await assert.rejects(
      fetchOzonPackageLabels(["NO-TASKS"], { attempts: 1 }),
      (error) => error instanceof OzonApiError
        && error.code === "ozon_label_tasks_missing",
    );

    createRequests.length = 0;
    const postings = Array.from({ length: 21 }, (_, index) => `POSTING-${index}`);
    const bundle = await PDFDocument.load(
      await fetchOzonPackageLabelBundle(postings, { attempts: 1 }),
    );
    assert.deepEqual(createRequests, [postings]);
    assert.equal(bundle.getPageCount(), 42);
    for (const page of bundle.getPages()) {
      assert.equal(page.getWidth(), 164.25);
      assert.equal(page.getHeight(), 113.25);
    }

    await assert.rejects(
      fetchOzonPackageLabelBundle(["POSTING-A", "NOT-READY", "POSTING-B"], {
        attempts: 1,
      }),
      (error) => error instanceof OzonPackageLabelsNotReadyError
        && error.postingNumbers.length === 1
        && error.postingNumbers[0] === "NOT-READY",
    );
    assert.throws(() => fetchOzonPackageLabels([]), /от 1 до 1000/);
    assert.throws(
      () => fetchOzonPackageLabels(
        Array.from({ length: 1001 }, (_, index) => `POSTING-${index}`),
      ),
      /от 1 до 1000/,
    );
    assert.throws(() => fetchOzonPackageLabelBundle([]), /от 1 до 100/);
    assert.throws(
      () => fetchOzonPackageLabelBundle(
        Array.from({ length: 101 }, (_, index) => `POSTING-${index}`),
      ),
      /от 1 до 100/,
    );
    assert.throws(
      () => fetchOzonPackageLabelBundle(["POSTING-A", "POSTING-A"]),
      /не должны повторяться/,
    );
    console.log("ok - Ozon FBS package label checks passed");
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

function respondJson(response: ServerResponse, value: unknown) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function createLabelPdf(pageCount: number) {
  const document = await PDFDocument.create();
  for (let index = 0; index < pageCount; index += 1) {
    document.addPage([164.25, 113.25]);
  }
  return Buffer.from(await document.save({ useObjectStreams: false }));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
