const HASH_PREFIX = "pbkdf2_sha256";
const encoder = new TextEncoder();

export async function verifyAdminPassword(password: string, storedHash: string | undefined) {
  if (!storedHash || storedHash.startsWith("TODO_")) return false;

  const [algorithm, iterationsRaw, salt, expected] = storedHash.split("$");
  const iterations = Number(iterationsRaw);
  if (algorithm !== HASH_PREFIX || !Number.isInteger(iterations) || iterations < 100_000 || !salt || !expected) {
    return false;
  }

  const actual = await pbkdf2Sha256(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export async function createAdminPasswordHash(password: string, iterations = 310_000) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);
  const saltEncoded = base64UrlEncodeBytes(salt);
  const hash = await pbkdf2Sha256(password, saltEncoded, iterations);
  return `${HASH_PREFIX}$${iterations}$${saltEncoded}$${hash}`;
}

async function pbkdf2Sha256(password: string, salt: string, iterations: number) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations,
    },
    keyMaterial,
    256,
  );
  return base64UrlEncodeBytes(new Uint8Array(bits));
}

function base64UrlEncodeBytes(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  }
  return diff === 0;
}
