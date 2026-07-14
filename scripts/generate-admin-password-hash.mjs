#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const HASH_PREFIX = "pbkdf2_sha256";
const ITERATIONS = 310_000;
const encoder = new TextEncoder();

const password = process.argv[2] || await readPasswordFromStdin();
if (!password) {
  console.error("Password is required.");
  process.exit(1);
}

const salt = new Uint8Array(16);
crypto.getRandomValues(salt);
const saltEncoded = base64UrlEncodeBytes(salt);
const hash = await pbkdf2Sha256(password, saltEncoded, ITERATIONS);
console.log(`${HASH_PREFIX}$${ITERATIONS}$${saltEncoded}$${hash}`);

async function readPasswordFromStdin() {
  if (!input.isTTY) {
    let value = "";
    for await (const chunk of input) value += chunk;
    return value.trimEnd();
  }

  const rl = createInterface({ input, output });
  const value = await rl.question("Admin password: ");
  rl.close();
  return value;
}

async function pbkdf2Sha256(passwordValue, saltValue, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(passwordValue),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(saltValue),
      iterations,
    },
    keyMaterial,
    256,
  );
  return base64UrlEncodeBytes(new Uint8Array(bits));
}

function base64UrlEncodeBytes(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
