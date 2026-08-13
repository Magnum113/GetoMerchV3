#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  BinaryBitmap,
  DataMatrixReader,
  HybridBinarizer,
  RGBLuminanceSource,
} from "@zxing/library";
import { PDFDocument } from "pdf-lib";
import {
  MARKING_LABEL_HEIGHT_MM,
  MARKING_LABEL_TEMPLATE_VERSION,
  MARKING_LABEL_WIDTH_MM,
  createGs1DataMatrix,
  expectedScannerPayload,
  inferSize,
  millimetersToPoints,
  renderMarkingLabelPdf,
  wrapText,
} from "@/lib/marking/labels/template";
import { parseMarkingRuntimeConfig } from "@/lib/marking/config";
import { assertLabelAccess } from "@/lib/marking/services/label-service";
import { applyMarkingLabelDownload } from "@/lib/marking/order-state";
import type { OzonOrder } from "@/lib/types";

type Golden = {
  gtin: string;
  serial: string;
  verificationKey: string;
  signature: string;
  fingerprint: string;
  offerId: string;
  postingNumber: string;
  unitOrdinal: number;
  itemQuantity: number;
  matrixWidth: number;
  matrixHeight: number;
  moduleDots: number;
  pdfSha256: string;
};

const ROOT = process.cwd();

main().catch((error) => {
  console.error("Stage 7 label checks failed", error);
  process.exitCode = 1;
});

