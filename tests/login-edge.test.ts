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
};

type LoginOutcome =
  | "automatic-success"
  | "delayed-success"
  | "tistory-home"
  | "authentication-failure"
  | "sdk-unavailable"
  | "auth-state-failure";

function createBrowserHarness(outcome: LoginOutcome) {
  let currentURL = "about:blank";
  let authenticated = false;
  let authorizationStarted = false;
  let completionPolls = 0;
  let rootClosed = false;
  let popupClosed = false;
  const tistoryAuthState = vi.fn();
  const kakaoAuthorize = vi.fn();
  const authorizeArguments: Array<{ state: string; loginHint: string }> = [];
  const originalPage = { close: vi.fn(async () => {}) };
  const managementNavigations: string[] = [];

  const popupPage = {
    isClosed: () => popupClosed,
    close: vi.fn(async () => {
      popupClosed = true;
    }),
  };

  const page = {
    goto: vi.fn(async (url: string) => {
      if (url.startsWith("https://www.tistory.com/auth/login")) {
        currentURL = url;
        return;
      }
      if (url.includes("/manage/posts/")) {
        managementNavigations.push(url);
        currentURL = authenticated ? url : "https://www.tistory.com/auth/login";
        return;
      }
      currentURL = url;
    }),
    url: vi.fn(() => {
      if (outcome === "delayed-success" && authorizationStarted && !authenticated) {
        completionPolls += 1;
        if (completionPolls >= 3) {
          authenticated = true;
          currentURL = "https://example.tistory.com/manage/newpost";
        }
      }
      return currentURL;
    }),
    evaluate: vi.fn(async (pageFunction: unknown, argument?: unknown) => {
      const source = String(pageFunction);
      if (source.includes("stateEndpoint")) {
        tistoryAuthState();
        return outcome === "auth-state-failure"
          ? { ready: false }
          : { ready: true, state: "fixture-state" };
      }
      if (source.includes("authorize.call") && argument && typeof argument === "object") {
        const authorization = argument as { state: string; loginHint: string };
        kakaoAuthorize();
        authorizeArguments.push(authorization);
        authorizationStarted = true;
        if (outcome === "automatic-success") {
          authenticated = true;
          currentURL = "https://example.tistory.com/manage/newpost";
        } else if (outcome === "tistory-home") {
          authenticated = true;
          currentURL = "https://www.tistory.com/";
        } else {
          currentURL = "https://accounts.kakao.com/two_step_verification/";
        }
        return true;
      }
      if (typeof argument === "string" && argument.includes("/manage/posts.json")) {
        return authenticated;
      }
      if (source.includes("navigator.userAgent")) return "fixture-user-agent";
      if (source.includes("window.localStorage")) {
        return [{ name: "fixture", value: "local" }];
      }
      if (source.includes("sessionStorage")) return { fixture: "session" };
      return undefined;
    }),
    waitForFunction: vi.fn(async () => {
      if (outcome === "sdk-unavailable") throw new Error("fixture SDK unavailable");
      return undefined;
    }),
    isClosed: () => rootClosed,
    close: vi.fn(async () => {
      rootClosed = true;
    }),
  };

  const browserContext = {
    pages: vi.fn(async () => [page, popupPage].filter((ownedPage) => !ownedPage.isClosed())),
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
      {
        name: "accounts-session",
        value: "fixture-kakao-cookie",
        domain: ".kakao.com",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: "Lax" as const,
      },
    ]),
    newPage: vi.fn(async () => page),
    close: vi.fn(async () => {
      rootClosed = true;
      popupClosed = true;
    }),
  };

  browserMocks.connect.mockResolvedValue({
    createBrowserContext: vi.fn(async () => browserContext),
    defaultBrowserContext: vi.fn(() => {
      throw new Error("default BrowserContext must not be used for login");
    }),
    disconnect: browserMocks.disconnect,
  });

  const ctx = mockContext(fetch);
  const setVariable = vi.fn(async (path: string, _value: unknown) => ({ path, revision: 1 }));
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
  const humanWait = vi.fn(async () => {
    throw new Error("HumanTask must not be used for browser-observable authentication");
  });
  ctx.human.wait = humanWait as typeof ctx.human.wait;

  return {
    ctx,
    page,
    popupPage,
    browserContext,
    originalPage,
    tistoryAuthState,
    kakaoAuthorize,
    authorizeArguments,
    humanWait,
    setVariable,
    setResource,
    managementNavigations,
  };
}

