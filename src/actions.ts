import { randomUUID } from "node:crypto";
import type { WindforceContext } from "@imprun/app-sdk";
import { TISTORY_ACCOUNT_ID_PATH, TISTORY_PASSWORD_PATH, TISTORY_SESSION_PATH } from "./config.js";
import {
  connectionInputSchema,
  connectionLoginInputSchema,
  mediaUploadInputSchema,
  postDeleteInputSchema,
  postPrepareInputSchema,
  postPublishInputSchema,
  postUpdateInputSchema,
} from "./contracts.js";
import { TistoryClient } from "./providers/tistory/client.js";
import { loginToTistory } from "./providers/tistory/login.js";
import { TistoryProvider } from "./providers/tistory/provider.js";
import { loadTistoryConnection } from "./session.js";

const provider = new TistoryProvider();

export async function connectionLogin(ctx: WindforceContext) {
  const input = connectionLoginInputSchema.parse(ctx.input);
  const accountId = (await ctx.variables.get(TISTORY_ACCOUNT_ID_PATH, "actor")).trim();
  const password = await ctx.variables.get(TISTORY_PASSWORD_PATH, "actor");
  try {
    const result = await loginToTistory({ ...input, accountId, password }, ctx);
    await clearTistoryCredentials(ctx);
    return result;
  } catch (error) {
    try {
      await clearTistoryCredentials(ctx);
    } catch {
      ctx.logger.warn("Failed to clear temporary Tistory login credentials");
    }
    throw error;
  }
}

async function clearTistoryCredentials(ctx: WindforceContext) {
  for (const path of [TISTORY_ACCOUNT_ID_PATH, TISTORY_PASSWORD_PATH]) {
    await ctx.variables.set(path, "", {
      operationId: randomUUID(),
      scope: "actor",
    });
  }
}

export async function connectionStatus(ctx: WindforceContext) {
  connectionInputSchema.parse(ctx.input);
  try {
    const { connection, session } = await loadTistoryConnection(ctx);
    const client = new TistoryClient(ctx.http.fetch.bind(ctx.http), connection, session);
    try {
      await client.requestJson(
        "/manage/posts.json?category=-3&page=1&searchKeyword=&searchType=title&visibility=all",
      );
    } catch {
      return {
        provider: "tistory" as const,
        connectionId: "default" as const,
        blogHost: connection.blogHost,
        publicUrl: connection.publicUrl,
        capturedAt: connection.capturedAt,
        checkedAt: new Date().toISOString(),
        authenticated: false,
        status: "expired" as const,
      };
    }
    return {
      provider: "tistory" as const,
      connectionId: "default" as const,
      blogHost: connection.blogHost,
      publicUrl: connection.publicUrl,
      capturedAt: connection.capturedAt,
      checkedAt: new Date().toISOString(),
      authenticated: true,
      status: "ready" as const,
    };
  } catch {
    return {
      provider: "tistory" as const,
      connectionId: "default" as const,
      blogHost: "",
      publicUrl: "https://www.tistory.com/",
      checkedAt: new Date().toISOString(),
      authenticated: false,
      status: "missing" as const,
    };
  }
}

export async function connectionDisconnect(ctx: WindforceContext) {
  connectionInputSchema.parse(ctx.input);
  let blogHost = "";
  let publicUrl = "https://www.tistory.com/";
  try {
    const { connection } = await loadTistoryConnection(ctx);
    blogHost = connection.blogHost;
    publicUrl = connection.publicUrl;
  } catch {
    // Disconnect remains idempotent when no usable session exists.
  }
  for (const path of [TISTORY_SESSION_PATH, TISTORY_ACCOUNT_ID_PATH, TISTORY_PASSWORD_PATH]) {
    await ctx.variables.set(path, "", {
      operationId: randomUUID(),
      scope: "actor",
    });
  }
  return {
    provider: "tistory" as const,
    connectionId: "default" as const,
    blogHost,
    publicUrl,
    checkedAt: new Date().toISOString(),
    authenticated: false,
    status: "missing" as const,
  };
}

export async function listCategories(ctx: WindforceContext) {
  connectionInputSchema.parse(ctx.input);
  const { connection, session } = await loadTistoryConnection(ctx);
  const client = new TistoryClient(ctx.http.fetch.bind(ctx.http), connection, session);
  const response = await client.requestJson<unknown>("/manage/category.json");
  return {
    provider: "tistory" as const,
    connectionId: "default" as const,
    categories: extractCategories(response),
  };
}

export async function mediaUpload(ctx: WindforceContext) {
  return provider.upload(mediaUploadInputSchema.parse(ctx.input), ctx);
}

export async function postPrepare(ctx: WindforceContext) {
  return provider.prepare(postPrepareInputSchema.parse(ctx.input));
}

export async function postPublish(ctx: WindforceContext) {
  return provider.publish(postPublishInputSchema.parse(ctx.input), ctx);
}

export async function postUpdate(ctx: WindforceContext) {
  return provider.update(postUpdateInputSchema.parse(ctx.input), ctx);
}

export async function postDelete(ctx: WindforceContext) {
  return provider.delete(postDeleteInputSchema.parse(ctx.input), ctx);
}

function extractCategories(response: unknown): unknown[] {
  if (Array.isArray(response)) return response;
  if (!response || typeof response !== "object") {
    throw new Error("Tistory returned an invalid category response");
  }
  for (const key of ["categories", "items", "categoryList"]) {
    const value = (response as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value;
  }
  throw new Error("Tistory category list was not found in the response");
}
