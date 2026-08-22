import { randomUUID } from "node:crypto";
import type { WindforceContext } from "@imprun/app-sdk";
import type { BrowserContext, Page } from "puppeteer-core";
import {
  TISTORY_CONNECTION_RESOURCE_TYPE,
  TISTORY_PROFILE_PATH,
  TISTORY_SESSION_PATH,
  TISTORY_SESSION_REFERENCE,
} from "../../config.js";
import type { ConnectionLoginInput } from "../../contracts.js";
import type { TistoryConnection, TistorySession } from "../../session.js";
import { normalizeTistoryHost, tistoryOrigin } from "./host.js";

export interface TistoryLoginResult {
  provider: "tistory";
  connectionId: "default";
  blogHost: string;
  publicUrl: string;
  capturedAt: string;
  authenticated: true;
  status: "ready";
}

const KAKAO_AUTHENTICATION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const TISTORY_SESSION_WAIT_TIMEOUT_MS = 4 * 60 * 1000;
const AUTHENTICATION_POLL_INTERVAL_MS = 1_000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 30_000;
const BROWSER_CONTEXT_CREATION_TIMEOUT_MS = 20_000;
const BROWSER_PAGE_CREATION_TIMEOUT_MS = 20_000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
const KAKAO_SDK_READY_TIMEOUT_MS = 10_000;
const KAKAO_ACCOUNT_JAVASCRIPT_READY_TIMEOUT_MS = 20_000;
const KAKAO_LOGIN_STATE_KEY = "publication.tistory.kakao-login";
const KAKAO_ROOT_MODULE_KEY = "publication.tistory.kakao-root-module";
const KAKAO_CAPTCHA_MAX_ATTEMPTS = 3;
const KAKAO_AUTHORIZATION_HOST = "kauth.kakao.com";
const TISTORY_LOGIN_URL = "https://www.tistory.com/auth/login";
const TISTORY_KAKAO_AUTH_STATE_ENDPOINT = "/api/v1/login/kakaoAuthState";
const TARGET_CLEANUP_TIMEOUT_MS = 5_000;
const TARGET_CLEANUP_POLL_INTERVAL_MS = 50;
const BROWSER_SESSION_PROVIDERS = [
  { capability: "managed-local/v1", endpoint: "managed-local" },
  { capability: "edge-cdp/v1", endpoint: "edge-cdp" },
] as const;

function assignedBrowserSession(ctx: WindforceContext) {
  const assigned = BROWSER_SESSION_PROVIDERS.filter(({ capability }) =>
    ctx.capabilities?.has(capability),
  );
  const provider = assigned[0];
  if (assigned.length !== 1 || !provider || !ctx.capabilities) {
    throw new Error("Tistory login requires exactly one assigned BrowserSession provider");
  }
  return { capabilities: ctx.capabilities, provider };
}

export async function loginToTistory(input: ConnectionLoginInput, ctx: WindforceContext) {
  const host = normalizeTistoryHost(input.blogHost);
  const origin = tistoryOrigin(host);
  const accountId = input.accountId?.trim();
  const password = input.password;
  if (!accountId || !password) {
    throw new Error("Tistory login requires accountId and password inputs");
  }
  const browserSession = assignedBrowserSession(ctx);
  const { default: puppeteer } = await loadPuppeteer();
  const browser = await puppeteer.connect({
    browserWSEndpoint: browserSession.capabilities.webSocketEndpoint(
      browserSession.provider.endpoint,
    ),
    headers: { ...browserSession.capabilities.headers },
    protocolTimeout: BROWSER_PROTOCOL_TIMEOUT_MS,
  });
  let isolatedContext: BrowserContext | undefined;
  let result: TistoryLoginResult | undefined;
  let actionError: unknown;
  try {
    isolatedContext = await withTimeout(
      browser.createBrowserContext(),
      BROWSER_CONTEXT_CREATION_TIMEOUT_MS,
      "Tistory isolated browser context creation timed out",
    );
    const page = await withTimeout(
      isolatedContext.newPage(),
      BROWSER_PAGE_CREATION_TIMEOUT_MS,
      "Tistory isolated browser page creation timed out",
    );
    result = await performLogin(
      { ...input, accountId, password },
      ctx,
      host,
      origin,
      isolatedContext,
      page,
    );
  } catch (error) {
    actionError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    if (isolatedContext) await closeOwnedContextPages(isolatedContext);
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (isolatedContext) await isolatedContext.close();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await browser.disconnect();
  } catch (error) {
    cleanupErrors.push(error);
  }

  if (actionError !== undefined) {
    if (cleanupErrors.length > 0) {
      ctx.logger.warn("Tistory login failed and browser target cleanup did not complete");
    }
    throw actionError;
  }
  if (cleanupErrors.length > 0) {
    throw new Error("Tistory browser target cleanup did not complete");
  }
  if (!result) throw new Error("Tistory login did not produce a result");
  return result;
}

