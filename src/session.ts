import type { WindforceContext } from "@imprun/app-sdk";
import { z } from "zod";
import { TISTORY_PROFILE_PATH, TISTORY_SESSION_PATH, TISTORY_SESSION_REFERENCE } from "./config.js";

const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string(),
  path: z.string(),
  expires: z.number(),
  httpOnly: z.boolean(),
  secure: z.boolean(),
  sameSite: z.enum(["Strict", "Lax", "None"]),
});

const originSchema = z.object({
  origin: z.string().url(),
  localStorage: z.array(z.object({ name: z.string(), value: z.string() })),
});

export const tistorySessionSchema = z.object({
  version: z.literal(1),
  capturedAt: z.string().datetime(),
  userAgent: z.string().min(1),
  storageState: z.object({
    cookies: z.array(cookieSchema),
    origins: z.array(originSchema),
  }),
  sessionStorage: z.array(
    z.object({
      origin: z.string().url(),
      items: z.record(z.string(), z.string()),
    }),
  ),
});

export const tistoryConnectionSchema = z.object({
  version: z.literal(1),
  provider: z.literal("tistory"),
  connectionId: z.literal("default"),
  blogHost: z.string(),
  blogTitle: z.string().optional(),
  publicUrl: z.string().url(),
  manageUrl: z.string().url(),
  capturedAt: z.string().datetime(),
  sessionSecretRef: z.literal(TISTORY_SESSION_REFERENCE),
});

export type TistorySession = z.infer<typeof tistorySessionSchema>;
export type TistoryConnection = z.infer<typeof tistoryConnectionSchema>;

export async function loadTistoryConnection(
  ctx: WindforceContext,
): Promise<{ connection: TistoryConnection; session: TistorySession }> {
  const resource = z
    .object({
      version: z.literal(1),
      provider: z.literal("tistory"),
      connectionId: z.literal("default"),
      blogHost: z.string(),
      blogTitle: z.string().optional(),
      publicUrl: z.string().url(),
      manageUrl: z.string().url(),
      capturedAt: z.string().datetime(),
      sessionSecretRef: z.unknown(),
    })
    .parse(await ctx.resources.get(TISTORY_PROFILE_PATH, "app"));
  const connection = tistoryConnectionSchema.parse({
    ...resource,
    sessionSecretRef: TISTORY_SESSION_REFERENCE,
  });
  const rawSecret =
    resource.sessionSecretRef === TISTORY_SESSION_REFERENCE
      ? await ctx.variables.get(TISTORY_SESSION_PATH, "app")
      : resource.sessionSecretRef;
  const parsedSecret = typeof rawSecret === "string" ? JSON.parse(rawSecret) : rawSecret;
  const session = tistorySessionSchema.parse(parsedSecret);
  return { connection, session };
}

export function cookieHeaderForHost(session: TistorySession, host: string, path = "/"): string {
  const nowSeconds = Date.now() / 1000;
  return session.storageState.cookies
    .filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "").toLowerCase();
      const domainMatches = host === domain || host.endsWith(`.${domain}`);
      const pathMatches = path.startsWith(cookie.path);
      const unexpired = cookie.expires === -1 || cookie.expires > nowSeconds;
      return domainMatches && pathMatches && unexpired;
    })
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
}
