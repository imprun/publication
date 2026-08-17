import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { WindforceContext } from "@imprun/app-sdk";
import type { Browser, BrowserContext, Page, Target } from "puppeteer-core";
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
const LOGIN_FORM_READY_TIMEOUT_MS = 20_000;
const KAKAO_ACCOUNT_INPUT_SELECTOR = 'input[name="loginKey"], input[name="loginId"]';
const KAKAO_AUTHENTICATE_ENDPOINT = "/api/v2/login/authenticate.json";
const KAKAO_VERIFY_TMS_ENDPOINT = "/api/v2/two_step_verification/verify_tms_for_login.json";
const KAKAO_SUCCESS = 0;
const KAKAO_NETWORK_ERROR = -4;
const KAKAO_TWO_STEP_VERIFICATION_REQUIRED = -451;
const TARGET_CLEANUP_TIMEOUT_MS = 5_000;
const TARGET_CLEANUP_POLL_INTERVAL_MS = 50;

interface KakaoLoginBootstrap {
  accountInputName: "loginId" | "loginKey";
  csrf: string;
  encryptionPassphrase?: string;
  loginUrl: string;
  locale: string;
  userAgentHints: {
    a?: string;
    b?: string;
    fvl?: Array<{ br: string; vr: string }>;
    m?: boolean;
    mo?: string;
    p?: string;
    pv?: string;
  } | null;
}