async function performLogin(
  input: ConnectionLoginInput & { accountId: string; password: string },
  ctx: WindforceContext,
  host: string,
  origin: string,
  browserContext: BrowserContext,
  page: Page,
): Promise<TistoryLoginResult> {
  const kakaoDeadline = Date.now() + KAKAO_AUTHENTICATION_WAIT_TIMEOUT_MS;
  await installKakaoAccountRuntimeProbe(page);
  await startKakaoAuthorization(page, `${origin}/manage/newpost`, input.accountId);
  await authenticateKakaoAccountWithPageJavaScript(
    page,
    input.accountId,
    input.password,
    kakaoDeadline,
  );

  await waitForAuthenticatedSession(
    page,
    origin,
    host,
    Date.now() + TISTORY_SESSION_WAIT_TIMEOUT_MS,
  );
  const capturedAt = new Date().toISOString();
  const storageState = await captureStorageState(browserContext, page, origin);
  if (
    !storageState.cookies.some(
      (cookie) => cookie.domain === "tistory.com" || cookie.domain.endsWith(".tistory.com"),
    )
  ) {
    throw new Error("Tistory session cookie was not captured");
  }
  const sessionStorage = await captureSessionStorage(page);
  const userAgent = await page.evaluate(() => navigator.userAgent);
  const secret: TistorySession = {
    version: 1,
    capturedAt,
    userAgent,
    storageState,
    sessionStorage,
  };
  const profile: TistoryConnection = {
    version: 1,
    provider: "tistory",
    connectionId: "default",
    blogHost: host,
    publicUrl: `${origin}/`,
    manageUrl: `${origin}/manage`,
    capturedAt,
    sessionSecretRef: TISTORY_SESSION_REFERENCE,
  };

  await ctx.variables.set(TISTORY_SESSION_PATH, JSON.stringify(secret), {
    operationId: randomUUID(),
    scope: "actor",
  });
  await ctx.resources.set(TISTORY_PROFILE_PATH, profile, TISTORY_CONNECTION_RESOURCE_TYPE, {
    operationId: randomUUID(),
    scope: "actor",
  });
  return {
    provider: "tistory",
    connectionId: "default",
    blogHost: host,
    publicUrl: profile.publicUrl,
    capturedAt,
    authenticated: true,
    status: "ready",
  };
}

async function loadPuppeteer(): Promise<typeof import("puppeteer-core")> {
  // Keep the browser runtime out of Core's static entrypoint verification bundle.
  // The browser worker resolves this declared dependency when the login action runs.
  return import(["puppeteer", "-core"].join(""));
}

async function startKakaoAuthorization(
  page: Page,
  redirectUrl: string,
  loginHint: string,
): Promise<void> {
  const loginUrl = new URL(TISTORY_LOGIN_URL);
  loginUrl.searchParams.set("redirectUrl", redirectUrl);
  await page.goto(loginUrl.href, {
    waitUntil: "domcontentloaded",
    timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
  });

  await page
    .waitForFunction(
      () => {
        const kakao = Reflect.get(window, "Kakao");
        if (!kakao || typeof kakao !== "object") return false;
        const auth = Reflect.get(kakao, "Auth");
        const authorize = auth && typeof auth === "object" ? Reflect.get(auth, "authorize") : null;
        const isInitialized = Reflect.get(kakao, "isInitialized");
        return (
          typeof authorize === "function" &&
          typeof isInitialized === "function" &&
          isInitialized.call(kakao) === true
        );
      },
      { timeout: KAKAO_SDK_READY_TIMEOUT_MS },
    )
    .catch(() => {
      throw new Error("Tistory Kakao SDK did not initialize before the login deadline");
    });

  const authState = await page
    .evaluate(
      async ({ stateEndpoint, redirectUrl }) => {
        const response = await fetch(stateEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirectUrl, isPopup: false }),
          credentials: "include",
        });
        const payload = await response.json().catch(() => null);
        const state =
          payload && typeof payload === "object" ? Reflect.get(payload, "data") : undefined;
        return {
          ready: response.ok && typeof state === "string" && state.length > 0,
          state: typeof state === "string" ? state : undefined,
        };
      },
      { stateEndpoint: TISTORY_KAKAO_AUTH_STATE_ENDPOINT, redirectUrl },
    )
    .catch(() => null);
  if (!authState?.ready || !authState.state) {
    throw new Error(`Tistory Kakao authorization failed at ${safePageLocation(page.url())}`);
  }

  const invoked = await page
    .evaluate(
      ({ state, loginHint }) => {
        const kakao = Reflect.get(window, "Kakao");
        const auth = kakao && typeof kakao === "object" ? Reflect.get(kakao, "Auth") : undefined;
        const authorize = auth && typeof auth === "object" ? Reflect.get(auth, "authorize") : null;
        if (typeof authorize !== "function") return false;
        authorize.call(auth, {
          redirectUri: `${window.location.origin}/auth/kakao/redirect`,
          state,
          loginHint,
        });
        return true;
      },
      { state: authState.state, loginHint },
    )
    .catch(() => false);
  if (!invoked) throw new Error("Tistory Kakao SDK authorization failed");
}

