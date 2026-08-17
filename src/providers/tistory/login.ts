import { randomUUID } from "node:crypto";
import type { WindforceContext } from "@imprun/app-sdk";
import type { Browser, BrowserContext, Page, Target } from "puppeteer-core";
import {
  TISTORY_CONNECTION_RESOURCE_TYPE,
  TISTORY_PROFILE_PATH,
  TISTORY_SESSION_PATH,
  TISTORY_SESSION_REFERENCE,
} from "../../config.js";
import type { ConnectionLoginInput } from "../../contracts.js";
import { waitForHumanDecision } from "../../human.js";
import type { TistoryConnection, TistorySession } from "../../session.js";
import { normalizeTistoryHost, tistoryOrigin } from "./host.js";

interface LoginApproval {
  completed: boolean;
}

export interface TistoryLoginResult {
  provider: "tistory";
  connectionId: "default";
  blogHost: string;
  publicUrl: string;
  capturedAt: string;
  authenticated: true;
}

const AUTHENTICATION_WAIT_TIMEOUT_MS = 90_000;
const AUTHENTICATION_POLL_INTERVAL_MS = 750;
const BROWSER_PROTOCOL_TIMEOUT_MS = 30_000;
const BROWSER_CONTEXT_CREATION_TIMEOUT_MS = 20_000;
const BROWSER_PAGE_CREATION_TIMEOUT_MS = 20_000;
const BROWSER_NAVIGATION_TIMEOUT_MS = 30_000;
const LOGIN_FORM_READY_TIMEOUT_MS = 20_000;
const KAKAO_ACCOUNT_INPUT_SELECTOR = 'input[name="loginKey"], input[name="loginId"]';
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
  await fillCredentials(page, input.accountId, input.password);
  await submitCredentials(page);

  if (!(await isAuthenticatedManagementSession(page, origin, host))) {
    const decision = await waitForHumanDecision<LoginApproval>(ctx, {
      key: "tistory-kakao-additional-verification",
      kind: "form",
      title: "카카오 추가 인증을 확인해 주세요",
      description:
        "계정 입력과 로그인 제출은 자동으로 완료했습니다. 카카오톡 또는 휴대전화에 표시된 추가 인증만 완료한 뒤 승인해 주세요. 아이디와 비밀번호를 다시 입력할 필요는 없습니다.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["completed"],
        properties: {
          completed: {
            type: "boolean",
            const: true,
            title: "추가 인증을 완료했습니다",
          },
        },
      },
      privateContext: { provider: "tistory", connectionId: "default", blogHost: host },
      timeoutMs: 10 * 60 * 1000,
    });
    if (decision.outcome === "cancel" || decision.value?.completed !== true) {
      throw new Error("Tistory login was canceled");
    }

    await waitForAuthenticatedSession(page, origin, host);
  }
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

async function fillCredentials(page: Page, accountId: string, password: string) {
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
  const accountInputName = await accountInput.evaluate((element) => element.getAttribute("name"));
  if (accountInputName !== "loginKey" && accountInputName !== "loginId") {
    throw new Error("Kakao account input was not recognized for automatic login");
  }
  const passwordInput = await page
    .waitForSelector('input[name="password"]', {
      visible: true,
      timeout: LOGIN_FORM_READY_TIMEOUT_MS,
    })
    .catch(() => null);
  if (!passwordInput) {
    throw new Error(
      `Kakao password input was not available for automatic login at ${safePageLocation(page.url())}`,
    );
  }
  await page.locator(`input[name="${accountInputName}"]`).fill(accountId);
  await page.locator('input[name="password"]').fill(password);
  const saveSignedIn = await page.$('input[name="saveSignedIn"]');
  if (
    saveSignedIn &&
    (await saveSignedIn.isVisible().catch(() => false)) &&
    (await saveSignedIn.evaluate((element) => (element as HTMLInputElement).checked))
  ) {
    await saveSignedIn.click();
  }
}

async function submitCredentials(page: Page) {
  const submit = await page
    .waitForSelector('button[type="submit"]', {
      visible: true,
      timeout: LOGIN_FORM_READY_TIMEOUT_MS,
    })
    .catch(() => null);
  if (!submit) {
    throw new Error(
      `Kakao login submit control was not available for automatic login at ${safePageLocation(page.url())}`,
    );
  }
  const navigation = page
    .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 })
    .catch(() => null);
  await submit.click();
  await navigation;
}

async function waitForAuthenticatedSession(
  page: Page,
  origin: string,
  host: string,
): Promise<void> {
  const deadline = Date.now() + AUTHENTICATION_WAIT_TIMEOUT_MS;
  const managementURL = `${origin}/manage/posts/`;
  const apiURL = `${origin}/manage/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all`;

  while (Date.now() < deadline) {
    let currentURL = parsePageURL(page.url());
    if (!currentURL || !isAuthenticatedManagementURL(currentURL, host)) {
      const remaining = deadline - Date.now();
      await page
        .goto(managementURL, {
          waitUntil: "domcontentloaded",
          timeout: Math.max(1, Math.min(10_000, remaining)),
        })
        .catch(() => null);
      currentURL = parsePageURL(page.url());
    }
    if (currentURL && (await isAuthenticatedManagementSession(page, origin, host, apiURL))) return;
    await sleep(Math.min(AUTHENTICATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Tistory management session was not established before the login deadline");
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
