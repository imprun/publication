import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginToTistory } from "../src/providers/tistory/login.js";
import { mockContext } from "./helpers.js";

const browserMocks = vi.hoisted(() => ({
  close: vi.fn(async () => {}),
  connectOverCDP: vi.fn(),
}));

vi.mock("playwright", () => ({
  chromium: { connectOverCDP: browserMocks.connectOverCDP },
}));

const input = {
  provider: "tistory" as const,
  connectionId: "default" as const,
  blogHost: "example.tistory.com",
  accountId: "fixture@example.invalid",
  password: "fixture-only",
};

describe("Tistory Browser Edge login", () => {
  beforeEach(() => {
    browserMocks.close.mockClear();
    browserMocks.connectOverCDP.mockReset();
  });

  it("fails closed before loading Playwright when no edge-cdp run is assigned", async () => {
    const ctx = mockContext(fetch);
    await expect(loginToTistory(input, ctx)).rejects.toThrow(
      "requires an assigned edge-cdp BrowserSession",
    );
    expect(browserMocks.connectOverCDP).not.toHaveBeenCalled();
  });

  it("connects to the Job-scoped CDP WebSocket and closes on HumanTask cancel", async () => {
    const loginID = { isVisible: vi.fn(async () => true), fill: vi.fn(async () => {}) };
    const password = { isVisible: vi.fn(async () => true), fill: vi.fn(async () => {}) };
    const saveSignedIn = {
      isVisible: vi.fn(async () => false),
      isChecked: vi.fn(async () => false),
      uncheck: vi.fn(async () => {}),
    };
    const page = {
      goto: vi.fn(async () => {}),
      locator: vi.fn((selector: string) => {
        if (selector.includes("loginId")) return loginID;
        if (selector.includes("password")) return password;
        return saveSignedIn;
      }),
      getByText: vi.fn(),
    };
    const browserContext = { newPage: vi.fn(async () => page) };
    browserMocks.connectOverCDP.mockResolvedValue({
      contexts: () => [browserContext],
      close: browserMocks.close,
    });

    const ctx = mockContext(fetch);
    ctx.capabilities = {
      available: ["edge-cdp/v1"],
      headers: { Authorization: "Bearer job-scoped-fixture" },
      has: (capability) => capability === "edge-cdp/v1",
      endpoint: () => "http://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
      webSocketEndpoint: () => "ws://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
    };
    ctx.human.wait = async () => ({ taskId: "task-test", outcome: "cancel" });

    await expect(loginToTistory(input, ctx)).rejects.toThrow("Tistory login was canceled");
    expect(browserMocks.connectOverCDP).toHaveBeenCalledWith(
      "ws://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
      { headers: { Authorization: "Bearer job-scoped-fixture" } },
    );
    expect(page.goto).toHaveBeenCalledWith("https://example.tistory.com/manage/newpost", {
      waitUntil: "domcontentloaded",
    });
    expect(browserMocks.close).toHaveBeenCalledOnce();
  });
});