interface KakaoHTTPResponse {
  httpStatus: number;
  status?: number;
  token?: string;
  continueUrl?: string;
}

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
  let rootTarget: Target | undefined;
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
    rootTarget = page.target();
    result = await performLogin({ ...input, accountId, password }, ctx, host, origin, page);
  } catch (error) {
    actionError = error;
  }

  const cleanupErrors: unknown[] = [];
  try {
    if (rootTarget) await closeOwnedTargetTree(browser, rootTarget);
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
  page: Page,
): Promise<TistoryLoginResult> {
  await page.goto(`${origin}/manage/newpost`, {
    waitUntil: "domcontentloaded",
    timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
  });
  await openKakaoLoginIfNeeded(page);
  const deadline = Date.now() + AUTHENTICATION_WAIT_TIMEOUT_MS;
  await authenticateKakaoAccount(page, input.accountId, input.password, deadline);

  await waitForAuthenticatedSession(page, origin, host, deadline);
  const capturedAt = new Date().toISOString();
  const storageState = await captureStorageState(page, origin);
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

async function openKakaoLoginIfNeeded(page: Page): Promise<void> {
  await page
    .waitForSelector(`${KAKAO_ACCOUNT_INPUT_SELECTOR}, a.btn_login.link_kakao_id`, {
      visible: true,
      timeout: LOGIN_FORM_READY_TIMEOUT_MS,
    })
    .catch(() => null);
  if (await isVisible(page, KAKAO_ACCOUNT_INPUT_SELECTOR)) return;
  const kakaoButton = await page.$("a.btn_login.link_kakao_id");
  if (!kakaoButton || !(await kakaoButton.isVisible().catch(() => false))) return;

  const navigation = page.waitForNavigation({
    waitUntil: "domcontentloaded",
    timeout: BROWSER_NAVIGATION_TIMEOUT_MS,
  });
  await kakaoButton.evaluate((element) => (element as HTMLElement).click());
  await navigation;
}

async function authenticateKakaoAccount(
  page: Page,
  accountId: string,
  password: string,
  deadline: number,
): Promise<void> {
  const bootstrap = await readKakaoLoginBootstrap(page);
  const encryptedPassword = bootstrap.encryptionPassphrase
    ? encryptKakaoPassword(password, bootstrap.encryptionPassphrase)
    : password;
  const response = await callKakaoJSON(page, KAKAO_AUTHENTICATE_ENDPOINT, {
    _csrf: bootstrap.csrf,
    loginId: accountId,
    loginKey: accountId,
    password: encryptedPassword,
    staySignedIn: false,
    saveSignedIn: false,
    loginUrl: bootstrap.loginUrl,
    lang: bootstrap.locale,
    security_context: {
      a: [],
      b: bootstrap.userAgentHints,
      c: false,
      d: [],
    },
    ...(bootstrap.encryptionPassphrase ? { k: true } : {}),
  });

  if (response.status === KAKAO_SUCCESS && response.continueUrl) {
    await navigateToKakaoContinuation(page, response.continueUrl, deadline);
    return;
  }
  if (response.status !== KAKAO_TWO_STEP_VERIFICATION_REQUIRED || !response.token) {
    throw new Error(
      kakaoResponseError("Kakao credential authentication was not accepted", response),
    );
  }

  const continueUrl = await waitForKakaoTMSApproval(page, bootstrap.csrf, response.token, deadline);
  await navigateToKakaoContinuation(page, continueUrl, deadline);
}

async function readKakaoLoginBootstrap(page: Page): Promise<KakaoLoginBootstrap> {
  const accountInput = await page
    .waitForSelector(KAKAO_ACCOUNT_INPUT_SELECTOR, {
      visible: true,
      timeout: LOGIN_FORM_READY_TIMEOUT_MS,
    })
    .catch(() => null);
  if (!accountInput) {
    throw new Error(
      `Kakao account input was not available for automatic login at ${safePageLocation(page.url())}`,
    );
  }
  const bootstrap = await page.evaluate(async () => {
    const accountInput = document.querySelector<HTMLInputElement>(
      'input[name="loginKey"], input[name="loginId"]',
    );
    const accountInputName = accountInput?.name;
    if (accountInputName !== "loginId" && accountInputName !== "loginKey") return null;
    const normalizedAccountInputName: "loginId" | "loginKey" = accountInputName;
    const nextDataText = document.querySelector("#__NEXT_DATA__")?.textContent;
    if (!nextDataText) return null;
    const nextData = JSON.parse(nextDataText) as {
      props?: {
        pageProps?: {
          pageContext?: {
            commonContext?: { _csrf?: unknown; locale?: unknown; p?: unknown };
            context?: { loginUrl?: unknown };
          };
        };
      };
    };
    const pageContext = nextData.props?.pageProps?.pageContext;
    const csrf = pageContext?.commonContext?._csrf;
    const locale = pageContext?.commonContext?.locale;
    const encryptionPassphrase = pageContext?.commonContext?.p;
    const loginUrl = pageContext?.context?.loginUrl;
    if (typeof csrf !== "string" || typeof locale !== "string" || typeof loginUrl !== "string") {
      return null;
    }

    let userAgentHints: KakaoLoginBootstrap["userAgentHints"] = null;
    const userAgentData = Reflect.get(navigator, "userAgentData") as
      | {
          getHighEntropyValues?: (hints: string[]) => Promise<Record<string, unknown>>;
        }
      | undefined;
    if (userAgentData?.getHighEntropyValues) {
      const hints = await userAgentData.getHighEntropyValues([
        "architecture",
        "bitness",
        "fullVersionList",
        "model",
        "platform",
        "platformVersion",
      ]);
      const fullVersionList = Array.isArray(hints.fullVersionList)
        ? hints.fullVersionList
            .map((entry) => {
              if (!entry || typeof entry !== "object") return null;
              const brand = Reflect.get(entry, "brand");
              const version = Reflect.get(entry, "version");
              return typeof brand === "string" && typeof version === "string"
                ? { br: brand, vr: version }
                : null;
            })
            .filter((entry): entry is { br: string; vr: string } => entry !== null)
        : undefined;
      userAgentHints = {
        ...(typeof hints.architecture === "string" ? { a: hints.architecture } : {}),
        ...(typeof hints.bitness === "string" ? { b: hints.bitness } : {}),
        ...(fullVersionList && fullVersionList.length > 0 ? { fvl: fullVersionList } : {}),
        ...(typeof Reflect.get(userAgentData, "mobile") === "boolean"
          ? { m: Reflect.get(userAgentData, "mobile") as boolean }
          : {}),
        ...(typeof hints.model === "string" ? { mo: hints.model } : {}),
        ...(typeof Reflect.get(userAgentData, "platform") === "string"
          ? { p: Reflect.get(userAgentData, "platform") as string }
          : {}),
        ...(typeof hints.platformVersion === "string" ? { pv: hints.platformVersion } : {}),
      };
    }

    return {
      accountInputName: normalizedAccountInputName,
      csrf,
      ...(typeof encryptionPassphrase === "string" && encryptionPassphrase
        ? { encryptionPassphrase }
        : {}),
      loginUrl,
      locale,
      userAgentHints,
    };
  });
  if (!bootstrap) {
    throw new Error(`Kakao login bootstrap was not available at ${safePageLocation(page.url())}`);
  }
  return bootstrap;
}

async function waitForKakaoTMSApproval(
  page: Page,
  csrf: string,
  token: string,
  deadline: number,
): Promise<string> {
  while (Date.now() < deadline) {
    const response = await callKakaoJSON(page, KAKAO_VERIFY_TMS_ENDPOINT, {
      _csrf: csrf,
      token,
      isRememberBrowser: false,
    });
    if (response.status === KAKAO_SUCCESS && response.continueUrl) return response.continueUrl;
    if (
      response.status !== KAKAO_TWO_STEP_VERIFICATION_REQUIRED &&
      response.status !== KAKAO_NETWORK_ERROR
    ) {
      throw new Error(kakaoResponseError("Kakao two-step verification was not accepted", response));
    }
    await sleep(Math.min(AUTHENTICATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Kakao two-step verification did not complete before the login deadline");
}

async function callKakaoJSON(
  page: Page,
  endpoint: string,
  body: Record<string, unknown>,
): Promise<KakaoHTTPResponse> {
  return page.evaluate(
    async ({ endpoint, body }) => {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        credentials: "include",
      });
      const payload = await response.json().catch(() => null);
      if (!payload || typeof payload !== "object") return { httpStatus: response.status };
      const status = Reflect.get(payload, "status");
      const token = Reflect.get(payload, "token");
      const continueUrl = Reflect.get(payload, "continueUrl");
      return {
        httpStatus: response.status,
        ...(typeof status === "number" ? { status } : {}),
        ...(typeof token === "string" ? { token } : {}),
        ...(typeof continueUrl === "string" ? { continueUrl } : {}),
      };
    },
    { endpoint, body },
  );
}

async function navigateToKakaoContinuation(
  page: Page,
  rawContinueUrl: string,
  deadline: number,
): Promise<void> {
  let continueUrl: URL;
  try {
    continueUrl = new URL(rawContinueUrl, "https://accounts.kakao.com/");
  } catch {
    throw new Error("Kakao login returned an invalid continuation URL");
  }
  if (
    continueUrl.protocol !== "https:" ||
    !["accounts.kakao.com", "kauth.kakao.com", "www.tistory.com"].includes(continueUrl.hostname)
  ) {
    throw new Error("Kakao login returned an untrusted continuation URL");
  }
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Kakao login did not complete before the login deadline");
  try {
    await page.goto(continueUrl.href, {
      waitUntil: "domcontentloaded",
      timeout: Math.max(1, Math.min(BROWSER_NAVIGATION_TIMEOUT_MS, remaining)),
    });
  } catch {
    throw new Error(`Kakao login continuation failed at ${safePageLocation(continueUrl.href)}`);
  }
}

function kakaoResponseError(message: string, response: KakaoHTTPResponse): string {
  const status = response.status ?? "unknown";
  return `${message} (status ${status}, HTTP ${response.httpStatus})`;
}

function encryptKakaoPassword(value: string, passphrase: string): string {
  const salt = randomBytes(8);
  const password = Buffer.from(passphrase, "utf8");
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (derived.length < 48) {
    previous = createHash("md5").update(previous).update(password).update(salt).digest();
    derived = Buffer.concat([derived, previous]);
  }
  const cipher = createCipheriv("aes-256-cbc", derived.subarray(0, 32), derived.subarray(32, 48));
  const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__"), salt, encrypted]).toString("base64");
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
    if (currentURL && (await isAuthenticatedManagementSession(page, origin, host, apiURL))) return;
    if (currentURL && isPostAuthenticationTistoryURL(currentURL, host)) {
      const remaining = deadline - Date.now();
      await page
        .goto(managementURL, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, Math.min(10_000, remaining)),
        })
        .catch(() => null);
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
  if (!currentURL || !isAuthenticatedManagementURL(currentURL, host)) return false;
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

function isAuthenticatedManagementURL(url: URL, host: string): boolean {
  return (
    url.hostname === host && url.pathname.startsWith("/manage/") && !url.pathname.includes("/auth/")
  );
}

function isPostAuthenticationTistoryURL(url: URL, host: string): boolean {
  return (
    (url.hostname === host || url.hostname === "www.tistory.com") &&
    !url.pathname.startsWith("/auth/")
  );
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  const element = await page.$(selector);
  return element ? element.isVisible().catch(() => false) : false;
}

async function captureStorageState(
  page: Page,
  origin: string,
): Promise<TistorySession["storageState"]> {
  const cookies = (await page.cookies(`${origin}/`, "https://www.tistory.com/")).map((cookie) => ({
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

async function closeOwnedTargetTree(browser: Browser, rootTarget: Target): Promise<void> {
  const deadline = Date.now() + TARGET_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const ownedTargets = browser.targets().map((target) => ({
      target,
      depth: ownedTargetDepth(target, rootTarget),
    }));
    const remaining = ownedTargets
      .filter(({ depth }) => depth >= 0)
      .sort((left, right) => right.depth - left.depth);
    if (remaining.length === 0) return;
    for (const { target } of remaining) {
      const ownedPage = await target.page().catch(() => null);
      if (ownedPage && !ownedPage.isClosed()) {
        await ownedPage.close({ runBeforeUnload: false }).catch(() => undefined);
      }
    }
    await sleep(TARGET_CLEANUP_POLL_INTERVAL_MS);
  }
  throw new Error("Tistory browser target cleanup timed out");
}

function ownedTargetDepth(target: Target, rootTarget: Target): number {
  let current: Target | undefined = target;
  let depth = 0;
  while (current) {
    if (current === rootTarget) return depth;
    current = current.opener();
    depth += 1;
  }
  return -1;
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
