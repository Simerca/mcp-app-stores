import jwt from "jsonwebtoken";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

function expandPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

export interface GpServiceAccount {
  client_email: string;
  private_key: string;
}

export function loadGpCredentials(): GpServiceAccount | null {
  const path =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!path) return null;

  const resolved = expandPath(path);
  let raw: string;
  try {
    raw = readFileSync(resolved, "utf8");
  } catch {
    console.error(
      `[gp-auth] SA JSON not found at ${resolved} — Google Play tools disabled.`,
    );
    return null;
  }
  const parsed = JSON.parse(raw);
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error(
      `Invalid Google SA JSON at ${resolved}: missing client_email or private_key`,
    );
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

let cache: CachedToken | null = null;

export async function getGpAccessToken(
  sa: GpServiceAccount,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cache && cache.expiresAt - 60 > now) return cache.token;

  const exp = now + 3600;
  const assertion = jwt.sign(
    {
      iss: sa.client_email,
      scope: SCOPE,
      aud: TOKEN_URL,
      iat: now,
      exp,
    },
    sa.private_key,
    { algorithm: "RS256" },
  );

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    throw new Error(
      `Google token exchange failed: ${res.status} ${await res.text()}`,
    );
  }
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cache = { token: json.access_token, expiresAt: now + json.expires_in };
  return json.access_token;
}
