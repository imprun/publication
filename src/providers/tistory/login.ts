import { randomUUID } from "node:crypto";
import type { WindforceContext } from "@imprun/app-sdk";
import type { BrowserContext, Page } from "playwright";
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
  const { chromium } = await loadPlaywright();
  const browser = await chromium.connectOverCDP(ctx.capabilities.webSocketEndpoint("edge-cdp"), {
    headers: { ...ctx.capabilities.headers },
  });
  const context = browser.contexts()[0];
  if (!context) {
    await browser.close();
    throw new Error("The assigned edge-cdp browser has no persistent context");
  }
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

    await verifyAuthenticated(context, page, origin, host);
    const capturedAt = new Date().toISOString();
    const storageState = await context.storageState();
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
    await browser.close();
  }
}

async function loadPlaywright(): Promise<typeof import("playwright")> {
  // Keep the browser runtime out of Core's static entrypoint verification bundle.
  // The browser worker resolves this declared dependency when the login action runs.
  return import(["play", "wright"].join(""));
}

async function openKakaoLoginIfNeeded(page: Page): Promise<void> {
  const loginId = page.locator('input[name="loginId"]');
  if (await loginId.isVisible().catch(() => false)) return;
  const kakaoButton = page.getByText("카카오계정으로 로그인", { exact: false }).first();
  if (await kakaoButton.isVisible().catch(() => false)) {
    await kakaoButton.click();
    await page.waitForLoadState("domcontentloaded");
  }
}

async function fillCredentialsIfPresent(page: Page, accountId: string, password: string) {
  const loginId = page.locator('input[name="loginId"]');
  const passwordInput = page.locator('input[name="password"]');
  if (await loginId.isVisible().catch(() => false)) await loginId.fill(accountId);
  if (await passwordInput.isVisible().catch(() => false)) await passwordInput.fill(password);
  const saveSignedIn = page.locator('input[name="saveSignedIn"]');
  if ((await saveSignedIn.isVisible().catch(() => false)) && (await saveSignedIn.isChecked())) {
    await saveSignedIn.uncheck();
  }
}

async function verifyAuthenticated(
  context: BrowserContext,
  page: Page,
  origin: string,
  host: string,
): Promise<void> {
  if (page.url().includes("accounts.kakao.com")) {
    throw new Error("Kakao login has not completed");
  }
  await page.goto(`${origin}/manage/posts/`, { waitUntil: "domcontentloaded" });
  if (new URL(page.url()).hostname !== host || page.url().includes("/auth/")) {
    throw new Error("Tistory management session could not be verified");
  }
  const response = await context.request.get(
    `${origin}/manage/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all`,
    { maxRedirects: 0 },
  );
  if (!response.ok()) throw new Error("Tistory management API rejected the captured session");
}

async function captureSessionStorage(context: BrowserContext) {
  const values: Array<{ origin: string; items: Record<string, string> }> = [];
  for (const page of context.pages()) {
    const url = new URL(page.url());
    if (url.protocol !== "https:") continue;
    const items = await page
      .evaluate(() => Object.fromEntries(Object.entries(sessionStorage)))
      .catch(() => ({}));
    values.push({ origin: url.origin, items });
  }
  return values;
}
