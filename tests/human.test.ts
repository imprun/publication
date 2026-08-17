import type { HumanTaskRequest, WindforceContext } from "@imprun/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { waitForHumanDecision } from "../src/human.js";

const request: HumanTaskRequest = {
  key: "stable-login-key",
  kind: "form",
  title: "Login",
  inputSchema: { type: "object" },
  timeoutMs: 60_000,
};

describe("waitForHumanDecision", () => {
  it("reconnects with the same request after Bun exposes a transport AbortError", async () => {
    const abort = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
      code: 20,
    });
    const wait = vi
      .fn()
      .mockRejectedValueOnce(abort)
      .mockResolvedValueOnce({ taskId: "task-1", outcome: "submit", value: { completed: true } });
    const ctx = { human: { wait } } as unknown as WindforceContext;

    await expect(waitForHumanDecision(ctx, request)).resolves.toEqual({
      taskId: "task-1",
      outcome: "submit",
      value: { completed: true },
    });
    expect(wait).toHaveBeenCalledTimes(2);
    expect(wait.mock.calls[0]?.[0]).toBe(request);
    expect(wait.mock.calls[1]?.[0]).toBe(request);
  });

  it("does not retry application errors", async () => {
    const failure = Object.assign(new Error("task expired"), { code: "human_task_deadline" });
    const wait = vi.fn().mockRejectedValue(failure);
    const ctx = { human: { wait } } as unknown as WindforceContext;

    await expect(waitForHumanDecision(ctx, request)).rejects.toBe(failure);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