function expectOwnedPagesCleaned(harness: ReturnType<typeof createBrowserHarness>) {
  expect(harness.page.close).toHaveBeenCalledOnce();
  expect(harness.browserContext.close).toHaveBeenCalledOnce();
  expect(harness.popupPage.isClosed()).toBe(true);
  expect(harness.originalPage.close).not.toHaveBeenCalled();
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

  it("requires an account hint before opening a browser context", async () => {
    const ctx = mockContext(fetch);
    await expect(loginToTistory({ ...input, accountId: undefined }, ctx)).rejects.toThrow(
      "requires an accountId input",
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

  it("calls Kakao.Auth.authorize directly with Tistory state and loginHint", async () => {
    const harness = createBrowserHarness("automatic-success");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      provider: "tistory",
      connectionId: "default",
      authenticated: true,
    });

    expect(harness.page.goto).toHaveBeenNthCalledWith(
      1,
      "https://www.tistory.com/auth/login?redirectUrl=https%3A%2F%2Fexample.tistory.com%2Fmanage%2Fnewpost",
      { waitUntil: "domcontentloaded", timeout: 30_000 },
    );
    expect(harness.tistoryAuthState).toHaveBeenCalledOnce();
    expect(harness.kakaoAuthorize).toHaveBeenCalledOnce();
    expect(harness.authorizeArguments).toEqual([
      { state: "fixture-state", loginHint: input.accountId },
    ]);
    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedPagesCleaned(harness);
  });

  it("polls the browser-observable Tistory session while Kakao approval completes", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("delayed-success");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).resolves.toMatchObject({ authenticated: true });

    await vi.waitFor(() => expect(harness.kakaoAuthorize).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;

    expect(harness.managementNavigations).toEqual([]);
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedPagesCleaned(harness);
  });

  it("navigates to the read-only management check only after Kakao returns to Tistory", async () => {
    const harness = createBrowserHarness("tistory-home");
    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      authenticated: true,
    });
    expect(harness.managementNavigations).toEqual(["https://example.tistory.com/manage/posts/"]);
    expectOwnedPagesCleaned(harness);
  });

  it("fails closed when the Tistory Kakao SDK is unavailable", async () => {
    const harness = createBrowserHarness("sdk-unavailable");
    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow(
      "Tistory Kakao SDK did not initialize before the login deadline",
    );
    expect(harness.kakaoAuthorize).not.toHaveBeenCalled();
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("fails closed when Tistory does not issue a Kakao authorization state", async () => {
    const harness = createBrowserHarness("auth-state-failure");
    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow(
      "Tistory Kakao authorization failed",
    );
    expect(harness.kakaoAuthorize).not.toHaveBeenCalled();
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("does not store a session when authentication never reaches Tistory", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("authentication-failure");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).rejects.toThrow(
      "Tistory management session was not established before the login deadline",
    );

    await vi.waitFor(() => expect(harness.kakaoAuthorize).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(610_000);
    await assertion;

    expect(harness.managementNavigations).toEqual([]);
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("stores only Tistory cookies in the encrypted session variable", async () => {
    const harness = createBrowserHarness("automatic-success");
    await loginToTistory(input, harness.ctx);
    const serializedSession = harness.setVariable.mock.calls[0]?.[1];
    expect(typeof serializedSession).toBe("string");
    const session = JSON.parse(String(serializedSession)) as {
      storageState: { cookies: Array<{ domain: string }> };
    };
    expect(session.storageState.cookies.map((cookie) => cookie.domain)).toEqual([".tistory.com"]);
    expectOwnedPagesCleaned(harness);
  });
});