async function installKakaoAccountRuntimeProbe(page: Page): Promise<void> {
  await page.evaluateOnNewDocument((rootModuleKey) => {
    const queue: unknown[] = [];
    const inspectChunk = (item: unknown) => {
      if (!Array.isArray(item)) return;
      const factories = item[1];
      if (!factories || typeof factories !== "object") return;
      for (const [moduleId, factory] of Object.entries(factories)) {
        const source = String(factory);
        if (
          source.includes("useStore must be used within StoreProvider") &&
          source.includes("parseParams")
        ) {
          Reflect.set(window, Symbol.for(rootModuleKey), Number(moduleId));
          return;
        }
      }
    };
    let currentPush = (...items: unknown[]) => {
      for (const item of items) inspectChunk(item);
      return Array.prototype.push.apply(queue, items);
    };
    Object.defineProperty(queue, "push", {
      configurable: true,
      get() {
        return currentPush;
      },
      set(push: unknown) {
        if (typeof push === "function") {
          const delegate = (...items: unknown[]) => Reflect.apply(push, queue, items) as number;
          currentPush = (...items: unknown[]) => {
            for (const item of items) inspectChunk(item);
            return delegate(...items);
          };
        }
      },
    });
    Reflect.set(window, "webpackChunk_N_E", queue);
  }, KAKAO_ROOT_MODULE_KEY);
}

type KakaoAuthenticationState =
  | "runtime-unavailable"
  | "captcha-required"
  | "two-step-pending"
  | "navigating"
  | "rejected"
  | `rejected:${string}`;

