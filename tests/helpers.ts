import type { WindforceContext } from "@imprun/app-sdk";
import type { TistoryConnection, TistorySession } from "../src/session.js";

export function sampleSession(): TistorySession {
  return {
    version: 1,
    capturedAt: "2026-08-17T00:00:00.000Z",
    userAgent: "publication-test-agent",
    storageState: {
      cookies: [
        {
          name: "TSSESSION",
          value: "test-cookie-not-a-real-secret",
          domain: ".tistory.com",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: true,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
    sessionStorage: [],
  };
}

export function sampleConnection(): TistoryConnection {
  return {
    version: 1,
    provider: "tistory",
    connectionId: "default",
    blogHost: "example.tistory.com",
    publicUrl: "https://example.tistory.com/",
    manageUrl: "https://example.tistory.com/manage",
    capturedAt: "2026-08-17T00:00:00.000Z",
    sessionSecretRef: "actor-variable:connections/tistory/default/session",
  };
}

export function mockContext(
  fetcher: WindforceContext["http"]["fetch"],
  input: unknown = {},
): WindforceContext {
  const connection = sampleConnection();
  const session = sampleSession();
  return {
    action: "test",
    input,
    app: "publication",
    trigger: { kind: "manual" },
    job: { id: "job-test", workspace: "workspace-test", tag: "" },
    actor: { email: "", username: "test", permissionedAs: "test" },
    telemetry: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    variables: {
      async get() {
        return JSON.stringify(session);
      },
      async set(path) {
        return { path, revision: 1 };
      },
    },
    resources: {
      async get() {
        return { ...connection, sessionSecretRef: JSON.stringify(session) };
      },
      async set(path) {
        return { path, revision: 1 };
      },
    },
    http: { fetch: fetcher },
    state: {
      async get() {
        return undefined;
      },
      async set() {},
    },
    human: {
      async wait<T>() {
        return { taskId: "task-test", outcome: "submit", value: { approved: true } as T };
      },
    },
    approval: {
      async getResumeUrls() {
        return {
          approve: "https://example.invalid/approve",
          reject: "https://example.invalid/reject",
          resume_id: 1,
          step_index: 1,
          expires_at: 1,
        };
      },
    },
    flow: {},
  };
}
