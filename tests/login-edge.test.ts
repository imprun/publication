import { beforeEach, describe, expect, it, vi } from "vitest";
import { loginToTistory } from "../src/providers/tistory/login.js";
import { mockContext } from "./helpers.js";

const browserMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  disconnect: vi.fn(async () => {}),
}));

vi.mock("puppeteer-core", () => ({
  default: { connect: browserMocks.connect },
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
    browserMocks.connect.mockReset();
    browserMocks.disconnect.mockClear();
  });

  it("fails closed before loading Puppeteer when no edge-cdp run is assigned", async () => {
    const ctx = mockContext(fetch);
    await expect(loginToTistory(input, ctx)).rejects.toThrow(
      "requires an assigned edge-cdp BrowserSession",
    );
    expect(browserMocks.connect).not.toHaveBeenCalled();
  });

  it("connects to the Job-scoped CDP WebSocket and disconnects on HumanTask cancel", async () => {
    const loginID = { isVisible: vi.fn(async () => true) };
    const password = { isVisible: vi.fn(async () => true) };
    const saveSignedIn = {
      isVisible: vi.fn(async () => false),
      evaluate: vi.fn(async () => false),
      click: vi.fn(async () => {}),
    };
    const submit = {
      isVisible: vi.fn(async () => true),
      click: vi.fn(async () => {}),
    };
    const loginLocator = { fill: vi.fn(async () => {}) };
    const passwordLocator = { fill: vi.fn(async () => {}) };
    const page = {
      goto: vi.fn(async () => {}),
      $: vi.fn(async (selector: string) => {
        if (selector.includes("loginId")) return loginID;
        if (selector.includes("password")) return password;
        if (selector.includes('button[type="submit"]')) return submit;
        return saveSignedIn;
      }),
      waitForNavigation: vi.fn(async () => null),
      locator: vi.fn((selector: string) => {
        if (selector.includes("loginId")) return loginLocator;
        return passwordLocator;
      }),
    };
    const browserContext = { newPage: vi.fn(async () => page) };
    browserMocks.connect.mockResolvedValue({
      defaultBrowserContext: () => browserContext,
      disconnect: browserMocks.disconnect,
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
    expect(browserMocks.connect).toHaveBeenCalledWith({
      browserWSEndpoint: "ws://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
      headers: { Authorization: "Bearer job-scoped-fixture" },
    });
    expect(page.goto).toHaveBeenCalledWith("https://example.tistory.com/manage/newpost", {
      waitUntil: "domcontentloaded",
    });
    expect(loginLocator.fill).toHaveBeenCalledWith("fixture@example.invalid");
    expect(passwordLocator.fill).toHaveBeenCalledWith("fixture-only");
    expect(submit.click).toHaveBeenCalledOnce();
    expect(browserMocks.disconnect).toHaveBeenCalledOnce();
  });
});
