import { describe, expect, it } from "vitest";
import { loadCloudTarget, normalizeCloudTarget, saveCloudTarget } from "./cloud-target";

describe("Cloud target", () => {
  it("accepts an exact Imprun Cloud origin and workspace", () => {
    expect(normalizeCloudTarget("https://example.cloud.imprun.dev/", "docs-team")).toEqual({
      baseUrl: "https://example.cloud.imprun.dev",
      workspace: "docs-team",
    });
  });

  it("rejects credentials, paths, foreign hosts, and invalid workspaces", () => {
    expect(() =>
      normalizeCloudTarget("https://user@example.cloud.imprun.dev", "docs-team"),
    ).toThrow();
    expect(() =>
      normalizeCloudTarget("https://example.cloud.imprun.dev/api", "docs-team"),
    ).toThrow();
    expect(() => normalizeCloudTarget("https://example.com", "docs-team")).toThrow();
    expect(() =>
      normalizeCloudTarget("https://example.cloud.imprun.dev", "bad workspace"),
    ).toThrow();
  });

  it("stores only the validated target", () => {
    const storage = window.localStorage;
    storage.clear();
    const target = normalizeCloudTarget("https://example.cloud.imprun.dev", "docs-team");
    saveCloudTarget(target, storage);
    expect(loadCloudTarget(storage)).toEqual(target);
    expect(storage.length).toBe(1);
  });
});
