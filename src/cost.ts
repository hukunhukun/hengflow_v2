import type { ModelRef, TokenUsage, WorkerResult } from "./types.js";

export function estimateCost(model: ModelRef, inputTokens: number, outputTokens: number, cacheReadTokens = 0): number {
  const uncachedInput = Math.max(0, inputTokens - cacheReadTokens);
  return (
    (uncachedInput * model.inputUsdPerMillion +
      cacheReadTokens * model.cachedInputUsdPerMillion +
      outputTokens * model.outputUsdPerMillion) /
    1_000_000
  );
}

export function usageShadowCost(model: ModelRef, usage: TokenUsage): number {
  return estimateCost(model, usage.input, usage.output, usage.cacheRead);
}

export function workerShadowCost(result: WorkerResult): number {
  if (!result.attempts?.length) return usageShadowCost(result.route.selected, result.usage);
  return result.attempts.reduce((sum, attempt) => sum + usageShadowCost(attempt.model, attempt.usage), 0);
}

export function emptyUsage(): TokenUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    reportedCostUsd: 0,
  };
}