async function main() {
  const golden = JSON.parse(
    await readFile(
      `${ROOT}/tests/fixtures/marking/stage7-label-golden.json`,
      "utf8",
    ),
  ) as Golden;
  const groupSeparator = String.fromCharCode(29);
  const code = Buffer.from(
    `]d201${golden.gtin}21${golden.serial}`
      + `${groupSeparator}91${golden.verificationKey}`
      + `${groupSeparator}92${golden.signature}`,
    "ascii",
  );
  try {
    const config = parseMarkingRuntimeConfig({
      GETOMERCH_MARKING_ENABLED: "true",
      GETOMERCH_MARKING_JUST_IN_TIME_ENABLED: "true",
      GETOMERCH_MARKING_LABELS_ENABLED: "true",
      GETOMERCH_MARKING_ALLOWED_GTINS: golden.gtin,
      GETOMERCH_MARKING_ALLOWED_OFFERS: golden.offerId,
      GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
      GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    });
    assertLabelAccess(config, "owner", golden.gtin, golden.offerId);
    assert.throws(() => assertLabelAccess(config, "other", golden.gtin, golden.offerId));
    assert.throws(() => parseMarkingRuntimeConfig({
      GETOMERCH_MARKING_ENABLED: "true",
      GETOMERCH_MARKING_LABELS_ENABLED: "true",
      GETOMERCH_MARKING_ALLOWED_GTINS: golden.gtin,
      GETOMERCH_MARKING_ALLOWED_OFFERS: golden.offerId,
      GETOMERCH_MARKING_ALLOWED_ADMIN_IDS: "owner",
      GETOMERCH_MARKING_KEYRING_FILE: "/run/credentials/marking-keyring",
    }));

    const matrix = createGs1DataMatrix(code);
    assert.equal(matrix.width, golden.matrixWidth);
    assert.equal(matrix.height, golden.matrixHeight);
    assert.equal(matrix.moduleDots, golden.moduleDots);
    const decoded = decodeDataMatrix(matrix);
    assert.deepEqual(decoded, expectedScannerPayload(code));

    const metadata = {
      gtin: golden.gtin,
      fingerprint: golden.fingerprint,
      offerId: golden.offerId,
      productSku: golden.offerId,
      postingNumber: golden.postingNumber,
      unitOrdinal: golden.unitOrdinal,
      itemQuantity: golden.itemQuantity,
    };
    const first = await renderMarkingLabelPdf(code, metadata);
    const second = await renderMarkingLabelPdf(code, metadata);
    assert.deepEqual(first.pdf, second.pdf);
    assert.equal(
      createHash("sha256").update(first.pdf).digest("hex"),
      golden.pdfSha256,
    );
    const pdf = await PDFDocument.load(first.pdf, { updateMetadata: false });
    assert.equal(pdf.getPageCount(), 1);
    const size = pdf.getPage(0).getSize();
    assert.ok(Math.abs(size.width - millimetersToPoints(MARKING_LABEL_WIDTH_MM)) < 0.001);
    assert.ok(Math.abs(size.height - millimetersToPoints(MARKING_LABEL_HEIGHT_MM)) < 0.001);
    const pdfBinary = Buffer.from(first.pdf).toString("latin1");
    assert.equal(pdfBinary.includes(code.toString("ascii")), false);
    assert.equal(pdfBinary.includes(golden.signature), false);
    assert.equal(pdf.getTitle(), undefined);
    assert.equal(pdf.getSubject(), undefined);
    assert.equal(MARKING_LABEL_TEMPLATE_VERSION, "getomerch-58x40-v2");
    assert.equal(inferSize(golden.offerId), "S");
    assert.equal(inferSize("D16-TSH-PRT-WBEG-2XL"), "XXL");
    assert.deepEqual(
      wrapText(
        "D16-TSH-PRT-WGRY-XXL",
        { widthOfTextAtSize: (value) => value.length * 5 },
        5.2,
        65,
        2,
      ),
      ["D16-TSH-PRT-", "WGRY-XXL"],
    );
    assert.throws(() => wrapText(
      "VALUE-WITHOUT-A-VALID-BREAK-THAT-DOES-NOT-FIT",
      { widthOfTextAtSize: (value) => value.length * 5 },
      5.2,
      20,
      2,
    ));

    const assignment = {
      id: "11111111-1111-4111-8111-111111111111",
      assignmentRevision: 1,
      renderCount: 0,
      templateVersion: null,
      labelState: "not_rendered",
      canRenderLabel: true,
      canReprintLabel: false,
      canConfirmApplied: false,
    };
    const otherOrder = { id: "other" } as OzonOrder;
    const order = {
      id: "target",
      items: [{
        id: "item",
        marking: {
          candidates: [],
          assignments: [assignment],
        },
      }],
    } as unknown as OzonOrder;
    const originalOrders = [order, otherOrder];
    const updatedOrders = applyMarkingLabelDownload(originalOrders, {
      assignmentId: assignment.id,
      assignmentRevision: 2,
      renderCount: 1,
      templateVersion: MARKING_LABEL_TEMPLATE_VERSION,
    });
    assert.notEqual(updatedOrders, originalOrders);
    assert.notEqual(updatedOrders[0], order);
    assert.equal(updatedOrders[1], otherOrder);
    const updatedAssignment = updatedOrders[0]?.items?.[0]?.marking?.assignments[0];
    assert.equal(updatedAssignment?.assignmentRevision, 2);
    assert.equal(updatedAssignment?.renderCount, 1);
    assert.equal(updatedAssignment?.labelState, "label_rendered");
    assert.equal(updatedAssignment?.canRenderLabel, false);
    assert.equal(updatedAssignment?.canReprintLabel, true);
    assert.equal(updatedAssignment?.canConfirmApplied, true);
    assert.equal(applyMarkingLabelDownload(originalOrders, {
      assignmentId: "22222222-2222-4222-8222-222222222222",
      assignmentRevision: 2,
      renderCount: 1,
      templateVersion: MARKING_LABEL_TEMPLATE_VERSION,
    }), originalOrders);

    const route = await readFile(
      `${ROOT}/src/app/api/admin/marking/assignments/[id]/label/route.ts`,
      "utf8",
    );
    assert.match(route, /Content-Type": "application\/pdf"/);
    assert.match(route, /Cache-Control": "no-store, private"/);
    assert.match(route, /requireMarkingMutationContext/);
    assert.doesNotMatch(route, /adminJson/);

    const readRepository = await readFile(
      `${ROOT}/src/lib/marking/read-models/repository.ts`,
      "utf8",
    );
    assert.doesNotMatch(
      readRepository,
      /code_(?:ciphertext|nonce|auth_tag|hmac)|dedup_hmacs|\bserial\b/i,
    );
    const labelRepository = await readFile(
      `${ROOT}/src/lib/marking/repositories/labels.ts`,
      "utf8",
    );
    assert.match(labelRepository, /get_jit_label_material/);
    assert.match(labelRepository, /record_jit_label_render/);
    assert.doesNotMatch(labelRepository, /SELECT\s+\*/i);

    const service = await readFile(
      `${ROOT}/src/lib/marking/services/label-service.ts`,
      "utf8",
    );
    assert.match(
      service,
      /renderMarkingLabelPdf[\s\S]*runServerMutation[\s\S]*recordJitLabelRender/,
    );
    assert.ok(
      service.indexOf("assertLabelOperatorAccess(config, context.actor)")
        < service.indexOf("const material = await getJitLabelMaterial"),
      "Operator access must be checked before encrypted material is loaded",
    );
    assert.match(service, /code\.fill\(0\)/);
    assert.match(service, /MARKING_LABEL_TEMPLATE_VERSION/);

    console.log(
      "Stage 7 GS1 round-trip, golden PDF, access and secret-path checks passed",
    );
  } finally {
    code.fill(0);
  }
}

function decodeDataMatrix(matrix: {
  pixels: readonly number[];
  width: number;
  height: number;
}) {
  const scale = 8;
  const quiet = 4;
  const width = (matrix.width + quiet * 2) * scale;
  const height = (matrix.height + quiet * 2) * scale;
  const luminance = new Uint8ClampedArray(width * height);
  luminance.fill(255);
  for (let row = 0; row < matrix.height; row += 1) {
    for (let column = 0; column < matrix.width; column += 1) {
      if (matrix.pixels[row * matrix.width + column] !== 1) continue;
      for (let y = 0; y < scale; y += 1) {
        for (let x = 0; x < scale; x += 1) {
          luminance[
            ((row + quiet) * scale + y) * width
              + (column + quiet) * scale + x
          ] = 0;
        }
      }
    }
  }
  const result = new DataMatrixReader().decode(
    new BinaryBitmap(
      new HybridBinarizer(new RGBLuminanceSource(luminance, width, height)),
    ),
  );
  const decoded = Buffer.from(result.getText(), "latin1");
  return decoded[0] === 0x1d ? Buffer.from(decoded.subarray(1)) : decoded;
}
