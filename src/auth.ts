import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPath: string;
}

function expandPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export function loadCredentials(): AscCredentials | null {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const privateKeyPath = process.env.ASC_PRIVATE_KEY_PATH;

  if (!keyId || !issuerId || !privateKeyPath) {
    return null;
  }

  const resolved = expandPath(privateKeyPath);
  try {
    readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ASC_PRIVATE_KEY_PATH at ${resolved}: ${err}`);
  }

  return { keyId, issuerId, privateKeyPath: resolved };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cache: CachedToken | null = null;

export function getToken(creds: AscCredentials): string {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.expiresAt - 60 > now) return cache.token;

  const privateKey = readFileSync(creds.privateKeyPath, "utf8");
  const exp = now + 15 * 60;

  const token = jwt.sign(
    {
      iss: creds.issuerId,
      iat: now,
      exp,
      aud: "appstoreconnect-v1",
    },
    privateKey,
    {
      algorithm: "ES256",
      keyid: creds.keyId,
    },
  );

  cache = { token, expiresAt: exp };
  return token;
}
