import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, type HengFlowConfig } from "../config.js";
import { emptyUsage, estimateCost } from "../cost.js";
import { UsageLedger } from "../ledger.js";
import { hashSeed, SeededRandom } from "../rng.js";
import { routeTask } from "../router.js";
import type { DelegatedTask, ModelRef, RouteDecision, WorkerResult } from "../types.js";

/**
 * v4 offline replay: a synthetic workload with hidden per-model true success
 * rates. Compares two policies on identical worlds:
 *   static-cheapest — always route to the lowest-priced worker;
 *   learned-ts      — Router v4 (net utility + Thompson sampling) fed by
 *                     recorded outcomes.
 * The learned router must converge to the higher-reward model and beat the
 * static policy on cumulative reward, without any hand-tuned exploration.
 */

function tempLedger(): UsageLedger {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-replay-"));
  return new UsageLedger(join(dir, "usage.sqlite"));
}

function researchTask(index: number): DelegatedTask {
  return {
    id: `research-${index}`, objective: "survey a topic", kind: "research", risk: "low", complexity: 0.5,
    estimatedInputTokens: 10_000, estimatedOutputTokens: 800,
  };
}

function workerResult(task: DelegatedTask, route: RouteDecision, success: boolean): WorkerResult {
  return {
    task, route: { ...route, selected: route.selected }, output: success ? "ok" : "wrong",
    exitCode: 0, durationMs: 1_000,
    usage: { ...emptyUsage(), input: 10_000, output: 800, totalTokens: 10_800 },
    model: route.selected.model, stopReason: "stop", retried: false,
    attempts: [{ model: route.selected, usage: emptyUsage(), durationMs: 1_000, exitCode: 0 }],
  };
}

function runPolicy(
  policy: "static-cheapest" | "learned-ts",
  config: HengFlowConfig,
  world: SeededRandom,
): { reward: number; picks: Record<string, number> } {
  const store = tempLedger();
  const trueSuccess: Record<string, number> = {
    deepseek: 0.35, // cheap but weak on research
    glm: 0.9,       // pricier but strong
  };
  let reward = 0;
  const picks: Record<string, number> = { deepseek: 0, glm: 0 };
  try {
    for (let index = 0; index < 40; index++) {
      const task = researchTask(index);
      const available = new Set(["deepseek", "glm"]);
      const route = policy === "static-cheapest"
        ? {
          ...routeTask(task, config, store, available),
          selected: config.workers.deepseek,
        }
        : routeTask(task, config, store, available, { rng: new SeededRandom(hashSeed("replay", String(index))) });
      picks[route.selected.id === "glm" ? "glm" : "deepseek"] += 1;
      const success = world.next() < trueSuccess[route.selected.id === "glm" ? "glm" : "deepseek"];
      if (success) reward += 1;
      store.recordOutcome(
        `replay-${policy}-${index}`,
        workerResult(task, route, success),
        { taskId: task.id, status: success ? "accepted" : "rejected", quality: success ? 0.95 : 0.1, confidence: 0.9 },
        route.selected,
      );
    }
  } finally {
    store.close();
  }
  return { reward, picks };
}

test("learned TS routing converges to the better model and beats static-cheapest", () => {
  const config: HengFlowConfig = structuredClone(DEFAULT_CONFIG);
  const staticRun = runPolicy("static-cheapest", config, new SeededRandom(42));
  const learnedRun = runPolicy("learned-ts", config, new SeededRandom(42));

  // Same world draws → fair comparison; learned must clearly win on reward.
  assert.ok(
    learnedRun.reward > staticRun.reward,
    `learned reward ${learnedRun.reward} must exceed static ${staticRun.reward}`,
  );
  // ... because it converges onto the strong model for most of the run.
  assert.ok(learnedRun.picks.glm >= 20, `learned should converge to glm, got ${JSON.stringify(learnedRun.picks)}`);
  // ... while still having explored the cheap model at least once.
  assert.ok(learnedRun.picks.deepseek >= 1, "Thompson sampling should explore the cheap model");
});

test("router cost accounting stays honest across models (price × usage)", () => {
  const glm: ModelRef = DEFAULT_CONFIG.workers.glm;
  assert.ok(Math.abs(estimateCost(glm, 10_000, 800) - (10_000 * 1.4 + 800 * 4.4) / 1e6) < 1e-12);
});
