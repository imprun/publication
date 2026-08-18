import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudPublicationClient } from "./cloud-client";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CloudPublicationClient", () => {
  it("stores Kakao credentials only through secret variables before creating login Run", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), init });
        if (requests.length <= 2) return jsonResponse({});
        if (requests.length === 3) return jsonResponse({ run_id: "run-login", state: "succeeded" });
        return jsonResponse({ blogHost: "example.tistory.com", authenticated: true });
      }),
    );
    const client = new CloudPublicationClient({
      baseUrl: "https://tenant.cloud.imprun.dev",
      workspace: "default",
      accessToken: () => "identity-access-token",
    });

    await client.connect({
      blogHost: "https://example.tistory.com/",
      accountId: "account@example.com",
      password: "password-value",
    });

    const firstVariable = JSON.parse(String(requests[0]?.init?.body)) as Record<string, unknown>;
    const secondVariable = JSON.parse(String(requests[1]?.init?.body)) as Record<string, unknown>;
    const loginRun = JSON.parse(String(requests[2]?.init?.body)) as {
      input: Record<string, unknown>;
    };

    expect(firstVariable).toMatchObject({
      is_secret: true,
      app_key: "publication",
      scope: "actor",
    });
    expect(secondVariable).toMatchObject({
      is_secret: true,
      app_key: "publication",
      scope: "actor",
    });
    expect(loginRun.input).toEqual({ blogHost: "example.tistory.com" });
    expect(JSON.stringify(loginRun)).not.toContain("account@example.com");
    expect(JSON.stringify(loginRun)).not.toContain("password-value");
  });

  it("reads and disconnects only through actor-scoped connection actions", async () => {
    const actions: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body
          ? (JSON.parse(String(init.body)) as { action?: string })
          : undefined;
        if (body?.action) actions.push(body.action);
        if (body?.action === "connection.status") {
          return jsonResponse({ run_id: "run-status", state: "succeeded" });
        }
        if (body?.action === "connection.disconnect") {
          return jsonResponse({ run_id: "run-disconnect", state: "succeeded" });
        }
        return jsonResponse({
          blogHost: "example.tistory.com",
          authenticated: actions.at(-1) === "connection.status",
          status: actions.at(-1) === "connection.status" ? "ready" : "missing",
        });
      }),
    );
    const client = new CloudPublicationClient({
      baseUrl: "https://tenant.cloud.imprun.dev",
      workspace: "default",
      accessToken: () => "identity-access-token",
    });

    await expect(client.connection()).resolves.toMatchObject({ status: "ready" });
    await expect(client.disconnect()).resolves.toMatchObject({ status: "missing" });
    expect(actions).toEqual(["connection.status", "connection.disconnect"]);
  });

  it("requires a HumanTask decision with an idempotency key before returning publish result", async () => {
    vi.useFakeTimers();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        requests.push({ url, init });
        if (url.endsWith("/runs") && init?.method === "POST") {
          return jsonResponse({ run_id: "run-publish", state: "running" });
        }
        if (url.includes("human-tasks?state=pending")) {
          return jsonResponse({
            items: [
              {
                id: "task-publish",
                run_id: "run-publish",
                title: "Approve publication",
                expires_at: "2026-08-18T12:00:00Z",
              },
            ],
          });
        }
        if (url.endsWith("/human-tasks/task-publish/decision")) return jsonResponse({});
        if (url.endsWith("/runs/run-publish")) {
          return jsonResponse({ run_id: "run-publish", state: "succeeded" });
        }
        if (url.endsWith("/runs/run-publish/result")) {
          return jsonResponse({
            provider: "tistory",
            connectionId: "default",
            postId: "123",
            entryUrl: "https://example.tistory.com/entry/test",
            visibility: "private",
            representativeImageApplied: false,
          });
        }
        throw new Error(`Unexpected request: ${url}`);
      }),
    );
    const client = new CloudPublicationClient({
      baseUrl: "https://tenant.cloud.imprun.dev",
      workspace: "default",
      accessToken: () => "identity-access-token",
    });
    const approval = await client.requestPublish({
      draft: {
        provider: "tistory",
        connectionId: "default",
        title: "Test",
        content: { format: "markdown", body: "# Test" },
        tags: [],
        categoryId: 0,
      },
      draftHash: `sha256:${"a".repeat(64)}`,
      visibility: "private",
    });
    expect(approval.taskId).toBe("task-publish");

    const resultPromise = client.approvePublish(approval);
    await vi.runAllTimersAsync();
    const result = await resultPromise;
    const decision = requests.find((request) =>
      request.url.endsWith("/human-tasks/task-publish/decision"),
    );
    const decisionHeaders = new Headers(decision?.init?.headers);
    expect(decisionHeaders.get("Idempotency-Key")).toMatch(/^publication-web-publish-approval-/);
    expect(JSON.parse(String(decision?.init?.body))).toEqual({
      outcome: "submit",
      value: { approved: true },
    });
    expect(result.entryUrl).toBe("https://example.tistory.com/entry/test");
  });
});
