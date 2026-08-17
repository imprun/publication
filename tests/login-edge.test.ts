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

type LoginOutcome =
  | "automatic-success"
  | "delayed-success"
  | "tistory-home"
  | "authentication-failure"
  | "form-unavailable";

function createBrowserHarness(outcome: LoginOutcome) {
  let currentURL = "about:blank";
  let authenticated = false;
  let completionPolls = 0;
  let rootClosed = false;
  let popupClosed = false;
  let submitted = false;
  const tistoryAuthState = vi.fn();
  const kakaoAuthorize = vi.fn();
  const kakaoPageJavaScriptSubmit = vi.fn();
  const originalPage = {
    close: vi.fn(async () => {}),
  };
  const managementNavigations: string[] = [];

  const popupPage = {
    isClosed: () => popupClosed,
    close: vi.fn(async () => {
      popupClosed = true;
    }),
  };

  const page = {
    goto: vi.fn(async (url: string) => {
      if (url.includes("www.tistory.com/auth/login")) {
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
      if (outcome === "delayed-success" && submitted && !authenticated) {
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
        return {
          httpStatus: 200,
          ready: true,
          state: "fixture-state",
        };
      }
      if (source.includes("authorize.call") && typeof argument === "string") {
        kakaoAuthorize();
        currentURL = "https://accounts.kakao.com/login/";
        return undefined;
      }
      if (source.includes("form.requestSubmit") && argument && typeof argument === "object") {
        kakaoPageJavaScriptSubmit();
        submitted = true;
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
    waitForFunction: vi.fn(async (pageFunction: unknown) => {
      const source = String(pageFunction);
      if (source.includes("input[name") && outcome === "form-unavailable") {
        throw new Error("fixture form unavailable");
      }
      return undefined;
    }),
    waitForNavigation: vi.fn(async () => ({})),
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
    kakaoPageJavaScriptSubmit,
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

  it("requires account inputs before opening a browser context", async () => {
    const ctx = mockContext(fetch);

    await expect(
      loginToTistory({ ...input, accountId: undefined, password: undefined }, ctx),
    ).rejects.toThrow("requires accountId and password inputs");

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

  it("uses Kakao SDK authorization and Kakao page JavaScript to submit credentials", async () => {
    const harness = createBrowserHarness("automatic-success");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      provider: "tistory",
      connectionId: "default",
      authenticated: true,
    });

    expect(harness.tistoryAuthState).toHaveBeenCalledOnce();
    expect(harness.kakaoAuthorize).toHaveBeenCalledOnce();
    expect(harness.kakaoPageJavaScriptSubmit).toHaveBeenCalledOnce();
    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedPagesCleaned(harness);
  });

  it("leaves the Kakao page intact while browser JavaScript completes two-step verification", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("delayed-success");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).resolves.toMatchObject({ authenticated: true });

    await vi.waitFor(() => expect(harness.kakaoPageJavaScriptSubmit).toHaveBeenCalledOnce());
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

  it("fails closed when Kakao page JavaScript is unavailable", async () => {
    const harness = createBrowserHarness("form-unavailable");

    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow(
      "Kakao login JavaScript did not become ready",
    );

    expect(harness.kakaoPageJavaScriptSubmit).not.toHaveBeenCalled();
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

    await vi.waitFor(() => expect(harness.kakaoPageJavaScriptSubmit).toHaveBeenCalledOnce());
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
