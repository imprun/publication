import type { HumanTaskDecision, HumanTaskRequest, WindforceContext } from "@imprun/app-sdk";

const DEFAULT_HOLD_TIMEOUT_MS = 120_000;
const DEADLINE_GRACE_MS = 10_000;

/**
 * Preserve a HumanTask hold when an older Core runtime exposes its internal
 * 30-second fetch abort instead of reconnecting with the stable task key.
 */
export async function waitForHumanDecision<T>(
  ctx: WindforceContext,
  request: HumanTaskRequest,
): Promise<HumanTaskDecision<T>> {
  const deadline = Date.now() + (request.timeoutMs ?? DEFAULT_HOLD_TIMEOUT_MS) + DEADLINE_GRACE_MS;
  let retryMs = 200;
  for (;;) {
    try {
      return await ctx.human.wait<T>(request);
    } catch (error) {
      if (!isTransportAbort(error) || Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    retryMs = Math.min(retryMs * 2, 2_000);
  }
}

function isTransportAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { name?: unknown; code?: unknown };
  return (
    candidate.name === "AbortError" &&
    (candidate.code === undefined || candidate.code === 20 || candidate.code === "ABORT_ERR")
  );
}
