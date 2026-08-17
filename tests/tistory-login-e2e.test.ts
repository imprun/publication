import { describe, expect, it } from "vitest";
import {
  createExampleDraft,
  credentialVariableRequests,
  loginInputConfigRequest,
  loginRunInput,
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

  it("provisions credentials as app-scoped Secret Variables", () => {
    const variables = credentialVariableRequests({ accountId: "user", password: "secret" });
    expect(variables).toMatchObject([
      { app_key: "publication", is_secret: true, value: "user" },
      { app_key: "publication", is_secret: true, value: "secret" },
    ]);
    expect(loginInputConfigRequest()).toEqual({
      action_key: "connection.login",
      config: {
        accountId: "$var@app:connections/tistory/default/account-id",
        password: "$var@app:connections/tistory/default/password",
      },
      locked_keys: ["accountId", "password"],
    });
  });

  it("keeps credentials out of the persisted Run input", () => {
    expect(loginRunInput("https://pak2251.tistory.com/manage")).toEqual({
      blogHost: "pak2251.tistory.com",
    });
  });

  it("builds a unique private publish input from example Markdown", () => {
    const draft = createExampleDraft("# fixture", new Date("2026-08-18T00:00:00.000Z"));
    expect(draft).toMatchObject({
      title: "[publication E2E] 2026-08-18T00:00:00.000Z",
      markdown: "# fixture",
      categoryId: 0,
    });
    expect(privatePublishInput(draft, `sha256:${"a".repeat(64)}`)).toMatchObject({
      visibility: "private",
      draftHash: `sha256:${"a".repeat(64)}`,
    });
  });
});
