import { describe, expect, it, vi } from "vitest";
import {
  looksLikeLoginPage,
  TistoryClient,
  TistorySessionExpiredError,
} from "../src/providers/tistory/client.js";
import { sampleConnection, sampleSession } from "./helpers.js";

describe("TistoryClient", () => {
  it("sends the captured cookie and browser identity on direct HTTP", async () => {
    const fetcher = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) => new Response('{"ok":true}'),
    );
    const client = new TistoryClient(fetcher, sampleConnection(), sampleSession());
    await client.requestJson("/manage/category.json");
    const [, init] = fetcher.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get("cookie")).toContain("TSSESSION=");
    expect(headers.get("user-agent")).toBe("publication-test-agent");
    expect(init?.redirect).toBe("manual");
  });

  it("treats redirects and 200 login HTML as expired sessions", async () => {
    const redirected = new TistoryClient(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://accounts.kakao.com/login" },
        }),
      sampleConnection(),
      sampleSession(),
    );
    await expect(redirected.request("/manage/category.json")).rejects.toBeInstanceOf(
      TistorySessionExpiredError,
    );

    const html = new TistoryClient(
      async () => new Response('<html><input name="loginId"></html>'),
      sampleConnection(),
      sampleSession(),
    );
    await expect(html.requestJson("/manage/category.json")).rejects.toBeInstanceOf(
      TistorySessionExpiredError,
    );
    expect(looksLikeLoginPage('<html><input name="loginId"></html>')).toBe(true);
  });
});
