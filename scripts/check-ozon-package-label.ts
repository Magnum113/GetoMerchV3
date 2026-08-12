import assert from "node:assert/strict";
import { createServer } from "node:http";

const pdf = Buffer.from("%PDF-1.7\n%%EOF\n", "ascii");
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
  if (body.posting_number?.[0] === "NOT-READY") {
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "The next postings aren't ready" }));
    return;
  }
  if (body.posting_number?.[0] === "INVALID-PDF") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ message: "not a PDF" }));
    return;
  }
  assert.deepEqual(body, { posting_number: ["12345678-0001-1"] });
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
      fetchOzonPackageLabels,
      ozonPackageLabelFilename,
    } = await import("../src/lib/ozon/package-label");

    assert.deepEqual(
      Buffer.from(await fetchOzonPackageLabels(["12345678-0001-1"], { attempts: 1 })),
      pdf,
    );
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
    assert.throws(() => fetchOzonPackageLabels([]), /от 1 до 20/);
    assert.throws(
      () => fetchOzonPackageLabels(Array.from({ length: 21 }, (_, index) => `POSTING-${index}`)),
      /от 1 до 20/,
    );
    console.log("ok - Ozon FBS package label checks passed");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
