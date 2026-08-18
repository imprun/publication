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
  | "captcha-success"
  | "two-step-success"
  | "late-two-step-success"
  | "oauth-confirmation"
  | "tistory-home"
  | "authentication-failure"
  | "runtime-unavailable"
  | "sdk-unavailable"
  | "auth-state-failure";

function createBrowserHarness(outcome: LoginOutcome) {
  let currentURL = "about:blank";
  let authenticated = false;
  let rootClosed = false;
  let popupClosed = false;
  let verificationPolls = 0;
  const tistoryAuthState = vi.fn();
  const kakaoAuthorize = vi.fn();
  const kakaoAuthenticate = vi.fn();
  const kakaoCaptchaRender = vi.fn();
  const kakaoVerificationPoll = vi.fn();
  const kakaoOAuthApproval = vi.fn();
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
    url: vi.fn(() => currentURL),
    evaluate: vi.fn(async (pageFunction: unknown, argument?: unknown) => {
      const source = String(pageFunction);
      if (source.includes("stateEndpoint")) {
        tistoryAuthState();
        return outcome === "auth-state-failure"
          ? { ready: false }
          : { ready: true, state: "fixture-state" };
      }
      if (source.includes("authorize.call") && argument && typeof argument === "object") {
        kakaoAuthorize(argument);
        currentURL = "https://accounts.kakao.com/login/";
        return true;
      }
      if (source.includes("loginState.loginInput") && source.includes("captchaToken")) {
        return "two-step-pending";
      }
      if (source.includes("dkaptcha") && source.includes('document.createElement("main")')) {
        kakaoCaptchaRender();
        return true;
      }
      if (source.includes('client.call("authenticate"')) {
        kakaoAuthenticate(argument);
        if (outcome === "runtime-unavailable") return "runtime-unavailable";
        if (outcome === "authentication-failure") return "two-step-pending";
        if (outcome === "two-step-success" || outcome === "late-two-step-success") {
          return "two-step-pending";
        }
        if (outcome === "captcha-success") return "captcha-required";
        if (outcome === "oauth-confirmation") {
          currentURL = "https://kauth.kakao.com/oauth/authorize";
          return "navigating";
        }
        authenticated = true;
        currentURL =
          outcome === "tistory-home"
            ? "https://www.tistory.com/"
            : "https://example.tistory.com/manage/newpost";
        return "navigating";
      }
      if (source.includes("check_tms_for_two_step_verification")) {
        kakaoVerificationPoll();
        verificationPolls += 1;
        const approved =
          (outcome === "two-step-success" && verificationPolls >= 2) ||
          (outcome === "late-two-step-success" && verificationPolls >= 1) ||
          outcome === "captcha-success";
        if (approved) {
          if (outcome === "late-two-step-success") {
            vi.setSystemTime(Date.now() + 10 * 60 * 1000);
          }
          authenticated = true;
          currentURL = "https://example.tistory.com/manage/newpost";
          return "navigating";
        }
        return "two-step-pending";
      }
      if (source.includes("user_oauth_approval") && source.includes("requestSubmit")) {
        kakaoOAuthApproval();
        authenticated = true;
        currentURL = "https://example.tistory.com/manage/newpost";
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
    evaluateOnNewDocument: vi.fn(async () => ({ identifier: "fixture-runtime-probe" })),
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
    tistoryAuthState,
    kakaoAuthorize,
    kakaoAuthenticate,
    kakaoCaptchaRender,
    kakaoVerificationPoll,
    kakaoOAuthApproval,
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
    expect(browserMocks.disconnect).toHaveBeenCalledOnce();
  });

  it("uses Kakao page JavaScript without inspecting or clicking login controls", async () => {
    const harness = createBrowserHarness("automatic-success");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      provider: "tistory",
      connectionId: "default",
      authenticated: true,
    });

    expect(harness.tistoryAuthState).toHaveBeenCalledOnce();
    expect(harness.kakaoAuthorize).toHaveBeenCalledOnce();
    expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce();
    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedPagesCleaned(harness);
  });

  it("polls Kakao two-step verification every second until approval", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("two-step-success");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).resolves.toMatchObject({ authenticated: true });

    await vi.waitFor(() => expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_100);
    await assertion;

    expect(harness.kakaoVerificationPoll).toHaveBeenCalledTimes(2);
    expect(harness.managementNavigations).toEqual([]);
    expectOwnedPagesCleaned(harness);
  });

  it("gives Tistory session establishment a fresh deadline after late Kakao approval", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("late-two-step-success");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).resolves.toMatchObject({ authenticated: true });

    await vi.waitFor(() => expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(1_100);
    await assertion;

    expect(harness.kakaoVerificationPoll).toHaveBeenCalledOnce();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedPagesCleaned(harness);
  });

  it("continues Tistory OAuth confirmation through page JavaScript", async () => {
    const harness = createBrowserHarness("oauth-confirmation");

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      authenticated: true,
    });

    expect(harness.kakaoOAuthApproval).toHaveBeenCalledOnce();
    expect(harness.humanWait).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("renders Kakao dKaptcha and retries through the page client without login controls", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("captcha-success");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).resolves.toMatchObject({ authenticated: true });

    await vi.waitFor(() => expect(harness.kakaoCaptchaRender).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_100);
    await assertion;

    expect(harness.kakaoVerificationPoll).toHaveBeenCalledOnce();
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
      "Tistory Kakao SDK did not initialize",
    );
    expect(harness.kakaoAuthenticate).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("fails closed when Tistory does not issue a Kakao authorization state", async () => {
    const harness = createBrowserHarness("auth-state-failure");
    await expect(loginToTistory(input, harness.ctx)).rejects.toThrow(
      "Tistory Kakao authorization failed",
    );
    expect(harness.kakaoAuthenticate).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("fails closed when Kakao page JavaScript is unavailable", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("runtime-unavailable");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).rejects.toThrow(
      "Kakao account JavaScript client did not become ready",
    );
    await vi.waitFor(() => expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(21_000);
    await assertion;
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("does not store a session when approval never completes", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("authentication-failure");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).rejects.toThrow(
      "Kakao two-step verification was not approved before the login deadline",
    );
    await vi.waitFor(() => expect(harness.kakaoAuthenticate).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(610_000);
    await assertion;
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedPagesCleaned(harness);
  });

  it("stores only Tistory cookies in the encrypted session variable", async () => {
    const harness = createBrowserHarness("automatic-success");
    await loginToTistory(input, harness.ctx);
    const serializedSession = harness.setVariable.mock.calls[0]?.[1];
    const session = JSON.parse(String(serializedSession)) as {
      storageState: { cookies: Array<{ domain: string }> };
    };
    expect(session.storageState.cookies.map((cookie) => cookie.domain)).toEqual([".tistory.com"]);
    expectOwnedPagesCleaned(harness);
  });
});
