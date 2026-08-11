import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { estimateCost, workerShadowCost } from "../cost.js";
import type { WorkerResult } from "../types.js";

test("uses cached and uncached input prices separately", () => {
  const cost = estimateCost(DEFAULT_CONFIG.workers.deepseek, 1_000_000, 1_000_000, 500_000);
  assert.ok(Math.abs(cost - (0.5 * 0.14 + 0.5 * 0.0028 + 0.28)) < 1e-12);
});

test("GLM uses reference shadow pricing", () => {
  const cost = estimateCost(DEFAULT_CONFIG.workers.glm, 1_000_000, 1_000_000);
  assert.equal(cost, 5.8);
});

test("prices every fallback attempt with its actual model", () => {
  const usage = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, reportedCostUsd: 0 };
  const result: WorkerResult = {
    task: {
      id: "retry", objective: "test", kind: "coding", risk: "low", complexity: 0.5,
      estimatedInputTokens: 1000, estimatedOutputTokens: 100,
    },
    route: {
      taskId: "retry", selected: DEFAULT_CONFIG.workers.glm, score: 0,
      predictedCostUsd: 0, predictedFailureProbability: 0, explanation: [],
    },
    output: "ok", exitCode: 0, durationMs: 2, usage: { ...usage, input: 2000, output: 200 },
    retried: true,
    attempts: [
      { model: DEFAULT_CONFIG.workers.deepseek, usage, durationMs: 1, exitCode: 1 },
      { model: DEFAULT_CONFIG.workers.glm, usage, durationMs: 1, exitCode: 0 },
    ],
  };
  const expected = estimateCost(DEFAULT_CONFIG.workers.deepseek, 1000, 100) +
    estimateCost(DEFAULT_CONFIG.workers.glm, 1000, 100);
  assert.equal(workerShadowCost(result), expected);
});
