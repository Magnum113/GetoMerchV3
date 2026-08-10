import "server-only";

import bwipjs from "bwip-js/node";
import {
  PDFDocument,
  StandardFonts,
  grayscale,
  type PDFFont,
  type PDFPage,
} from "pdf-lib";
import { parseGs1MarkingCode } from "@/lib/marking/domain/code-pool";
import { MarkingDomainError } from "@/lib/marking/domain/errors";

export const MARKING_LABEL_TEMPLATE_VERSION = "getomerch-58x40-v1";
export const MARKING_LABEL_WIDTH_MM = 58;
export const MARKING_LABEL_HEIGHT_MM = 40;
export const MARKING_LABEL_DPI = 300;
export const MARKING_LABEL_QUIET_ZONE_MODULES = 2;
export const MARKING_LABEL_MIN_MODULE_DOTS = 5;

type LabelMetadata = {
  gtin: string;
  fingerprint: string;
  offerId: string | null;
  productSku: string | null;
  postingNumber: string | null;
  unitOrdinal: number;
  itemQuantity: number;
};

type DataMatrix = {
  pixels: readonly number[];
  width: number;
  height: number;
  moduleDots: number;
};

export type RenderedMarkingLabel = {
  pdf: Uint8Array;
  matrixWidth: number;
  matrixHeight: number;
  moduleDots: number;
};

