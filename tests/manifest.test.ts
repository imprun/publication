import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../src/main.js";

const root = join(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(root, "windforce.json"), "utf8"));

describe("Windforce manifest", () => {
  it("derives the checked-in manifest through the public Application SDK", () => {
    const mainSource = readFileSync(join(root, "src", "main.ts"), "utf8");
    expect(mainSource).toContain('from "@imprun/app-sdk"');
    expect(mainSource).toContain("defineApp({");
    expect(mainSource).not.toContain("ctx.action");
    expect(existsSync(join(root, "src", "runtime.ts"))).toBe(false);
    expect(manifest).toEqual(app.describe().manifest);
  });

  it("keeps Puppeteer available at runtime without adding it to Core's static bundle graph", () => {
    const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    const bunConfig = readFileSync(join(root, "bunfig.toml"), "utf8");
    const loginSource = readFileSync(join(root, "src", "providers", "tistory", "login.ts"), "utf8");
    expect(packageJson.dependencies["puppeteer-core"]).toBe("25.7.0");
    expect(bunConfig).toContain('linker = "hoisted"');
    expect(bunConfig).toContain("production = true");
    expect(loginSource).toContain('import(["puppeteer", "-core"].join(""))');
  });

  it("grants session writes only to the browser login action", () => {
    const login = manifest.actions["connection.login"];
    expect(login.runsOn).toEqual(["browser"]);
    expect(login.runtimeAccess.writeVariables).toEqual([
      {
        scope: "app",
        path: "connections/tistory/default/session",
        storage: "secret",
      },
    ]);
    for (const [name, action] of Object.entries(manifest.actions)) {
      if (name === "connection.login") continue;
      expect((action as Record<string, unknown>).runtimeAccess).not.toMatchObject({
        writeVariables: expect.anything(),
        writeResources: expect.anything(),
      });
    }
  });

  it("declares the exact secret read closure wherever the connection Resource is read", () => {
    for (const [name, action] of Object.entries(manifest.actions)) {
      const access = (action as { runtimeAccess?: Record<string, unknown> }).runtimeAccess;
      if (!access || name === "post.prepare") continue;
      expect(access.variables).toContainEqual({
        scope: "app",
        path: "connections/tistory/default/session",
      });
      expect(access.resources).toContainEqual({
        scope: "app",
        path: "connections/tistory/default/profile",
      });
    }
  });

  it("marks credentials and raw media as write-only and leaks no session schema", () => {
    const loginSchema = JSON.parse(
      readFileSync(join(root, "schemas", "connection.login.input.schema.json"), "utf8"),
    );
    expect(loginSchema.properties.accountId.writeOnly).toBe(true);
    expect(loginSchema.properties.password.writeOnly).toBe(true);
    expect(loginSchema.required).toEqual(["blogHost"]);

    for (const filename of readdirSync(join(root, "schemas")).filter((name) =>
      name.endsWith("output.schema.json"),
    )) {
      const text = readFileSync(join(root, "schemas", filename), "utf8").toLowerCase();
      expect(text).not.toContain("cookie");
      expect(text).not.toContain("password");
      expect(text).not.toContain("storagestate");
    }
  });

  it("uses Kakao page JavaScript without inspecting login controls", () => {
    const loginSource = readFileSync(join(root, "src", "providers", "tistory", "login.ts"), "utf8");
    expect(loginSource).toContain("authorize.call(auth");
    expect(loginSource).toContain('client.call("authenticate"');
    expect(loginSource).toContain('client.call("check_tms_for_two_step_verification"');
    expect(loginSource).toContain("webpackChunk_N_E");
    expect(loginSource).toContain("character.charCodeAt(0).toString(16)");
    expect(loginSource).toContain("mo: userAgentData?.mobile ? 1 : 0");
    expect(loginSource).toContain("kakaoAuthState");
    for (const forbidden of [
      "waitForSelector",
      "locator(",
      "button[type=",
      "input[name=",
      "waitForNavigation",
      "requestSubmit",
      "dispatchEvent",
    ]) {
      expect(loginSource).not.toContain(forbidden);
    }
  });
});
