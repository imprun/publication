import type { WindforceContext } from "@imprun/app-sdk";
import { z } from "zod";
import { cookieHeaderForHost, type TistoryConnection, type TistorySession } from "../../session.js";
import { normalizeTistoryHost, tistoryOrigin } from "./host.js";

export class TistorySessionExpiredError extends Error {
  override readonly name = "TistorySessionExpiredError";
}

export class TistoryRequestError extends Error {
  override readonly name = "TistoryRequestError";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class TistoryClient {
  readonly host: string;
  readonly origin: string;

  constructor(
    private readonly fetcher: WindforceContext["http"]["fetch"],
    readonly connection: TistoryConnection,
    private readonly session: TistorySession,
  ) {
    this.host = normalizeTistoryHost(connection.blogHost);
    this.origin = tistoryOrigin(this.host);
  }

  async request(path: string, init: RequestInit = {}): Promise<Response> {
    if (!path.startsWith("/manage/")) {
      throw new Error("Tistory adapter only permits /manage/ paths");
    }
    const url = new URL(path, this.origin);
    const headers = new Headers(init.headers);
    headers.set("accept", headers.get("accept") ?? "application/json");
    headers.set("cookie", cookieHeaderForHost(this.session, this.host, url.pathname));
    headers.set("origin", this.origin);
    headers.set("referer", `${this.origin}/manage/newpost`);
    headers.set("user-agent", this.session.userAgent);

    const response = await this.fetcher(url, { ...init, headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location") ?? "";
      if (isAuthenticationLocation(location)) throw new TistorySessionExpiredError();
      throw new TistoryRequestError("Tistory returned an unexpected redirect", response.status);
    }
    if (response.status === 401 || response.status === 403) {
      throw new TistorySessionExpiredError();
    }
    if (!response.ok) {
      throw new TistoryRequestError("Tistory request failed", response.status);
    }
    return response;
  }

  async requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await this.request(path, init);
    const text = await response.text();
    if (looksLikeLoginPage(text)) throw new TistorySessionExpiredError();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TistoryRequestError("Tistory returned a non-JSON response", response.status);
    }
  }
}

function isAuthenticationLocation(location: string): boolean {
  const lower = location.toLowerCase();
  return (
    lower.includes("accounts.kakao.com") ||
    lower.includes("/auth/login") ||
    lower.includes("/auth/kakao")
  );
}

export function looksLikeLoginPage(text: string): boolean {
  const head = text.slice(0, 20_000).toLowerCase();
  return (
    (head.includes("<html") && head.includes('name="loginid"')) ||
    head.includes("accounts.kakao.com/login") ||
    head.includes("카카오계정으로 로그인")
  );
}

const uploadResponseSchema = z.object({
  name: z.string(),
  url: z.string().url(),
  key: z.string().min(1),
  filename: z.string().min(1),
  size: z.number().int().positive(),
});

export async function uploadImage(
  client: TistoryClient,
  bytes: Uint8Array,
  filename: string,
  mimeType: string,
) {
  const form = new FormData();
  const arrayBuffer = Uint8Array.from(bytes).buffer as ArrayBuffer;
  form.append("file", new Blob([arrayBuffer], { type: mimeType }), filename);
  const result = await client.requestJson<unknown>("/manage/post/attach.json", {
    method: "POST",
    body: form,
  });
  return uploadResponseSchema.parse(result);
}
