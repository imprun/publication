import { describe, expect, it, vi } from "vitest";
import { connectionLogin, connectionStatus } from "../src/actions.js";
import {
  TISTORY_ACCOUNT_ID_PATH,
  TISTORY_PASSWORD_PATH,
  TISTORY_SESSION_REFERENCE,
} from "../src/config.js";
import { loginToTistory } from "../src/providers/tistory/login.js";
import { mockContext, sampleConnection, sampleSession } from "./helpers.js";

vi.mock("../src/providers/tistory/login.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/providers/tistory/login.js")>()),
  loginToTistory: vi.fn(),
}));

describe("connection.login", () => {
  it("reads actor credentials, keeps them out of Run input, and clears them after login", async () => {
    const ctx = mockContext(vi.fn(), {
      provider: "tistory",
      connectionId: "default",
      blogHost: "example.tistory.com",
    });
    ctx.variables.get = vi.fn(async (path, scope) => {
      expect(scope).toBe("actor");
      return path === TISTORY_ACCOUNT_ID_PATH ? "account@example.invalid" : "fixture-password";
    });
    ctx.variables.set = vi.fn(async (path) => ({ path, revision: 1 }));
    vi.mocked(loginToTistory).mockResolvedValueOnce({
      provider: "tistory",
      connectionId: "default",
      blogHost: "example.tistory.com",
      publicUrl: "https://example.tistory.com/",
      capturedAt: "2026-08-18T00:00:00.000Z",
      authenticated: true,
      status: "ready",
    });

    await expect(connectionLogin(ctx)).resolves.toMatchObject({ status: "ready" });
    expect(loginToTistory).toHaveBeenCalledWith(
      expect.objectContaining({
        blogHost: "example.tistory.com",
        accountId: "account@example.invalid",
        password: "fixture-password",
      }),
      ctx,
    );
    expect(ctx.variables.set).toHaveBeenCalledTimes(2);
    expect(ctx.variables.set).toHaveBeenCalledWith(
      TISTORY_ACCOUNT_ID_PATH,
      "",
      expect.objectContaining({ scope: "actor" }),
    );
    expect(ctx.variables.set).toHaveBeenCalledWith(
      TISTORY_PASSWORD_PATH,
      "",
      expect.objectContaining({ scope: "actor" }),
    );
  });
});

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
