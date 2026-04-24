import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

export interface ProductMapping {
  appstore?: { appId: string };
  playstore?: { packageName: string };
}

export type AppsMap = Record<string, ProductMapping>;

function expandPath(p: string): string {
  if (p.startsWith("~/")) return resolve(homedir(), p.slice(2));
  return resolve(p);
}

function candidatePaths(): string[] {
  const explicit = process.env.APPS_MAPPING_PATH;
  if (explicit) return [expandPath(explicit)];
  return [
    resolve(process.cwd(), "apps.json"),
    expandPath("~/.mcp-app-stores/apps.json"),
  ];
}

let cached: AppsMap | null = null;

export function loadMapping(): AppsMap {
  if (cached) return cached;
  for (const p of candidatePaths()) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, "utf8");
        cached = JSON.parse(raw) as AppsMap;
        return cached;
      } catch (err) {
        throw new Error(`Failed to read apps mapping at ${p}: ${err}`);
      }
    }
  }
  cached = {};
  return cached;
}

export function resolveProduct(key: string): ProductMapping {
  const map = loadMapping();
  const entry = map[key];
  if (!entry) {
    const available = Object.keys(map);
    throw new Error(
      `Unknown product '${key}'. Available: ${available.join(", ") || "(no apps.json found — see README)"}`,
    );
  }
  return entry;
}
