import { describe, expect, it } from "vitest";
import {
  createExampleDraft,
  credentialVariableRequests,
  loginRunInput,
  parseArgs,
  parseCredentialsEnv,
  parseCredentialsJson,
  privatePublishInput,
} from "../scripts/tistory-login-e2e.js";

describe("Tistory login E2E CLI contract", () => {
  it("accepts an exact local credential document", () => {
    expect(parseCredentialsJson('{"accountId":" user@example.com ","password":"secret"}')).toEqual({
      accountId: "user@example.com",
      password: "secret",
    });
    expect(() =>
      parseCredentialsJson('{"accountId":"user","password":"secret","extra":true}'),
    ).toThrow("only accountId and password");
  });

  it("accepts the existing local env variable names", () => {
    expect(
      parseCredentialsEnv("KAKAO_LOGINID=user@example.com\nKAKAO_LOGINPWD='secret'\n"),
    ).toEqual({
      accountId: "user@example.com",
      password: "secret",
    });
  });

  it("provisions credentials as actor-scoped Secret Variables", () => {
    const variables = credentialVariableRequests({ accountId: "user", password: "secret" });
    expect(variables).toMatchObject([
      { app_key: "publication", is_secret: true, scope: "actor", value: "user" },
      { app_key: "publication", is_secret: true, scope: "actor", value: "secret" },
    ]);
  });

  it("keeps credentials out of the persisted Run input", () => {
    expect(loginRunInput("https://example-blog.tistory.com/manage")).toEqual({
      blogHost: "example-blog.tistory.com",
    });
  });

  it("provides an explicit login/status-only boundary that cannot be combined with configure-only", () => {
    expect(
      parseArgs([
        "--context",
        "imprun",
        "--blog-host",
        "example.tistory.com",
        "--credentials",
        "credentials.json",
        "--login-status-only",
      ]),
    ).toMatchObject({ loginStatusOnly: true, configureOnly: false });
    expect(() =>
      parseArgs([
        "--context",
        "imprun",
        "--blog-host",
        "example.tistory.com",
        "--credentials",
        "credentials.json",
        "--configure-only",
        "--login-status-only",
      ]),
    ).toThrow("mutually exclusive");
  });

  it("builds a unique private publish input from example Markdown", () => {
    const draft = createExampleDraft("# fixture", new Date("2026-08-18T00:00:00.000Z"));
    expect(draft).toMatchObject({
      title: "[publication E2E] 2026-08-18T00:00:00.000Z",
      content: { format: "markdown", body: "# fixture" },
      categoryId: 0,
    });
    expect(privatePublishInput(draft, `sha256:${"a".repeat(64)}`)).toMatchObject({
      visibility: "private",
      draftHash: `sha256:${"a".repeat(64)}`,
    });
  });
});
