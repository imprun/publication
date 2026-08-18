import { describe, expect, it } from "vitest";
import { safeLocalReturnTo } from "./session";

describe("safeLocalReturnTo", () => {
  it("accepts only same-origin absolute paths", () => {
    expect(safeLocalReturnTo("/posts/new")).toBe("/posts/new");
    expect(safeLocalReturnTo("//attacker.example/path")).toBe("/");
    expect(safeLocalReturnTo("https://attacker.example/path")).toBe("/");
    expect(safeLocalReturnTo(undefined)).toBe("/");
  });
});
