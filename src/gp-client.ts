import { getGpAccessToken, type GpServiceAccount } from "./gp-auth.js";

const BASE = "https://androidpublisher.googleapis.com/androidpublisher/v3";
const UPLOAD_BASE =
  "https://androidpublisher.googleapis.com/upload/androidpublisher/v3";

export type QueryValue = string | number | boolean | undefined;

export class GpClient {
  constructor(private sa: GpServiceAccount) {}

  async request<T = unknown>(
    method: string,
    path: string,
    opts: {
      query?: Record<string, QueryValue>;
      body?: unknown;
      rawBody?: ArrayBuffer | Buffer;
      contentType?: string;
      upload?: boolean;
    } = {},
  ): Promise<T> {
    const base = opts.upload ? UPLOAD_BASE : BASE;
    const url = new URL(path.startsWith("http") ? path : `${base}${path}`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const token = await getGpAccessToken(this.sa);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    let body: BodyInit | undefined;
    if (opts.rawBody !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/octet-stream";
      if (Buffer.isBuffer(opts.rawBody)) {
        body = (opts.rawBody.buffer as ArrayBuffer).slice(
          opts.rawBody.byteOffset,
          opts.rawBody.byteOffset + opts.rawBody.byteLength,
        );
      } else {
        body = opts.rawBody;
      }
    } else if (opts.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "application/json";
      body =
        typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    }

    const res = await fetch(url, { method, headers, body });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `Google Play ${method} ${url.pathname} → ${res.status}: ${text}`,
      );
    }
    if (res.status === 204) return undefined as T;
    const ct = res.headers.get("content-type") ?? "";
    if (ct.includes("application/json")) return (await res.json()) as T;
    return (await res.text()) as unknown as T;
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }
  post<T = unknown>(
    path: string,
    body?: unknown,
    query?: Record<string, QueryValue>,
  ) {
    return this.request<T>("POST", path, { body, query });
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, { body });
  }
  put<T = unknown>(path: string, body: unknown) {
    return this.request<T>("PUT", path, { body });
  }
  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }

  async withEdit<T>(
    packageName: string,
    fn: (editId: string) => Promise<T>,
    opts: { commit?: boolean; changesNotSentForReview?: boolean } = {},
  ): Promise<T> {
    const edit = await this.post<{ id: string }>(
      `/applications/${packageName}/edits`,
      {},
    );
    try {
      const result = await fn(edit.id);
      if (opts.commit ?? true) {
        await this.post(
          `/applications/${packageName}/edits/${edit.id}:commit`,
          undefined,
          opts.changesNotSentForReview
            ? { changesNotSentForReview: true }
            : undefined,
        );
      } else {
        await this.delete(`/applications/${packageName}/edits/${edit.id}`);
      }
      return result;
    } catch (err) {
      try {
        await this.delete(`/applications/${packageName}/edits/${edit.id}`);
      } catch {
        // ignore cleanup errors
      }
      throw err;
    }
  }
}