export async function renderMarkingLabelPdf(
  markingCode: Buffer,
  metadata: LabelMetadata,
): Promise<RenderedMarkingLabel> {
  const parsed = parseGs1MarkingCode(markingCode);
  if (!parsed.ok || parsed.gtin !== metadata.gtin) {
    throw new MarkingDomainError(
      "invalid_label",
      "Код маркировки не соответствует назначенному GTIN",
    );
  }
  const matrix = createGs1DataMatrix(markingCode);
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([
    millimetersToPoints(MARKING_LABEL_WIDTH_MM),
    millimetersToPoints(MARKING_LABEL_HEIGHT_MM),
  ]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  drawMatrix(page, matrix);
  drawMetadata(page, font, bold, metadata);

  const bytes = await pdf.save({
    addDefaultPage: false,
    useObjectStreams: false,
    updateFieldAppearances: false,
  });
  return {
    pdf: bytes,
    matrixWidth: matrix.width,
    matrixHeight: matrix.height,
    moduleDots: matrix.moduleDots,
  };
}

export function createGs1DataMatrix(markingCode: Buffer): DataMatrix {
  const parsed = parseGs1MarkingCode(markingCode);
  if (!parsed.ok) {
    throw new MarkingDomainError(
      "invalid_label",
      `Некорректный GS1-код: ${parsed.errors.join(", ")}`,
    );
  }
  const encoded = toBwipInput(markingCode);
  let result: ReturnType<typeof bwipjs.raw>;
  try {
    result = bwipjs.raw({
      bcid: "datamatrix",
      text: encoded,
      parsefnc: true,
    });
  } catch (error) {
    throw new MarkingDomainError(
      "invalid_label",
      "Не удалось построить GS1 DataMatrix",
      { cause: error },
    );
  }
  const symbol = Array.isArray(result) ? result[0] : null;
  if (
    !symbol
    || !("pixs" in symbol)
    || !Number.isSafeInteger(symbol.pixx)
    || !Number.isSafeInteger(symbol.pixy)
    || symbol.pixx < 10
    || symbol.pixy < 10
    || symbol.pixs.length !== symbol.pixx * symbol.pixy
  ) {
    throw new MarkingDomainError(
      "invalid_label",
      "Генератор вернул некорректную матрицу",
    );
  }

  const maxMatrixMm = 27;
  const maxDots = Math.floor(maxMatrixMm * MARKING_LABEL_DPI / 25.4);
  const totalModules = Math.max(symbol.pixx, symbol.pixy)
    + MARKING_LABEL_QUIET_ZONE_MODULES * 2;
  const moduleDots = Math.floor(maxDots / totalModules);
  if (moduleDots < MARKING_LABEL_MIN_MODULE_DOTS) {
    throw new MarkingDomainError(
      "invalid_label",
      "Код слишком большой для утверждённого шаблона 58x40",
    );
  }

  return {
    pixels: symbol.pixs,
    width: symbol.pixx,
    height: symbol.pixy,
    moduleDots,
  };
}

export function expectedScannerPayload(markingCode: Buffer) {
  const offset = markingCode.subarray(0, 3).equals(Buffer.from("]d2", "ascii"))
    ? 3
    : 0;
  return Buffer.from(markingCode.subarray(offset));
}

function toBwipInput(markingCode: Buffer) {
  const source = expectedScannerPayload(markingCode);
  let output = "^FNC1";
  for (const byte of source) {
    if (byte === 0x1d) {
      output += "^FNC1";
    } else if (byte === 0x5e) {
      output += "^^";
    } else {
      output += String.fromCharCode(byte);
    }
  }
  source.fill(0);
  return output;
}

function drawMatrix(page: PDFPage, matrix: DataMatrix) {
  const moduleMm = matrix.moduleDots * 25.4 / MARKING_LABEL_DPI;
  const totalWidthMm = (
    matrix.width + MARKING_LABEL_QUIET_ZONE_MODULES * 2
  ) * moduleMm;
  const totalHeightMm = (
    matrix.height + MARKING_LABEL_QUIET_ZONE_MODULES * 2
  ) * moduleMm;
  const quietMm = MARKING_LABEL_QUIET_ZONE_MODULES * moduleMm;
  const leftMm = 2.5 + (27 - totalWidthMm) / 2;
  const bottomMm = (MARKING_LABEL_HEIGHT_MM - totalHeightMm) / 2;
  const modulePt = millimetersToPoints(moduleMm);
  const originX = millimetersToPoints(leftMm + quietMm);
  const originY = millimetersToPoints(bottomMm + quietMm);

  for (let row = 0; row < matrix.height; row += 1) {
    for (let column = 0; column < matrix.width; column += 1) {
      if (matrix.pixels[row * matrix.width + column] !== 1) continue;
      page.drawRectangle({
        x: originX + column * modulePt,
        y: originY + (matrix.height - row - 1) * modulePt,
        width: modulePt,
        height: modulePt,
        color: grayscale(0),
        borderWidth: 0,
      });
    }
  }
}

function drawMetadata(
  page: PDFPage,
  font: PDFFont,
  bold: PDFFont,
  metadata: LabelMetadata,
) {
  const left = millimetersToPoints(32);
  const maxWidth = millimetersToPoints(23);
  let y = millimetersToPoints(35.5);
  const line = (text: string, size = 6, selectedFont = font, gapMm = 3.2) => {
    page.drawText(fitText(text, selectedFont, size, maxWidth), {
      x: left,
      y,
      size,
      font: selectedFont,
      color: grayscale(0),
    });
    y -= millimetersToPoints(gapMm);
  };

  line("GETOMERCH", 8, bold, 4.2);
  line("GS1 DATAMATRIX", 5.5, bold, 4);
  line(`GTIN ${metadata.gtin}`, 5.5, font, 4);
  line(`SKU ${safeAscii(metadata.offerId ?? metadata.productSku ?? "-")}`, 5.5);
  line(`ORDER ${safeAscii(metadata.postingNumber ?? "-")}`, 5.5);
  line(`UNIT ${metadata.unitOrdinal}/${metadata.itemQuantity}`, 5.5);
  line(`ID ${metadata.fingerprint}`, 5.5);
  line("SIZE 58x40 MM", 5, font, 3);
  line(MARKING_LABEL_TEMPLATE_VERSION.toUpperCase(), 4.5);
}

function fitText(text: string, font: PDFFont, size: number, maxWidth: number) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let value = text;
  while (value.length > 1 && font.widthOfTextAtSize(`${value}...`, size) > maxWidth) {
    value = value.slice(0, -1);
  }
  return `${value}...`;
}

function safeAscii(value: string) {
  return value.replace(/[^\x20-\x7e]/g, "?");
}

export function millimetersToPoints(value: number) {
  return value * 72 / 25.4;
}
