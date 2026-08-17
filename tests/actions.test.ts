import { describe, expect, it, vi } from "vitest";
import { connectionStatus } from "../src/actions.js";
import { TISTORY_SESSION_REFERENCE } from "../src/config.js";
import { mockContext, sampleConnection, sampleSession } from "./helpers.js";

describe("connection.status", () => {
  it("loads the encrypted App session reference and performs only the read-only status request", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const ctx = mockContext(fetcher);
    ctx.resources.get = async () => ({
      ...sampleConnection(),
      sessionSecretRef: TISTORY_SESSION_REFERENCE,
    });
    ctx.variables.get = async () => JSON.stringify(sampleSession());

    await expect(connectionStatus(ctx)).resolves.toMatchObject({
      provider: "tistory",
      connectionId: "default",
      blogHost: "example.tistory.com",
      authenticated: true,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(String(url)).toContain("/manage/posts.json?");
    expect(init?.method).toBeUndefined();
    expect(new Headers(init?.headers).get("cookie")).toContain("TSSESSION=");
  });
});
