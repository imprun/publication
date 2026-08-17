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
const TARGET_CLEANUP_TIMEOUT_MS = 5_000;
const TARGET_CLEANUP_POLL_INTERVAL_MS = 50;

export async function loginToTistory(input: ConnectionLoginInput, ctx: WindforceContext) {
  const host = normalizeTistoryHost(input.blogHost);
  const origin = tistoryOrigin(host);
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
    result = await performLogin(input, ctx, host, origin, page);
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
  input: ConnectionLoginInput,
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
  await fillCredentialsIfPresent(page, input.accountId, input.password);
  await submitCredentialsIfPresent(page, input.accountId, input.password);

  const decision = await waitForHumanDecision<LoginApproval>(ctx, {
    key: "tistory-kakao-login",
    kind: "form",
    title: "카카오 로그인을 완료해 주세요",
    description:
      "계정 입력과 로그인을 자동 제출했습니다. 열린 브라우저에서 CAPTCHA 또는 2단계 인증을 끝낸 뒤 승인해 주세요.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["completed"],
      properties: {
        completed: {
          type: "boolean",
          const: true,
          title: "로그인을 완료했습니다",
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
  if (await isVisible(page, 'input[name="loginId"]')) return;
  const kakaoButton = await page.$("a.btn_login.link_kakao_id");
  if (kakaoButton && (await kakaoButton.isVisible().catch(() => false))) {
    const navigation = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 })
      .catch(() => null);
    await kakaoButton.click();
    await navigation;
  }
}

async function fillCredentialsIfPresent(page: Page, accountId?: string, password?: string) {
  if (accountId && (await isVisible(page, 'input[name="loginId"]'))) {
    await page.locator('input[name="loginId"]').fill(accountId);
  }
  if (password && (await isVisible(page, 'input[name="password"]'))) {
    await page.locator('input[name="password"]').fill(password);
  }
  const saveSignedIn = await page.$('input[name="saveSignedIn"]');
  if (
    saveSignedIn &&
    (await saveSignedIn.isVisible().catch(() => false)) &&
    (await saveSignedIn.evaluate((element) => (element as HTMLInputElement).checked))
  ) {
    await saveSignedIn.click();
  }
}

async function submitCredentialsIfPresent(page: Page, accountId?: string, password?: string) {
  if (!accountId || !password) return;
  const submit = await page.$('button[type="submit"]');
  if (!submit || !(await submit.isVisible().catch(() => false))) return;
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
    if (currentURL && isAuthenticatedManagementURL(currentURL, host)) {
      const apiAuthenticated = await page
        .evaluate(async (endpoint) => {
          const response = await fetch(endpoint, {
            credentials: "include",
            redirect: "manual",
          });
          const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
          return response.status >= 200 && response.status < 300 && contentType.includes("json");
        }, apiURL)
        .catch(() => false);
      if (apiAuthenticated) return;
    }
    await sleep(Math.min(AUTHENTICATION_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())));
  }
  throw new Error("Tistory management session was not established before the login deadline");
}

function parsePageURL(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
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
