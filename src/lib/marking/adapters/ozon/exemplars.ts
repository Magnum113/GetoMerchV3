import "server-only";

import {
  OZON_EXEMPLAR_ENDPOINTS,
  OZON_EXEMPLAR_STATUSES,
  type OzonExemplarRemoteStatus,
} from "@/lib/marking/adapters/ozon/exemplar-contract";
import { OzonApiError, ozonPost } from "@/lib/ozon/client";

export type OzonExemplarInput = {
  assignmentId: string;
  exemplarId: number | null;
  markingCode: Buffer;
};

export type OzonExemplarProductInput = {
  productId: number;
  exemplars: OzonExemplarInput[];
};

export type OzonCreatedProduct = {
  productId: number;
  quantity: number;
  mandatoryMarkNeeded: boolean;
  mandatoryMarkPossible: boolean;
  exemplarIds: number[];
};

export type OzonValidationProduct = {
  productId: number;
  valid: boolean;
  error: string | null;
  exemplars: Array<{
    valid: boolean;
    errorCodes: string[];
  }>;
};

export type OzonExemplarStatus = {
  postingNumber: string;
  status: OzonExemplarRemoteStatus;
  products: Array<{
    productId: number;
    exemplars: Array<{
      exemplarId: number;
      errorCodes: string[];
    }>;
  }>;
};

type OzonTransport = typeof ozonPost;

export class OzonExemplarContractError extends OzonApiError {
  constructor(message: string) {
    super(message, {
      retryable: false,
      code: "ozon_exemplar_contract_error",
    });
    this.name = "OzonExemplarContractError";
  }
}

export class OzonExemplarAdapter {
  constructor(private readonly post: OzonTransport = ozonPost) {}

  async createOrGetExemplars(postingNumber: string, signal?: AbortSignal) {
    const response = await this.post<unknown>(
      OZON_EXEMPLAR_ENDPOINTS.createOrGet,
      { posting_number: requirePostingNumber(postingNumber) },
      { signal },
    );
    const object = record(response, "create-or-get response");
    const products = array(object.products, "create-or-get products").map(
      (value, productIndex): OzonCreatedProduct => {
        const product = record(value, `create-or-get product ${productIndex}`);
        const exemplars = array(
          product.exemplars,
          `create-or-get product ${productIndex} exemplars`,
        );
        return {
          productId: positiveInteger(product.product_id, "product_id"),
          quantity: positiveInteger(product.quantity, "quantity"),
          mandatoryMarkNeeded: boolean(product.is_mandatory_mark_needed, "is_mandatory_mark_needed"),
          mandatoryMarkPossible: boolean(product.is_mandatory_mark_possible, "is_mandatory_mark_possible"),
          exemplarIds: exemplars.map((entry) => positiveInteger(
            record(entry, "exemplar").exemplar_id,
            "exemplar_id",
          )),
        };
      },
    );
    return {
      postingNumber: string(object.posting_number, "posting_number"),
      multiBoxQuantity: nonNegativeInteger(object.multi_box_qty, "multi_box_qty"),
      products,
    };
  }

  async validateExemplars(
    postingNumber: string,
    products: OzonExemplarProductInput[],
    signal?: AbortSignal,
  ) {
    const response = await this.post<unknown>(
      OZON_EXEMPLAR_ENDPOINTS.validate,
      {
        posting_number: requirePostingNumber(postingNumber),
        products: products.map((product) => ({
          product_id: requireProductId(product.productId),
          exemplars: product.exemplars.map((exemplar) => ({
            marks: [mandatoryMark(exemplar.markingCode)],
          })),
        })),
      },
      { signal },
    );
    const object = record(response, "validate response");
    return array(object.products, "validate products").map(
      (value, productIndex): OzonValidationProduct => {
        const product = record(value, `validate product ${productIndex}`);
        return {
          productId: positiveInteger(product.product_id, "product_id"),
          valid: boolean(product.valid, "valid"),
          error: optionalString(product.error, "error"),
          exemplars: array(product.exemplars, "validate exemplars").map((entry) => {
            const exemplar = record(entry, "validate exemplar");
            const marks = array(exemplar.marks, "validate marks")
              .map((mark) => record(mark, "validate mark"));
            const markErrors = marks.flatMap((mark) => stringArray(mark.errors, "mark errors"));
            return {
              valid: boolean(exemplar.valid, "valid")
                && marks.every((mark) => boolean(mark.valid, "mark valid")),
              errorCodes: unique([
                ...stringArray(exemplar.errors, "exemplar errors"),
                ...markErrors,
              ]),
            };
          }),
        };
      },
    );
  }

