import "server-only";

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DatabaseConfigurationError";
  }
}

export class DatabaseQueryError extends Error {
  constructor(message = "Database query failed", options?: ErrorOptions) {
    super(message, options);
    this.name = "DatabaseQueryError";
  }
}

export class DatabaseBusinessError extends Error {
  readonly code: string;
  readonly status: number;
  readonly publicMessage: string;

  constructor(code: string, publicMessage: string, status = 409) {
    super(publicMessage);
    this.name = "DatabaseBusinessError";
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

export class DatabaseFaultInjectionError extends Error {
  readonly checkpoint: string;

  constructor(checkpoint: string) {
    super(`Injected mutation failure at ${checkpoint}`);
    this.name = "DatabaseFaultInjectionError";
    this.checkpoint = checkpoint;
  }
}

export class DatabaseContractMismatchError extends Error {
  constructor(operation: string) {
    super(`Database contract mismatch for ${operation}`);
    this.name = "DatabaseContractMismatchError";
  }
}
