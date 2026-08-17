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
  | "oauth-approval"
  | "authentication-failure"
  | "credential-failure"
  | "untrusted-continuation";

function createBrowserHarness(outcome: LoginOutcome, startsAtTistoryLogin = false) {
  let currentURL = "about:blank";
  let authenticated = false;
  let authenticationPolls = 0;
  let atKakaoLogin = !startsAtTistoryLogin;
  let rootClosed = false;
  let popupClosed = false;
  let rawPasswordSent = false;
  let securityContextMatches = false;
  const kakaoAuthenticate = vi.fn();
  const kakaoTMSPoll = vi.fn();
  const kakaoOAuthApproval = vi.fn();
  const loginID = {
    isVisible: vi.fn(async () => atKakaoLogin),
    evaluate: vi.fn(async () => "loginKey"),
  };
  const password = { isVisible: vi.fn(async () => atKakaoLogin) };
  const kakaoButton = {
    isVisible: vi.fn(async () => true),
    evaluate: vi.fn(async () => {
      atKakaoLogin = true;
      currentURL = "https://accounts.kakao.com/login/";
    }),
  };
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
      if (startsAtTistoryLogin && url.includes("/manage/newpost")) {
        currentURL = "https://www.tistory.com/auth/login";
        return;
      }
      if (url.includes("/auth/kakao/redirect")) {
        authenticated = true;
        currentURL = "https://example.tistory.com/manage/newpost";
        return;
      }
      if (url.includes("kauth.kakao.com/oauth/authorize")) {
        currentURL = url;
        return;
      }
      currentURL = url.includes("/manage/posts/")
        ? authenticated
          ? url
          : "https://accounts.kakao.com/login"
        : "https://accounts.kakao.com/login";
    }),
    url: vi.fn(() => currentURL),
    $: vi.fn(async (selector: string) => {
      if (selector.includes("loginId") || selector.includes("loginKey")) return loginID;
      if (selector.includes("password")) return password;
      if (selector === "a.btn_login.link_kakao_id") return kakaoButton;
      if (selector.includes('button[type="submit"]')) return submit;
      return saveSignedIn;
    }),
    waitForNavigation: vi.fn(async () => null),
    waitForSelector: vi.fn(async (selector: string) => {
      if (selector.includes("a.btn_login.link_kakao_id") && !atKakaoLogin) return kakaoButton;
      if (selector.includes("loginId") || selector.includes("loginKey")) return loginID;
      if (selector.includes("password")) return password;
      if (selector.includes('button[type="submit"]')) return submit;
      return null;
    }),
    locator: vi.fn((selector: string) => {
      if (selector.includes("loginId") || selector.includes("loginKey")) return loginLocator;
      return passwordLocator;
    }),
    evaluate: vi.fn(async (pageFunction: unknown, argument?: unknown) => {
      const source = String(pageFunction);
      if (source.includes("#__NEXT_DATA__")) {
        return {
          accountInputName: "loginKey",
          csrf: "fixture-csrf",
          encryptionPassphrase: "fixture-passphrase",
          loginUrl: "fixture-login-url",
          locale: "ko",
          botSignals: [44],
          userAgentHints: {
            a: "783836",
            b: "3634",
            m: "",
            mo: 0,
            p: "57696e646f7773",
            pv: "31352e30",
          },
        };
      }
      if (argument && typeof argument === "object") {
        const request = argument as {
          endpoint?: string;
          body?: Record<string, unknown>;
        };
        if (request.endpoint?.includes("/login/authenticate.json")) {
          kakaoAuthenticate();
          rawPasswordSent = request.body?.password === "fixture-only";
          const securityContext = request.body?.security_context as
            | {
                a?: unknown;
                b?: { m?: unknown; mo?: unknown };
                c?: unknown;
                d?: unknown;
              }
            | undefined;
          securityContextMatches =
            Array.isArray(securityContext?.a) &&
            securityContext.a.length === 0 &&
            typeof securityContext.b?.m === "string" &&
            typeof securityContext.b?.mo === "number" &&
            securityContext.c === true &&
            Array.isArray(securityContext.d) &&
            securityContext.d.includes(44);
          if (outcome === "automatic-success") {
            return {
              httpStatus: 200,
              status: 0,
              continueUrl: "https://www.tistory.com/auth/kakao/redirect",
            };
          }
          if (outcome === "oauth-approval") {
            return {
              httpStatus: 200,
              status: 0,
              continueUrl: "https://kauth.kakao.com/oauth/authorize?client_id=fixture",
            };
          }
          if (outcome === "credential-failure") {
            return { httpStatus: 200, status: -450 };
          }
          if (outcome === "untrusted-continuation") {
            return {
              httpStatus: 200,
              status: 0,
              continueUrl: "https://example.invalid/oauth/callback?code=fixture",
            };
          }
          return { httpStatus: 200, status: -451, token: "fixture-tms-token" };
        }
        if (request.endpoint?.includes("/verify_tms_for_login.json")) {
          kakaoTMSPoll();
          authenticationPolls += 1;
          if (outcome === "delayed-success" && authenticationPolls >= 3) {
            return {
              httpStatus: 200,
              status: 0,
              continueUrl: "https://www.tistory.com/auth/kakao/redirect",
            };
          }
          return { httpStatus: 200, status: -451 };
        }
      }
      if (typeof argument === "string" && argument.includes("/manage/posts.json")) {
        return authenticated;
      }
      if (source.includes("document.forms") && source.includes("user_oauth_approval")) {
        if (!currentURL.includes("kauth.kakao.com/oauth/authorize")) return false;
        if (source.includes("HTMLFormElement.prototype.submit")) {
          kakaoOAuthApproval();
          authenticated = true;
          currentURL = "https://www.tistory.com/";
          return undefined;
        }
        return true;
      }
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
  const humanWait = vi.fn(async () => {
    throw new Error("HumanTask must not be used for observable browser authentication");
  });
  ctx.human.wait = humanWait as typeof ctx.human.wait;

  return {
    ctx,
    page,
    popupPage,
    browserContext,
    originalPage,
    loginLocator,
    passwordLocator,
    kakaoButton,
    submit,
    kakaoAuthenticate,
    kakaoTMSPoll,
    kakaoOAuthApproval,
    rawPasswordSent: () => rawPasswordSent,
    securityContextMatches: () => securityContextMatches,
    humanWait,
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

  it("rejects a login without account inputs instead of falling back to manual browser login", async () => {
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

  it("polls until delayed browser authentication reaches the management API", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("delayed-success");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).resolves.toMatchObject({
      provider: "tistory",
      connectionId: "default",
      authenticated: true,
    });
    await vi.waitFor(() => expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;

    expect(harness.page.cookies).toHaveBeenCalledWith(
      "https://example.tistory.com/",
      "https://www.tistory.com/",
    );
    expect(harness.originalPage.evaluate).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expect(harness.humanWait).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });

  it("stores an automatically authenticated account without creating a HumanTask", async () => {
    const harness = createBrowserHarness("automatic-success");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      authenticated: true,
    });

    expect(harness.loginLocator.fill).not.toHaveBeenCalled();
    expect(harness.passwordLocator.fill).not.toHaveBeenCalled();
    expect(harness.submit.click).not.toHaveBeenCalled();
    expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce();
    expect(harness.rawPasswordSent()).toBe(false);
    expect(harness.securityContextMatches()).toBe(true);
    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedTargetsCleaned(harness);
  });

  it("submits the Kakao OAuth approval form before verifying the Tistory session", async () => {
    const harness = createBrowserHarness("oauth-approval");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      authenticated: true,
    });

    expect(harness.page.goto).toHaveBeenCalledWith(
      expect.stringContaining("kauth.kakao.com/oauth/authorize"),
      expect.anything(),
    );
    expect(harness.kakaoOAuthApproval).toHaveBeenCalledOnce();
    expect(harness.loginLocator.fill).not.toHaveBeenCalled();
    expect(harness.passwordLocator.fill).not.toHaveBeenCalled();
    expect(harness.submit.click).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedTargetsCleaned(harness);
  });

  it("uses the Tistory DOM only to bootstrap Kakao before HTTP authentication", async () => {
    const harness = createBrowserHarness("automatic-success", true);

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      authenticated: true,
    });

    expect(harness.kakaoButton.evaluate).toHaveBeenCalledOnce();
    expect(harness.page.goto).not.toHaveBeenCalledWith(
      expect.stringContaining("kauth.kakao.com"),
      expect.anything(),
    );
    expect(harness.loginLocator.fill).not.toHaveBeenCalled();
    expect(harness.passwordLocator.fill).not.toHaveBeenCalled();
    expect(harness.submit.click).not.toHaveBeenCalled();
    expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce();
    expect(harness.rawPasswordSent()).toBe(false);
    expect(harness.securityContextMatches()).toBe(true);
    expectOwnedTargetsCleaned(harness);
  });

  it("does not store a session when authentication never reaches the read-only API", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("authentication-failure");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).rejects.toThrow(
      "Kakao two-step verification did not complete before the login deadline",
    );

    await vi.waitFor(() => expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(610_000);
    await assertion;

    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });

  it("fails closed on rejected credentials without storing or leaking a session", async () => {
    const harness = createBrowserHarness("credential-failure");

    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow(
      "Kakao credential authentication was not accepted (status -450, HTTP 200)",
    );

    expect(harness.rawPasswordSent()).toBe(false);
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });

  it("rejects an untrusted OAuth continuation without exposing its query", async () => {
    const harness = createBrowserHarness("untrusted-continuation");

    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow(
      "Kakao login returned an untrusted continuation URL",
    );

    expect(harness.page.goto).not.toHaveBeenCalledWith(
      expect.stringContaining("example.invalid"),
      expect.anything(),
    );
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });
});
