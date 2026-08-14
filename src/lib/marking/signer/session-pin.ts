import type { Writable } from "node:stream";

const MAX_PIN_BYTES = 128;

type TtyPinInput = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(mode: boolean): void;
  resume(): unknown;
  pause(): unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
};

export class SignerSessionPinError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SignerSessionPinError";
  }
}

export async function readSignerSessionPin(input: {
  stdin?: TtyPinInput;
  output?: Writable;
} = {}) {
  const stdin = input.stdin ?? process.stdin as unknown as TtyPinInput;
  const output = input.output ?? process.stderr;
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new SignerSessionPinError(
      "signer_pin_terminal_required",
      "Signer PIN must be entered in an interactive terminal",
    );
  }

  output.write("PIN Рутокена (скрытый ввод, хранится только до остановки signer): ");
  const previousRawMode = stdin.isRaw === true;
  const pin = Buffer.alloc(MAX_PIN_BYTES);
  let length = 0;

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const finish = (error?: SignerSessionPinError) => {
      if (settled) return;
      settled = true;
      stdin.off("data", onData);
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      process.off("SIGHUP", onInterrupt);
      stdin.setRawMode(previousRawMode);
      stdin.pause();
      output.write("\n");
      if (error) {
        pin.fill(0);
        reject(error);
        return;
      }
      const value = Buffer.alloc(length);
      pin.copy(value, 0, 0, length);
      pin.fill(0);
      if (value.length === 0) {
        value.fill(0);
        reject(new SignerSessionPinError("signer_pin_empty", "Signer PIN cannot be empty"));
        return;
      }
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      try {
        for (const byte of bytes) {
          if (byte === 0x03) {
            finish(new SignerSessionPinError("signer_pin_cancelled", "Signer PIN entry was cancelled"));
            return;
          }
          if (byte === 0x0a || byte === 0x0d) {
            finish();
            return;
          }
          if (byte === 0x08 || byte === 0x7f) {
            if (length > 0) {
              length -= 1;
              pin[length] = 0;
            }
            continue;
          }
          if (byte < 0x20) continue;
          if (length >= MAX_PIN_BYTES) {
            finish(new SignerSessionPinError("signer_pin_too_long", "Signer PIN is too long"));
            return;
          }
          pin[length] = byte;
          length += 1;
        }
      } finally {
        if (Buffer.isBuffer(chunk)) chunk.fill(0);
      }
    };
    const onInterrupt = () => finish(new SignerSessionPinError(
      "signer_pin_cancelled",
      "Signer PIN entry was cancelled",
    ));

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);
    process.once("SIGHUP", onInterrupt);
  });
}
