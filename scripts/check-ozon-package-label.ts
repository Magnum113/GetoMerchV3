import assert from "node:assert/strict";
import { createServer } from "node:http";
import { PDFDocument } from "pdf-lib";

const requestBatches: string[][] = [];
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    posting_number?: string[];
  };
  assert.equal(request.method, "POST");
  assert.equal(request.url, "/v2/posting/fbs/package-label");
  assert.equal(request.headers["client-id"], "test-client");
  assert.equal(request.headers["api-key"], "test-key");
  assert.equal(request.headers.accept, "application/pdf");
  const postingNumbers = body.posting_number ?? [];
  requestBatches.push(postingNumbers);
  if (postingNumbers.includes("NOT-READY")) {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "The next postings aren't ready" }));
    return;
  }
  if (postingNumbers.includes("INVALID-PDF")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not a PDF" }));
    return;
  }
  const pdf = await createLabelPdf(postingNumbers.length);
  response.writeHead(200, { "Content-Type": "application/pdf" });
  response.end(pdf);
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    process.env.OZON_CLIENT_ID = "test-client";
    process.env.OZON_API_KEY = "test-key";
    process.env.GETOMERCH_ALLOW_OZON_BASE_URL_OVERRIDE = "true";
    process.env.GETOMERCH_OZON_API_BASE_URL = `http://127.0.0.1:${address.port}`;
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
    assert.equal(single.getPageCount(), 1);
    assert.equal(
      ozonPackageLabelFilename("12345678-0001-1"),
      "ozon-labels-12345678-0001-1-58x40.pdf",
    );
    await assert.rejects(
      fetchOzonPackageLabels(["NOT-READY"], { attempts: 1 }),
      (error) => error instanceof OzonApiError && error.status === 409,
    );
    await assert.rejects(
      fetchOzonPackageLabels(["INVALID-PDF"], { attempts: 1 }),
      (error) => error instanceof OzonApiError && error.code === "ozon_invalid_pdf",
    );
    requestBatches.length = 0;
    const postings = Array.from({ length: 21 }, (_, index) => `POSTING-${index}`);
    const bundle = await PDFDocument.load(
      await fetchOzonPackageLabelBundle(postings, { attempts: 1 }),
    );
    assert.deepEqual(requestBatches.map((batch) => batch.length), [20, 1]);
    assert.equal(bundle.getPageCount(), 21);
    for (const page of bundle.getPages()) {
      assert.equal(page.getWidth(), 164.25);
      assert.equal(page.getHeight(), 113.25);
    }
    await assert.rejects(
      fetchOzonPackageLabelBundle(["POSTING-A", "NOT-READY", "POSTING-B"], { attempts: 1 }),
      (error) => error instanceof OzonPackageLabelsNotReadyError
        && error.postingNumbers.length === 1
        && error.postingNumbers[0] === "NOT-READY",
    );
    assert.throws(() => fetchOzonPackageLabels([]), /от 1 до 20/);
    assert.throws(
      () => fetchOzonPackageLabels(Array.from({ length: 21 }, (_, index) => `POSTING-${index}`)),
      /от 1 до 20/,
    );
    await assert.rejects(fetchOzonPackageLabelBundle([]), /от 1 до 100/);
    await assert.rejects(
      fetchOzonPackageLabelBundle(["POSTING-A", "POSTING-A"]),
      /не должны повторяться/,
    );
    console.log("ok - Ozon FBS package label checks passed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
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
