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

interface LoginApproval {
  completed: boolean;
}

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
  });
  const context = browser.defaultBrowserContext();
  const page = await context.newPage();
  try {
    await page.goto(`${origin}/manage/newpost`, { waitUntil: "domcontentloaded" });
    await openKakaoLoginIfNeeded(page);
    await fillCredentialsIfPresent(page, input.accountId, input.password);

    const decision = await ctx.human.wait<LoginApproval>({
      key: "tistory-kakao-login",
      kind: "form",
      title: "카카오 로그인을 완료해 주세요",
      description:
        "열린 브라우저에서 로그인 버튼을 직접 누르고 2단계 인증까지 끝낸 뒤 승인해 주세요.",
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

    await verifyAuthenticated(page, origin, host);
    const capturedAt = new Date().toISOString();
    const storageState = await captureStorageState(context);
    if (!storageState.cookies.some((cookie) => cookie.domain.includes("tistory.com"))) {
      throw new Error("Tistory session cookie was not captured");
    }
    const sessionStorage = await captureSessionStorage(context);
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
      provider: "tistory" as const,
      connectionId: "default" as const,
      blogHost: host,
      publicUrl: profile.publicUrl,
      capturedAt,
      authenticated: true as const,
    };
  } finally {
    await browser.disconnect();
  }
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

async function verifyAuthenticated(page: Page, origin: string, host: string): Promise<void> {
  if (page.url().includes("accounts.kakao.com")) {
    throw new Error("Kakao login has not completed");
  }
  await page.goto(`${origin}/manage/posts/`, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).hostname !== host || page.url().includes("/auth/")) {
    throw new Error("Tistory management session could not be verified");
  }
  const status = await page.evaluate(
    async (endpoint) =>
      (
        await fetch(endpoint, {
          credentials: "include",
          redirect: "manual",
        })
      ).status,
    `${origin}/manage/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all`,
  );
  if (status < 200 || status >= 300) {
    throw new Error("Tistory management API rejected the captured session");
  }
}

async function isVisible(page: Page, selector: string): Promise<boolean> {
  const element = await page.$(selector);
  return element ? element.isVisible().catch(() => false) : false;
}

async function captureStorageState(
  context: BrowserContext,
): Promise<TistorySession["storageState"]> {
  const cookies = (await context.cookies()).map((cookie) => ({
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
  const origins: TistorySession["storageState"]["origins"] = [];
  const seen = new Set<string>();
  for (const page of await context.pages()) {
    const url = new URL(page.url());
    if (url.protocol !== "https:" || seen.has(url.origin)) continue;
    const localStorage = await page
      .evaluate(() => Object.entries(window.localStorage).map(([name, value]) => ({ name, value })))
      .catch(() => []);
    origins.push({ origin: url.origin, localStorage });
    seen.add(url.origin);
  }
  return { cookies, origins };
}

async function captureSessionStorage(context: BrowserContext) {
  const values: Array<{ origin: string; items: Record<string, string> }> = [];
  for (const page of await context.pages()) {
    const url = new URL(page.url());
    if (url.protocol !== "https:") continue;
    const items = await page
      .evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))
      .catch(() => ({}));
    values.push({ origin: url.origin, items });
  }
  return values;
}