  async setExemplars(
    postingNumber: string,
    products: OzonExemplarProductInput[],
    multiBoxQuantity = 0,
    signal?: AbortSignal,
  ) {
    await this.post<unknown>(
      OZON_EXEMPLAR_ENDPOINTS.set,
      {
        multi_box_qty: nonNegativeInteger(multiBoxQuantity, "multi_box_qty"),
        posting_number: requirePostingNumber(postingNumber),
        products: products.map((product) => ({
          product_id: requireProductId(product.productId),
          exemplars: product.exemplars.map((exemplar) => ({
            exemplar_id: positiveInteger(exemplar.exemplarId, "exemplar_id"),
            gtd: "",
            is_gtd_absent: true,
            is_rnpt_absent: true,
            marks: [mandatoryMark(exemplar.markingCode)],
            rnpt: "",
            weight: 0,
          })),
        })),
      },
      { signal },
    );
  }

  async getExemplarStatus(postingNumber: string, signal?: AbortSignal) {
    const response = await this.post<unknown>(
      OZON_EXEMPLAR_ENDPOINTS.status,
      { posting_number: requirePostingNumber(postingNumber) },
      { signal },
    );
    const object = record(response, "status response");
    const status = string(object.status, "status");
    if (!(OZON_EXEMPLAR_STATUSES as readonly string[]).includes(status)) {
      throw new OzonExemplarContractError(`Unknown Ozon exemplar status: ${status.slice(0, 80)}`);
    }
    return {
      postingNumber: string(object.posting_number, "posting_number"),
      status: status as OzonExemplarRemoteStatus,
      products: array(object.products, "status products").map((entry) => {
        const product = record(entry, "status product");
        return {
          productId: positiveInteger(product.product_id, "product_id"),
          exemplars: array(product.exemplars, "status exemplars").map((item) => {
            const exemplar = record(item, "status exemplar");
            const markErrors = array(exemplar.marks, "status marks")
              .flatMap((mark) => stringArray(record(mark, "status mark").error_codes, "mark error codes"));
            return {
              exemplarId: positiveInteger(exemplar.exemplar_id, "exemplar_id"),
              errorCodes: unique([
                ...stringArray(exemplar.gtd_error_codes, "gtd error codes"),
                ...stringArray(exemplar.rnpt_error_codes, "rnpt error codes"),
                ...stringArray(exemplar.weight_error_codes, "weight error codes"),
                ...markErrors,
              ]),
            };
          }),
        };
      }),
    } satisfies OzonExemplarStatus;
  }

  async updateExemplars(postingNumber: string, signal?: AbortSignal) {
    await this.post<unknown>(
      OZON_EXEMPLAR_ENDPOINTS.update,
      { posting_number: requirePostingNumber(postingNumber) },
      { signal },
    );
  }
}

function mandatoryMark(markingCode: Buffer) {
  if (!Buffer.isBuffer(markingCode) || markingCode.length < 20 || markingCode.length > 4096) {
    throw new OzonExemplarContractError("Invalid marking code material");
  }
  const payload = markingCode.subarray(0, 3).equals(Buffer.from("]d2", "ascii"))
    ? markingCode.subarray(3)
    : markingCode;
  const value = payload.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(payload)) {
    throw new OzonExemplarContractError("Marking code is not valid UTF-8");
  }
  return { mark: value, mark_type: "mandatory_mark" as const };
}

function requirePostingNumber(value: string) {
  if (typeof value !== "string" || value.length < 1 || value.length > 300) {
    throw new OzonExemplarContractError("Invalid posting number");
  }
  return value;
}

function requireProductId(value: number) {
  return positiveInteger(value, "product_id");
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OzonExemplarContractError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new OzonExemplarContractError(`${name} must be an array`);
  return value;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string") throw new OzonExemplarContractError(`${name} must be a string`);
  return value;
}

function optionalString(value: unknown, name: string) {
  if (value == null || value === "") return null;
  return string(value, name).slice(0, 1000);
}

function boolean(value: unknown, name: string) {
  if (typeof value !== "boolean") throw new OzonExemplarContractError(`${name} must be a boolean`);
  return value;
}

function positiveInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new OzonExemplarContractError(`${name} must be a positive safe integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, name: string) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OzonExemplarContractError(`${name} must be a non-negative safe integer`);
  }
  return Number(value);
}

function stringArray(value: unknown, name: string) {
  return array(value, name).map((entry) => string(entry, name).slice(0, 200));
}

function unique(values: string[]) {
  return [...new Set(values)].slice(0, 100);
}
