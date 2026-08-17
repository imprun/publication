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
}

const AUTHENTICATION_WAIT_TIMEOUT_MS = 10 * 60 * 1000;
const AUTHENTICATION_POLL_INTERVAL_MS = 1_000;
const BROWSER_PROTOCOL_TIMEOUT_MS = 30_000;
const BROWSER_CONTEXT_CREATION_TIMEOUT_MS = 20_000;
const BROWSER_PAGE_CREATION_TIMEOUT_MS = 20_000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
const KAKAO_SDK_READY_TIMEOUT_MS = 10_000;
const KAKAO_LOGIN_FORM_READY_TIMEOUT_MS = 20_000;
const TISTORY_LOGIN_URL = "https://www.tistory.com/auth/login";
const TISTORY_KAKAO_AUTH_STATE_ENDPOINT = "/api/v1/login/kakaoAuthState";
const TARGET_CLEANUP_TIMEOUT_MS = 5_000;
const TARGET_CLEANUP_POLL_INTERVAL_MS = 50;

export async function loginToTistory(input: ConnectionLoginInput, ctx: WindforceContext) {
  const host = normalizeTistoryHost(input.blogHost);
  const origin = tistoryOrigin(host);
  const accountId = input.accountId?.trim();
  const password = input.password;
  if (!accountId || !password) {
    throw new Error("Tistory login requires accountId and password inputs");
  }
  if (!ctx.capabilities?.has("edge-cdp/v1")) {
    throw new Error("Tistory login requires an assigned edge-cdp BrowserSession");
  }
  const { default: puppeteer } = await loadPuppeteer();
  const browser = await puppeteer.connect({
    browserWSEndpoint: ctx.capabilities.webSocketEndpoint("edge-cdp"),
    headers: { ...ctx.capabilities.headers },
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
  const deadline = Date.now() + AUTHENTICATION_WAIT_TIMEOUT_MS;
  await startKakaoAuthorization(page, `${origin}/manage/newpost`, deadline);
  await submitKakaoLoginWithPageJavaScript(page, input.accountId, input.password);
  await page.bringToFront();

  await waitForAuthenticatedSession(page, origin, host, deadline);
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
  });
  await ctx.resources.set(TISTORY_PROFILE_PATH, profile, TISTORY_CONNECTION_RESOURCE_TYPE, {
    operationId: randomUUID(),
  });
  return {
    provider: "tistory",
    connectionId: "default",
    blogHost: host,
    publicUrl: profile.publicUrl,
    capturedAt,
    authenticated: true,
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
  deadline: number,
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
        const stateResponse = await fetch(stateEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ redirectUrl, isPopup: false }),
          credentials: "include",
        });
        const payload = await stateResponse.json().catch(() => null);
        const state =
          payload && typeof payload === "object" ? Reflect.get(payload, "data") : undefined;
        const kakao = Reflect.get(window, "Kakao");
        const auth = kakao && typeof kakao === "object" ? Reflect.get(kakao, "Auth") : undefined;
        const authorize =
          auth && typeof auth === "object" ? Reflect.get(auth, "authorize") : undefined;
        return {
          httpStatus: stateResponse.status,
          ready: stateResponse.ok && typeof state === "string" && typeof authorize === "function",
          state: typeof state === "string" ? state : undefined,
        };
      },
      { stateEndpoint: TISTORY_KAKAO_AUTH_STATE_ENDPOINT, redirectUrl },
    )
    .catch(() => null);
  if (!authState?.ready || !authState.state) {
    throw new Error(`Tistory Kakao authorization failed at ${safePageLocation(page.url())}`);
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Kakao login did not complete before the login deadline");
  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: Math.max(1, Math.min(BROWSER_NAVIGATION_TIMEOUT_MS, remaining)),
  });
  try {
    await page.evaluate((state) => {
      const kakao = Reflect.get(window, "Kakao");
      const auth = kakao && typeof kakao === "object" ? Reflect.get(kakao, "Auth") : undefined;
      const authorize = auth && typeof auth === "object" ? Reflect.get(auth, "authorize") : null;
      if (typeof authorize !== "function") throw new Error("Kakao authorize API is unavailable");
      authorize.call(auth, {
        redirectUri: `${window.location.origin}/auth/kakao/redirect`,
        state,
      });
    }, authState.state);
  } catch {
    await navigation.catch(() => null);
    throw new Error("Tistory Kakao SDK authorization failed");
  }
  await navigation;
}

async function submitKakaoLoginWithPageJavaScript(
  page: Page,
  accountId: string,
  password: string,
): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const account = document.querySelector<HTMLInputElement>(
          'input[name="loginKey"], input[name="loginId"]',
        );
        const password = document.querySelector<HTMLInputElement>('input[name="password"]');
        const form = account?.form ?? password?.form;
        const submitter =
          form?.querySelector<HTMLButtonElement | HTMLInputElement>(
            'button[type="submit"], input[type="submit"]',
          ) ??
          document.querySelector<HTMLButtonElement | HTMLInputElement>(
            'button[type="submit"], input[type="submit"]',
          );
        return Boolean(account && password && (form || submitter));
      },
      { timeout: KAKAO_LOGIN_FORM_READY_TIMEOUT_MS },
    )
    .catch(() => {
      throw new Error("Kakao login JavaScript did not become ready");
    });

  const prepared = await page
    .evaluate(
      ({ accountId, password }) => {
        const account = document.querySelector<HTMLInputElement>(
          'input[name="loginKey"], input[name="loginId"]',
        );
        const passwordInput = document.querySelector<HTMLInputElement>('input[name="password"]');
        if (!account || !passwordInput) return false;

        const valueSetter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        if (!valueSetter) return false;
        const setValue = (input: HTMLInputElement, value: string) => {
          valueSetter.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
          input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        setValue(account, accountId);
        setValue(passwordInput, password);
        return true;
      },
      { accountId, password },
    )
    .catch(() => false);
  if (!prepared) throw new Error("Kakao login JavaScript could not prepare credentials");

  await sleep(50);
  const submitted = await page
    .evaluate(() => {
      const account = document.querySelector<HTMLInputElement>(
        'input[name="loginKey"], input[name="loginId"]',
      );
      const passwordInput = document.querySelector<HTMLInputElement>('input[name="password"]');
      const form = account?.form ?? passwordInput?.form;
      const submitter =
        form?.querySelector<HTMLButtonElement | HTMLInputElement>(
          'button[type="submit"], input[type="submit"]',
        ) ??
        document.querySelector<HTMLButtonElement | HTMLInputElement>(
          'button[type="submit"], input[type="submit"]',
        );
      if (submitter) {
        setTimeout(() => submitter.click(), 0);
      } else if (form && typeof form.requestSubmit === "function") {
        setTimeout(() => form.requestSubmit(), 0);
      } else {
        return false;
      }
      return true;
    })
    .catch(() => false);
  if (!submitted) throw new Error("Kakao login JavaScript submission failed");
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

  while (Date.now() < deadline) {
    const currentURL = parsePageURL(page.url());
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
