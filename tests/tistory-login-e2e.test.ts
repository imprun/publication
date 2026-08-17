import { describe, expect, it } from "vitest";
import {
  credentialVariableRequests,
  loginInputConfigRequest,
  loginRunInput,
  parseCredentialsEnv,
  parseCredentialsJson,
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

  it("provisions app-scoped Secret Variables and binds only references", () => {
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
});
