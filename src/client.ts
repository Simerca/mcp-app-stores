import { getToken, type AscCredentials } from "./auth.js";

const BASE_URL = "https://api.appstoreconnect.apple.com/v1";

export type QueryValue = string | number | undefined;

export class AscClient {
  constructor(private creds: AscCredentials) {}

  async request<T = unknown>(
    method: string,
    path: string,
    opts: { query?: Record<string, QueryValue>; body?: unknown } = {},
  ): Promise<T> {
    const url = new URL(
      path.startsWith("http") ? path : `${BASE_URL}${path}`,
    );
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
    }

    const token = getToken(this.creds);
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(
        `App Store Connect ${method} ${url.pathname} → ${res.status}: ${text}`,
      );
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  get<T = unknown>(path: string, query?: Record<string, QueryValue>) {
    return this.request<T>("GET", path, { query });
  }
  patch<T = unknown>(path: string, body: unknown) {
    return this.request<T>("PATCH", path, { body });
  }
  post<T = unknown>(path: string, body: unknown) {
    return this.request<T>("POST", path, { body });
  }
  delete<T = unknown>(path: string) {
    return this.request<T>("DELETE", path);
  }
}
