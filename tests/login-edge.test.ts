import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type HumanOutcome = "success" | "cancel" | "expired" | "authentication-failure";

function createBrowserHarness(outcome: HumanOutcome) {
  let currentURL = "about:blank";
  let authenticated = false;
  let rootClosed = false;
  let popupClosed = false;
  const loginID = { isVisible: vi.fn(async () => true) };
  const password = { isVisible: vi.fn(async () => true) };
  const saveSignedIn = {
    isVisible: vi.fn(async () => false),
    evaluate: vi.fn(async () => false),
    click: vi.fn(async () => {}),
  };
  const loginLocator = { fill: vi.fn(async () => {}) };
  const passwordLocator = { fill: vi.fn(async () => {}) };
  const originalPage = {
    close: vi.fn(async () => {}),
    evaluate: vi.fn(),
  };
  const originalTarget = {
    opener: () => undefined,
    page: vi.fn(async () => originalPage),
  };
  const targets: Array<{
    opener: () => (typeof rootTarget | typeof originalTarget) | undefined;
    page: () => Promise<typeof page | typeof originalPage | typeof popupPage>;
  }> = [originalTarget];

  const popupPage = {
    isClosed: () => popupClosed,
    close: vi.fn(async () => {
      popupClosed = true;
      const index = targets.indexOf(popupTarget);
      if (index >= 0) targets.splice(index, 1);
    }),
  };
  const popupTarget = {
    opener: () => undefined,
    page: vi.fn(async () => popupPage),
  };
  const submit = {
    isVisible: vi.fn(async () => true),
    click: vi.fn(async () => {
      targets.push(popupTarget);
    }),
  };
  const page = {
    goto: vi.fn(async (url: string) => {
      currentURL = url.includes("/manage/posts/")
        ? authenticated
          ? url
          : "https://accounts.kakao.com/login"
        : "https://accounts.kakao.com/login";
    }),
    url: vi.fn(() => currentURL),
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
    evaluate: vi.fn(async (pageFunction: unknown, argument?: string) => {
      if (argument?.includes("/manage/posts.json")) return outcome === "success";
      const source = String(pageFunction);
      if (source.includes("navigator.userAgent")) return "fixture-user-agent";
      if (source.includes("window.localStorage")) return [{ name: "fixture", value: "local" }];
      if (source.includes("sessionStorage")) return { fixture: "session" };
      return undefined;
    }),
    cookies: vi.fn(async () => [
      {
        name: "session",
        value: "fixture-cookie",
        domain: ".tistory.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ]),
    target: () => rootTarget,
    isClosed: () => rootClosed,
    close: vi.fn(async () => {
      rootClosed = true;
      const index = targets.indexOf(rootTarget);
      if (index >= 0) targets.splice(index, 1);
    }),
  };
  const rootTarget = {
    opener: () => undefined,
    page: vi.fn(async () => page),
  };
  const browserContext = {
    newPage: vi.fn(async () => {
      targets.push(rootTarget);
      return page;
    }),
    close: vi.fn(async () => {
      rootClosed = true;
      popupClosed = true;
      for (const target of [rootTarget, popupTarget]) {
        const index = targets.indexOf(target);
        if (index >= 0) targets.splice(index, 1);
      }
    }),
  };
  browserMocks.connect.mockResolvedValue({
    createBrowserContext: vi.fn(async () => browserContext),
    defaultBrowserContext: vi.fn(() => {
      throw new Error("default BrowserContext must not be used for login");
    }),
    targets: () => [...targets],
    disconnect: browserMocks.disconnect,
  });

  const ctx = mockContext(fetch);
  const setVariable = vi.fn(async (path: string) => ({ path, revision: 1 }));
  const setResource = vi.fn(async (path: string) => ({ path, revision: 1 }));
  ctx.variables.set = setVariable;
  ctx.resources.set = setResource;
  ctx.capabilities = {
    available: ["edge-cdp/v1"],
    headers: { Authorization: "Bearer job-scoped-fixture" },
    has: (capability) => capability === "edge-cdp/v1",
    endpoint: () => "http://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
    webSocketEndpoint: () => "ws://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
  };
  ctx.human.wait = async <T>() => {
    if (outcome === "expired") throw new Error("HumanTask is expired");
    if (outcome === "cancel") return { taskId: "task-test", outcome: "cancel" };
    authenticated = true;
    currentURL = "https://www.tistory.com/";
    return { taskId: "task-test", outcome: "submit", value: { completed: true } as T };
  };

  return {
    ctx,
    page,
    popupPage,
    browserContext,
    originalPage,
    loginLocator,
    passwordLocator,
    submit,
    setVariable,
    setResource,
    targets,
    baselineTargetCount: 1,
  };
}

function expectOwnedTargetsCleaned(harness: ReturnType<typeof createBrowserHarness>) {
  expect(harness.page.close).toHaveBeenCalledOnce();
  expect(harness.browserContext.close).toHaveBeenCalledOnce();
  expect(harness.popupPage.isClosed()).toBe(true);
  expect(harness.originalPage.close).not.toHaveBeenCalled();
  expect(harness.targets).toHaveLength(harness.baselineTargetCount);
  expect(browserMocks.disconnect).toHaveBeenCalledOnce();
}

describe("Tistory Browser Edge login", () => {
  beforeEach(() => {
    browserMocks.connect.mockReset();
    browserMocks.disconnect.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("fails closed before loading Puppeteer when no edge-cdp run is assigned", async () => {
    const ctx = mockContext(fetch);
    await expect(loginToTistory(input, ctx)).rejects.toThrow(
      "requires an assigned edge-cdp BrowserSession",
    );
    expect(browserMocks.connect).not.toHaveBeenCalled();
  });

  it("fails closed when isolated browser context creation does not answer", async () => {
    vi.useFakeTimers();
    const ctx = mockContext(fetch);
    const setVariable = vi.fn(async (path: string) => ({ path, revision: 1 }));
    const setResource = vi.fn(async (path: string) => ({ path, revision: 1 }));
    ctx.variables.set = setVariable;
    ctx.resources.set = setResource;
    ctx.capabilities = {
      available: ["edge-cdp/v1"],
      headers: { Authorization: "Bearer job-scoped-fixture" },
      has: (capability) => capability === "edge-cdp/v1",
      endpoint: () => "http://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
      webSocketEndpoint: () => "ws://127.0.0.1:18092/v1/runs/run-fixture/edge-cdp",
    };
    const createBrowserContext = vi.fn(() => new Promise<never>(() => {}));
    browserMocks.connect.mockResolvedValue({
      createBrowserContext,
      targets: () => [],
      disconnect: browserMocks.disconnect,
    });

    const login = loginToTistory(input, ctx);
    const assertion = expect(login).rejects.toThrow(
      "Tistory isolated browser context creation timed out",
    );
    await vi.waitFor(() => expect(createBrowserContext).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(25_000);
    await assertion;

    expect(setVariable).not.toHaveBeenCalled();
    expect(setResource).not.toHaveBeenCalled();
    expect(browserMocks.disconnect).toHaveBeenCalledOnce();
  });

  it("closes only the created target tree when the HumanTask is canceled", async () => {
    const harness = createBrowserHarness("cancel");

    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow("Tistory login was canceled");

    expect(harness.loginLocator.fill).toHaveBeenCalledWith("fixture@example.invalid");
    expect(harness.passwordLocator.fill).toHaveBeenCalledWith("fixture-only");
    expect(harness.submit.click).toHaveBeenCalledOnce();
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });

  it("restores the target baseline when the HumanTask expires", async () => {
    const harness = createBrowserHarness("expired");

    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow("HumanTask is expired");

    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });

  it("waits for the management API and stores only an authenticated session", async () => {
    const harness = createBrowserHarness("success");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      provider: "tistory",
      connectionId: "default",
      authenticated: true,
    });

    expect(harness.page.cookies).toHaveBeenCalledWith(
      "https://example.tistory.com/",
      "https://www.tistory.com/",
    );
    expect(harness.originalPage.evaluate).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedTargetsCleaned(harness);
  });

  it("does not store a session when authentication never reaches the read-only API", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("authentication-failure");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).rejects.toThrow(
      "Tistory management session was not established before the login deadline",
    );

    await vi.advanceTimersByTimeAsync(100_000);
    await assertion;

    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });
});
