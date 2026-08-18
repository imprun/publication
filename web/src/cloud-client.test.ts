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
        if (requests.length <= 3) return jsonResponse({});
        if (requests.length === 4) return jsonResponse({ run_id: "run-login", state: "succeeded" });
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
    const inputConfig = JSON.parse(String(requests[2]?.init?.body)) as {
      config: Record<string, string>;
      locked_keys: string[];
    };
    const loginRun = JSON.parse(String(requests[3]?.init?.body)) as {
      input: Record<string, unknown>;
    };

    expect(firstVariable).toMatchObject({ is_secret: true, app_key: "publication" });
    expect(secondVariable).toMatchObject({ is_secret: true, app_key: "publication" });
    expect(inputConfig.config.accountId).toMatch(/^\$var@app:/);
    expect(inputConfig.config.password).toMatch(/^\$var@app:/);
    expect(inputConfig.locked_keys).toEqual(["accountId", "password"]);
    expect(loginRun.input).toEqual({ blogHost: "example.tistory.com" });
    expect(JSON.stringify(loginRun)).not.toContain("account@example.com");
    expect(JSON.stringify(loginRun)).not.toContain("password-value");
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
