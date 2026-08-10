import "server-only";

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import { readFile } from "node:fs/promises";

export type EncryptedMarkingValue = {
  algorithm: "aes-256-gcm";
  keyVersion: number;
  iv: string;
  ciphertext: string;
  authTag: string;
};

type SerializedKeyring = {
  currentEncryptionKeyVersion: number;
  encryptionKeys: Record<string, string>;
  currentHmacKeyVersion: number;
  hmacKeys: Record<string, string>;
};

export class MarkingKeyringError extends Error {
  readonly code = "marking_keyring_error";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MarkingKeyringError";
  }
}

export class MarkingKeyring {
  readonly currentEncryptionKeyVersion: number;
  readonly currentHmacKeyVersion: number;
  private readonly encryptionKeys: ReadonlyMap<number, Buffer>;
  private readonly hmacKeys: ReadonlyMap<number, Buffer>;

  constructor(serialized: SerializedKeyring) {
    this.currentEncryptionKeyVersion = parseVersion(
      serialized.currentEncryptionKeyVersion,
      "currentEncryptionKeyVersion",
    );
    this.currentHmacKeyVersion = parseVersion(
      serialized.currentHmacKeyVersion,
      "currentHmacKeyVersion",
    );
    this.encryptionKeys = parseKeys(serialized.encryptionKeys, "encryptionKeys", 32, 32);
    this.hmacKeys = parseKeys(serialized.hmacKeys, "hmacKeys", 32, 128);
    if (!this.encryptionKeys.has(this.currentEncryptionKeyVersion)) {
      throw new MarkingKeyringError("Current encryption key version is missing");
    }
    if (!this.hmacKeys.has(this.currentHmacKeyVersion)) {
      throw new MarkingKeyringError("Current HMAC key version is missing");
    }
  }

  encrypt(plaintext: string): EncryptedMarkingValue {
    const input = Buffer.from(plaintext, "utf8");
    try {
      return this.encryptBytes(input);
    } finally {
      input.fill(0);
    }
  }

  encryptBytes(plaintext: Uint8Array): EncryptedMarkingValue {
    const key = this.encryptionKeys.get(this.currentEncryptionKeyVersion);
    if (!key) throw new MarkingKeyringError("Current encryption key is unavailable");
    const iv = randomBytes(12);
    const input = Buffer.from(plaintext);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
      const authTag = cipher.getAuthTag();
      try {
        return {
          algorithm: "aes-256-gcm",
          keyVersion: this.currentEncryptionKeyVersion,
          iv: iv.toString("base64"),
          ciphertext: ciphertext.toString("base64"),
          authTag: authTag.toString("base64"),
        };
      } finally {
        ciphertext.fill(0);
        authTag.fill(0);
      }
    } finally {
      input.fill(0);
      iv.fill(0);
    }
  }

  decrypt(value: EncryptedMarkingValue): string {
    const plaintext = this.decryptBytes(value);
    try {
      return plaintext.toString("utf8");
    } finally {
      plaintext.fill(0);
    }
  }

  decryptBytes(value: EncryptedMarkingValue): Buffer {
    if (value.algorithm !== "aes-256-gcm") {
      throw new MarkingKeyringError("Unsupported marking encryption algorithm");
    }
    const key = this.encryptionKeys.get(parseVersion(value.keyVersion, "keyVersion"));
    if (!key) throw new MarkingKeyringError("Encryption key version is unavailable");
    const iv = decodeBase64(value.iv, "iv", 12, 12);
    const ciphertext = decodeBase64(value.ciphertext, "ciphertext", 1, 262_144);
    const authTag = decodeBase64(value.authTag, "authTag", 16, 16);
    let plaintext: Buffer | null = null;
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      const output = Buffer.from(plaintext);
      return output;
    } catch (error) {
      throw new MarkingKeyringError("Unable to decrypt marking value", { cause: error });
    } finally {
      plaintext?.fill(0);
      iv.fill(0);
      ciphertext.fill(0);
      authTag.fill(0);
    }
  }

  fingerprints(plaintext: string) {
    const input = Buffer.from(plaintext, "utf8");
    try {
      return this.fingerprintsBytes(input);
    } finally {
      input.fill(0);
    }
  }

  fingerprintsBytes(plaintext: Uint8Array) {
    const input = Buffer.from(plaintext);
    try {
      return [...this.hmacKeys.entries()]
        .sort(([left], [right]) => (
          left === this.currentHmacKeyVersion
            ? -1
            : right === this.currentHmacKeyVersion
              ? 1
              : right - left
        ))
        .map(([keyVersion, key]) => ({
          keyVersion,
          digest: createHmac("sha256", key).update(input).digest("hex"),
        }));
    } finally {
      input.fill(0);
    }
  }
}

export async function loadMarkingKeyring(path: string) {
  if (!path.startsWith("/")) {
    throw new MarkingKeyringError("Marking keyring path must be absolute");
  }
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    throw new MarkingKeyringError("Unable to read marking keyring", { cause: error });
  }
  return parseMarkingKeyring(source);
}

export function parseMarkingKeyring(source: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new MarkingKeyringError("Marking keyring is not valid JSON", { cause: error });
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new MarkingKeyringError("Marking keyring must be an object");
  }
  const value = parsed as Partial<SerializedKeyring>;
  if (!value.encryptionKeys || !value.hmacKeys) {
    throw new MarkingKeyringError("Marking keyring is incomplete");
  }
  return new MarkingKeyring(value as SerializedKeyring);
}

function parseKeys(
  source: Record<string, string>,
  name: string,
  minimumBytes: number,
  maximumBytes: number,
) {
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new MarkingKeyringError(`${name} must be an object`);
  }
  const entries = Object.entries(source);
  if (entries.length === 0) throw new MarkingKeyringError(`${name} must not be empty`);
  const output = new Map<number, Buffer>();
  for (const [rawVersion, rawKey] of entries) {
    const version = parseVersion(Number(rawVersion), `${name} version`);
    if (output.has(version)) throw new MarkingKeyringError(`${name} contains duplicate versions`);
    if (typeof rawKey !== "string") throw new MarkingKeyringError(`${name} values must be base64 strings`);
    output.set(version, decodeBase64(rawKey, `${name}.${version}`, minimumBytes, maximumBytes));
  }
  return output;
}

function parseVersion(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1_000_000) {
    throw new MarkingKeyringError(`${name} must be a positive integer`);
  }
  return value;
}

function decodeBase64(value: string, name: string, minimumBytes: number, maximumBytes: number) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new MarkingKeyringError(`${name} must be canonical base64`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length < minimumBytes || decoded.length > maximumBytes) {
    decoded.fill(0);
    throw new MarkingKeyringError(
      `${name} must decode to ${minimumBytes === maximumBytes ? minimumBytes : `${minimumBytes}-${maximumBytes}`} bytes`,
    );
  }
  if (decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new MarkingKeyringError(`${name} must be canonical base64`);
  }
  return decoded;
}
