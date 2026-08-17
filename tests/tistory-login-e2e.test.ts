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
    expect(parseCredentialsJson('{"accountId":" user@example.com "}')).toEqual({
      accountId: "user@example.com",
    });
    expect(() => parseCredentialsJson('{"accountId":"user","extra":true}')).toThrow(
      "only accountId",
    );
  });

  it("accepts the existing local env variable names", () => {
    expect(
      parseCredentialsEnv("KAKAO_LOGINID=user@example.com\nKAKAO_LOGINPWD='ignored'\n"),
    ).toEqual({
      accountId: "user@example.com",
    });
  });

  it("provisions the account hint as an app-scoped Secret Variable", () => {
    const variables = credentialVariableRequests({ accountId: "user" });
    expect(variables).toMatchObject([{ app_key: "publication", is_secret: true, value: "user" }]);
    expect(loginInputConfigRequest()).toEqual({
      action_key: "connection.login",
      config: {
        accountId: "$var@app:connections/tistory/default/account-id",
      },
      locked_keys: ["accountId"],
    });
  });

  it("keeps credentials out of the persisted Run input", () => {
    expect(loginRunInput("https://pak2251.tistory.com/manage")).toEqual({
      blogHost: "pak2251.tistory.com",
    });
  });
});
