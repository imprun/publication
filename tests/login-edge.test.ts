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

type LoginOutcome = "automatic-success" | "delayed-success" | "authentication-failure";

function createBrowserHarness(outcome: LoginOutcome, startsAtTistoryLogin = false) {
  let currentURL = "about:blank";
  let authenticated = false;
  let submitted = false;
  let authenticationPolls = 0;
  let atKakaoLogin = !startsAtTistoryLogin;
  let rootClosed = false;
  let popupClosed = false;
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
      submitted = true;
      if (outcome === "automatic-success") {
        authenticated = true;
        currentURL = "https://example.tistory.com/manage/newpost";
      }
    }),
  };
  const page = {
    goto: vi.fn(async (url: string) => {
      if (startsAtTistoryLogin && url.includes("/manage/newpost")) {
        currentURL = "https://www.tistory.com/auth/login";
        return;
      }
      currentURL = url.includes("/manage/posts/")
        ? authenticated
          ? url
          : "https://accounts.kakao.com/login"
        : "https://accounts.kakao.com/login";
    }),
    url: vi.fn(() => {
      if (outcome === "delayed-success" && submitted && !authenticated) {
        authenticationPolls += 1;
        if (authenticationPolls >= 3) {
          authenticated = true;
          currentURL = "https://example.tistory.com/manage/newpost";
        }
      }
      return currentURL;
    }),
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
    evaluate: vi.fn(async (pageFunction: unknown, argument?: string) => {
      if (argument?.includes("/manage/posts.json")) return authenticated;
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
    await vi.waitFor(() => expect(harness.submit.click).toHaveBeenCalledOnce());
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

    expect(harness.loginLocator.fill).toHaveBeenCalledWith("fixture@example.invalid");
    expect(harness.passwordLocator.fill).toHaveBeenCalledWith("fixture-only");
    expect(harness.submit.click).toHaveBeenCalledOnce();
    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).toHaveBeenCalledOnce();
    expect(harness.setResource).toHaveBeenCalledOnce();
    expectOwnedTargetsCleaned(harness);
  });

  it("uses the Tistory DOM login handler without Puppeteer's element click", async () => {
    const harness = createBrowserHarness("automatic-success", true);

    await expect(loginToTistory(input, harness.ctx)).resolves.toMatchObject({
      authenticated: true,
    });

    expect(harness.kakaoButton.evaluate).toHaveBeenCalledOnce();
    expect(harness.page.goto).not.toHaveBeenCalledWith(
      expect.stringContaining("kauth.kakao.com"),
      expect.anything(),
    );
    expect(harness.loginLocator.fill).toHaveBeenCalledWith("fixture@example.invalid");
    expectOwnedTargetsCleaned(harness);
  });

  it("does not store a session when authentication never reaches the read-only API", async () => {
    vi.useFakeTimers();
    const harness = createBrowserHarness("authentication-failure");
    const login = loginToTistory(input, harness.ctx);
    const assertion = expect(login).rejects.toThrow(
      "Tistory management session was not established before the login deadline",
    );

    await vi.waitFor(() => expect(harness.submit.click).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(610_000);
    await assertion;

    expect(harness.humanWait).not.toHaveBeenCalled();
    expect(harness.setVariable).not.toHaveBeenCalled();
    expect(harness.setResource).not.toHaveBeenCalled();
    expectOwnedTargetsCleaned(harness);
  });
});