async function authenticateKakaoAccountWithPageJavaScript(
  page: Page,
  accountId: string,
  password: string,
  deadline: number,
): Promise<void> {
  const runtimeDeadline = Math.min(
    deadline,
    Date.now() + KAKAO_ACCOUNT_JAVASCRIPT_READY_TIMEOUT_MS,
  );
  let state: KakaoAuthenticationState = "runtime-unavailable";
  while (Date.now() < runtimeDeadline && state === "runtime-unavailable") {
    state = await callKakaoAuthenticate(page, accountId, password);
    if (state === "runtime-unavailable") {
      await sleep(Math.min(250, Math.max(1, runtimeDeadline - Date.now())));
    }
  }
  if (state === "runtime-unavailable") {
    throw new Error("Kakao account JavaScript client did not become ready");
  }
  let captchaAttempts = 0;
  while (state === "captcha-required") {
    captchaAttempts += 1;
    if (captchaAttempts > KAKAO_CAPTCHA_MAX_ATTEMPTS) {
      throw new Error("Kakao CAPTCHA verification exceeded the retry limit");
    }
    state = await waitForKakaoCaptchaAndRetry(page, deadline);
  }
  if (state === "rejected" || state.startsWith("rejected:")) {
    const status = state.includes(":") ? state.slice(state.indexOf(":") + 1) : "unknown";
    throw new Error(`Kakao account authentication was rejected with status ${status}`);
  }
  if (state === "navigating") return;

  while (Date.now() < deadline) {
    await sleep(Math.min(AUTHENTICATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    const currentURL = parsePageURL(page.url());
    if (currentURL && currentURL.hostname !== "accounts.kakao.com") return;
    const pollingState = await pollKakaoTwoStepVerification(page);
    if (pollingState === "navigating") return;
    if (pollingState === "rejected") {
      const updatedURL = parsePageURL(page.url());
      if (updatedURL && updatedURL.hostname !== "accounts.kakao.com") return;
      throw new Error("Kakao two-step verification could not continue");
    }
  }
  throw new Error("Kakao two-step verification was not approved before the login deadline");
}

async function callKakaoAuthenticate(
  page: Page,
  accountId: string,
  password: string,
): Promise<KakaoAuthenticationState> {
  return page
    .evaluate(
      async ({ accountId, password, rootModuleKey, stateKey }) => {
        type KakaoClient = {
          call(action: string, input: Record<string, unknown>): Promise<unknown>;
        };
        type KakaoRootStore = {
          client?: KakaoClient;
          context?: Record<string, unknown>;
          localeStore?: { locale?: string };
          params?: Record<string, unknown>;
        };
        type WebpackRequire = {
          (moduleId: number): Record<string, unknown>;
          m?: Record<string, unknown>;
        };

        const queue = Reflect.get(window, "webpackChunk_N_E");
        if (!Array.isArray(queue)) return "runtime-unavailable";
        let webpackRequire: WebpackRequire | undefined;
        queue.push([
          [`publication-${Date.now()}-${Math.random()}`],
          {},
          (runtime: unknown) => {
            webpackRequire = runtime as WebpackRequire;
          },
        ]);
        if (!webpackRequire?.m) return "runtime-unavailable";

        const rootModuleId = Reflect.get(window, Symbol.for(rootModuleKey));
        if (typeof rootModuleId !== "number") return "runtime-unavailable";

        let rootStore: KakaoRootStore;
        try {
          const moduleExports = webpackRequire(rootModuleId);
          const getRootStore = Reflect.get(moduleExports, "MO");
          if (typeof getRootStore !== "function") return "runtime-unavailable";
          rootStore = getRootStore(() => {
            throw new Error("Kakao root store is not initialized");
          }) as KakaoRootStore;
        } catch {
          return "runtime-unavailable";
        }

        const client = rootStore.client;
        if (!client || typeof client.call !== "function") return "runtime-unavailable";
        const params = rootStore.params ?? {};
        const context = rootStore.context ?? {};
        const loginUrl =
          typeof params.loginUrl === "string"
            ? params.loginUrl
            : typeof context.loginUrl === "string"
              ? context.loginUrl
              : window.location.href;
        const lang =
          typeof rootStore.localeStore?.locale === "string"
            ? rootStore.localeStore.locale
            : typeof context.locale === "string"
              ? context.locale
              : "ko";

        const userAgentData = Reflect.get(navigator, "userAgentData") as
          | {
              mobile?: boolean;
              platform?: string;
              getHighEntropyValues?: (keys: string[]) => Promise<Record<string, unknown>>;
            }
          | undefined;
        const highEntropy: Record<string, unknown> = userAgentData?.getHighEntropyValues
          ? await userAgentData
              .getHighEntropyValues([
                "architecture",
                "bitness",
                "fullVersionList",
                "model",
                "platformVersion",
              ])
              .catch(() => ({}))
          : {};
        const encodeHint = (value: unknown) =>
          Array.from(typeof value === "string" ? value : "")
            .map((character) => character.charCodeAt(0).toString(16).padStart(2, "0"))
            .join("");
        const fullVersionList = Array.isArray(highEntropy.fullVersionList)
          ? highEntropy.fullVersionList.flatMap((item) => {
              if (!item || typeof item !== "object") return [];
              const brand = Reflect.get(item, "brand");
              const version = Reflect.get(item, "version");
              if (typeof brand !== "string" || typeof version !== "string") return [];
              return [{ br: encodeHint(brand), vr: encodeHint(version) }];
            })
          : [];
        const browserHints = {
          a: encodeHint(highEntropy.architecture),
          b: encodeHint(highEntropy.bitness),
          m: encodeHint(highEntropy.model),
          pv: encodeHint(highEntropy.platformVersion),
          fvl: fullVersionList,
          mo: userAgentData?.mobile ? 1 : 0,
          p: encodeHint(userAgentData?.platform),
        };

        const loginInput = {
          loginId: accountId,
          loginKey: accountId,
          password,
          staySignedIn: false,
          saveSignedIn: false,
          loginUrl,
          lang,
          security_context: { a: [], b: browserHints, c: false, d: [] },
        };
        let response: unknown;
        try {
          response = await client.call("authenticate", loginInput);
        } catch {
          return "rejected";
        }
        if (!response || typeof response !== "object") return "rejected:invalid-response";
        const status = Reflect.get(response, "status");
        if (status === -481 || status === -482) {
          const challenge = Reflect.get(response, "dkaptcha");
          const src =
            challenge && typeof challenge === "object" ? Reflect.get(challenge, "src") : null;
          const widgetId =
            challenge && typeof challenge === "object" ? Reflect.get(challenge, "widgetId") : null;
          if (typeof src !== "string" || typeof widgetId !== "string") {
            return `rejected:${status}` as KakaoAuthenticationState;
          }
          Reflect.set(window, Symbol.for(stateKey), {
            challenge: { src, widgetId },
            client,
            loginInput,
          });
          return "captcha-required";
        }
        const continueUrl = Reflect.get(response, "continueUrl");
        if (typeof continueUrl === "string" && continueUrl.length > 0) {
          setTimeout(() => window.location.assign(continueUrl), 0);
          return "navigating";
        }
        const token = Reflect.get(response, "token");
        if (typeof token !== "string" || token.length === 0) {
          const safeStatus =
            typeof status === "number"
              ? String(status)
              : typeof status === "string" && /^[A-Z0-9_-]{1,64}$/.test(status)
                ? status
                : "unknown";
          return `rejected:${safeStatus}` as KakaoAuthenticationState;
        }
        Reflect.set(window, Symbol.for(stateKey), { client, token });
        return "two-step-pending";
      },
      {
        accountId,
        password,
        rootModuleKey: KAKAO_ROOT_MODULE_KEY,
        stateKey: KAKAO_LOGIN_STATE_KEY,
      },
    )
    .catch(() => "runtime-unavailable" as const);
}

async function waitForKakaoCaptchaAndRetry(
  page: Page,
  deadline: number,
): Promise<KakaoAuthenticationState> {
  const initialized = await page
    .evaluate(async (stateKey) => {
      type DkaptchaAPI = {
        render(
          elementId: string,
          options: {
            widget: string;
            theme: "white";
            language: "ko" | "en";
            option: "iframe";
          },
        ): {
          addCallbackListener(callback: (result: { token?: unknown }) => void): void;
        };
      };
      type CaptchaState = {
        captchaToken?: string;
        challenge?: { src?: string; widgetId?: string };
        overlay?: HTMLElement;
      };
      const loginState = Reflect.get(window, Symbol.for(stateKey)) as CaptchaState | undefined;
      const challenge = loginState?.challenge;
      if (!loginState || !challenge?.src || !challenge.widgetId) return false;
      const scriptURL = new URL(challenge.src, window.location.origin);
      const trustedHost =
        scriptURL.hostname === "kakao.com" ||
        scriptURL.hostname.endsWith(".kakao.com") ||
        scriptURL.hostname === "kakaocdn.net" ||
        scriptURL.hostname.endsWith(".kakaocdn.net");
      if (scriptURL.protocol !== "https:" || !trustedHost) return false;

      loginState.overlay?.remove();
      const overlay = document.createElement("main");
      overlay.id = `publication-dkaptcha-${Date.now()}`;
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#fff;color:#111";
      document.body.appendChild(overlay);
      document.title = "Kakao verification";
      loginState.overlay = overlay;

      const globalObject = window as typeof window & { dkaptcha?: DkaptchaAPI };
      if (!globalObject.dkaptcha) {
        await new Promise<void>((resolve, reject) => {
          const script = document.createElement("script");
          script.src = scriptURL.href;
          script.async = true;
          script.addEventListener("load", () => resolve(), { once: true });
          script.addEventListener("error", () => reject(new Error("CAPTCHA load failed")), {
            once: true,
          });
          document.head.appendChild(script);
        });
      }
      if (!globalObject.dkaptcha) return false;
      globalObject.dkaptcha
        .render(overlay.id, {
          widget: challenge.widgetId,
          theme: "white",
          language: navigator.language.startsWith("ko") ? "ko" : "en",
          option: "iframe",
        })
        .addCallbackListener((result) => {
          if (typeof result.token === "string" && result.token.length > 0) {
            loginState.captchaToken = result.token;
          }
        });
      return true;
    }, KAKAO_LOGIN_STATE_KEY)
    .catch(() => false);
  if (!initialized) throw new Error("Kakao CAPTCHA widget could not be initialized");

  while (Date.now() < deadline) {
    await sleep(Math.min(AUTHENTICATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
    const state = await page
      .evaluate(async (stateKey) => {
        type KakaoClient = {
          call(action: string, input: Record<string, unknown>): Promise<unknown>;
        };
        type CaptchaState = {
          captchaToken?: string;
          challenge?: { src?: string; widgetId?: string };
          client?: KakaoClient;
          loginInput?: Record<string, unknown>;
          overlay?: HTMLElement;
          token?: string;
        };
        const loginState = Reflect.get(window, Symbol.for(stateKey)) as CaptchaState | undefined;
        if (!loginState?.captchaToken) return "captcha-waiting";
        if (!loginState.client || !loginState.loginInput) return "rejected";
        const captchaToken = loginState.captchaToken;
        delete loginState.captchaToken;
        loginState.overlay?.remove();
        delete loginState.overlay;

        let response: unknown;
        try {
          response = await loginState.client.call("authenticate", {
            ...loginState.loginInput,
            captchaToken,
          });
        } catch {
          return "rejected:network";
        }
        if (!response || typeof response !== "object") return "rejected:invalid-response";
        const status = Reflect.get(response, "status");
        if (status === -481 || status === -482) {
          const challenge = Reflect.get(response, "dkaptcha");
          const src =
            challenge && typeof challenge === "object" ? Reflect.get(challenge, "src") : null;
          const widgetId =
            challenge && typeof challenge === "object" ? Reflect.get(challenge, "widgetId") : null;
          if (typeof src !== "string" || typeof widgetId !== "string") {
            return `rejected:${status}`;
          }
          loginState.challenge = { src, widgetId };
          return "captcha-required";
        }
        const continueUrl = Reflect.get(response, "continueUrl");
        if (typeof continueUrl === "string" && continueUrl.length > 0) {
          setTimeout(() => window.location.assign(continueUrl), 0);
          return "navigating";
        }
        const token = Reflect.get(response, "token");
        if (typeof token === "string" && token.length > 0) {
          loginState.token = token;
          return "two-step-pending";
        }
        const safeStatus = typeof status === "number" ? String(status) : "unknown";
        return `rejected:${safeStatus}`;
      }, KAKAO_LOGIN_STATE_KEY)
      .catch(() => "rejected" as const);
    if (state !== "captcha-waiting") return state as KakaoAuthenticationState;
  }
  throw new Error("Kakao CAPTCHA verification did not complete before the login deadline");
}

async function pollKakaoTwoStepVerification(page: Page): Promise<KakaoAuthenticationState> {
  return page
    .evaluate(async (stateKey) => {
      type KakaoClient = {
        call(action: string, input: Record<string, unknown>): Promise<unknown>;
      };
      type LoginState = { client?: KakaoClient; token?: string };
      const symbol = Symbol.for(stateKey);
      const loginState = Reflect.get(window, symbol) as LoginState | undefined;
      if (!loginState?.client || !loginState.token) return "rejected";

      let response: unknown;
      try {
        response = await loginState.client.call("check_tms_for_two_step_verification", {
          token: loginState.token,
          isRememberBrowser: false,
        });
      } catch {
        return "two-step-pending";
      }
      if (!response || typeof response !== "object") return "two-step-pending";
      const continueUrl = Reflect.get(response, "continueUrl");
      if (typeof continueUrl === "string" && continueUrl.length > 0) {
        Reflect.deleteProperty(window, symbol);
        setTimeout(() => window.location.assign(continueUrl), 0);
        return "navigating";
      }
      const nextToken = Reflect.get(response, "token");
      if (typeof nextToken === "string" && nextToken.length > 0) loginState.token = nextToken;
      return "two-step-pending";
    }, KAKAO_LOGIN_STATE_KEY)
    .catch(() => "two-step-pending" as const);
}

function isPostAuthenticationTistoryURL(url: URL, host: string): boolean {
  return (
    (url.hostname === host || url.hostname === "www.tistory.com") &&
    !url.pathname.startsWith("/auth/")
  );
}

async function waitForAuthenticatedSession(
  page: Page,
  origin: string,
  host: string,
  deadline: number,
): Promise<void> {
  const managementURL = `${origin}/manage/posts/`;
  const apiURL = `${origin}/manage/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all`;
  let oauthApprovalSubmitted = false;

  while (Date.now() < deadline) {
    const currentURL = parsePageURL(page.url());
    if (
      currentURL?.hostname === KAKAO_AUTHORIZATION_HOST &&
      currentURL.pathname === "/oauth/authorize" &&
      !oauthApprovalSubmitted
    ) {
      oauthApprovalSubmitted = await submitKakaoOAuthApproval(page);
      if (oauthApprovalSubmitted) continue;
    }
    if (currentURL && isPostAuthenticationTistoryURL(currentURL, host)) {
      if (currentURL.origin !== origin || !currentURL.pathname.startsWith("/manage")) {
        const remaining = deadline - Date.now();
        await page
          .goto(managementURL, {
            waitUntil: "domcontentloaded",
            timeout: Math.max(1, Math.min(10_000, remaining)),
          })
          .catch(() => null);
      }
      if (await isAuthenticatedManagementSession(page, origin, host, apiURL)) return;
    }
    await sleep(Math.min(AUTHENTICATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error(
    `Tistory management session was not established before the login deadline at ${safePageLocation(page.url())}`,
  );
}

async function submitKakaoOAuthApproval(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const approval = document.querySelector('[name="user_oauth_approval"]');
      if (!(approval instanceof HTMLButtonElement) && !(approval instanceof HTMLInputElement)) {
        return false;
      }
      const form = approval.form;
      if (!form) return false;
      const isSubmitter =
        approval instanceof HTMLButtonElement ||
        approval.type === "submit" ||
        approval.type === "image";
      form.requestSubmit(isSubmitter ? approval : undefined);
      return true;
    })
    .catch(() => false);
}

async function isAuthenticatedManagementSession(
  page: Page,
  origin: string,
  host: string,
  apiURL = `${origin}/manage/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all`,
): Promise<boolean> {
  const currentURL = parsePageURL(page.url());
  if (
    !currentURL ||
    currentURL.origin !== origin ||
    currentURL.hostname !== host ||
    !currentURL.pathname.startsWith("/manage/")
  ) {
    return false;
  }
  return page
    .evaluate(async (endpoint) => {
      const response = await fetch(endpoint, {
        credentials: "include",
        redirect: "manual",
      });
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      return response.status >= 200 && response.status < 300 && contentType.includes("json");
    }, apiURL)
    .catch(() => false);
}

function parsePageURL(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

function safePageLocation(value: string): string {
  const url = parsePageURL(value);
  if (!url) return "an unknown page";
  if (!url.host) return `${url.protocol}${url.pathname}`;
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function captureStorageState(
  browserContext: BrowserContext,
  page: Page,
  origin: string,
): Promise<TistorySession["storageState"]> {
  const cookies = (await browserContext.cookies())
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "");
      return domain === "tistory.com" || domain.endsWith(".tistory.com");
    })
    .map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: cookie.expires,
      httpOnly: cookie.httpOnly ?? false,
      secure: cookie.secure,
      sameSite:
        cookie.sameSite === "Strict" || cookie.sameSite === "None"
          ? cookie.sameSite
          : ("Lax" as const),
    }));
  const pageURL = new URL(page.url());
  if (pageURL.origin !== origin) throw new Error("Tistory page left the authenticated origin");
  const localStorage = await page.evaluate(() =>
    Object.entries(window.localStorage).map(([name, value]) => ({ name, value })),
  );
  const origins: TistorySession["storageState"]["origins"] = [
    { origin: pageURL.origin, localStorage },
  ];
  return { cookies, origins };
}

async function captureSessionStorage(page: Page) {
  const pageURL = new URL(page.url());
  const items = await page.evaluate(() => Object.fromEntries(Object.entries(sessionStorage)));
  return [{ origin: pageURL.origin, items }];
}

async function closeOwnedContextPages(browserContext: BrowserContext): Promise<void> {
  const deadline = Date.now() + TARGET_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const remaining = (await browserContext.pages()).filter((page) => !page.isClosed());
    if (remaining.length === 0) return;
    for (const ownedPage of remaining) {
      await ownedPage.close({ runBeforeUnload: false }).catch(() => undefined);
    }
    await sleep(TARGET_CLEANUP_POLL_INTERVAL_MS);
  }
  throw new Error("Tistory browser page cleanup timed out");
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
