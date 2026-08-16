import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { emptyUsage } from "../cost.js";
import { UsageLedger } from "../ledger.js";
import { evaluateSplit, routePlannedTask, routeTask } from "../router.js";
import type { DelegatedTask, ModelRef, RouteDecision, WorkerResult } from "../types.js";

function ledger(): UsageLedger {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-test-"));
  return new UsageLedger(join(dir, "usage.sqlite"));
}

test("rejects a single trivial delegation", () => {
  const decision = evaluateSplit({
    rationale: "test",
    directEstimatedInputTokens: 100,
    directEstimatedOutputTokens: 100,
    tasks: [{
      id: "t1", objective: "answer hello", kind: "simple", risk: "low", complexity: 0.1,
      estimatedInputTokens: 100, estimatedOutputTokens: 50,
    }],
  }, DEFAULT_CONFIG);
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join(" "), /编排开销/);
});

test("rejects high-risk delegated work", () => {
  const decision = evaluateSplit({
    rationale: "test",
    directEstimatedInputTokens: 40_000,
    directEstimatedOutputTokens: 8_000,
    tasks: [{
      id: "t1", objective: "deploy", kind: "coding", risk: "high", complexity: 0.8,
      estimatedInputTokens: 10_000, estimatedOutputTokens: 2_000,
    }],
  }, DEFAULT_CONFIG);
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join(" "), /高风险/);
});

test("rejects writes through the legacy delegation path", () => {
  const decision = evaluateSplit({
    rationale: "test",
    directEstimatedInputTokens: 40_000,
    directEstimatedOutputTokens: 8_000,
    tasks: [{
      id: "t1", objective: "edit files", kind: "coding", risk: "low", complexity: 0.8,
      estimatedInputTokens: 10_000, estimatedOutputTokens: 2_000, requiresWrite: true,
    }],
  }, DEFAULT_CONFIG);
  assert.equal(decision.accepted, false);
  assert.match(decision.reasons.join(" "), /写入/);
});

test("routes bounded simple work to DeepSeek", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "simple", objective: "extract facts", kind: "simple", risk: "low", complexity: 0.2,
    estimatedInputTokens: 3000, estimatedOutputTokens: 600,
  };
  const route = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  assert.equal(route.selected.id, "deepseek");
  store.close();
});

test("routes complex coding work to GLM", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "code", objective: "analyze repository architecture", kind: "coding", risk: "low", complexity: 0.82,
    estimatedInputTokens: 80_000, estimatedOutputTokens: 8_000,
  };
  const route = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  assert.equal(route.selected.id, "glm");
  store.close();
});

test("falls back to the only authenticated worker", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "code", objective: "analyze repository architecture", kind: "coding", risk: "low", complexity: 0.82,
    estimatedInputTokens: 80_000, estimatedOutputTokens: 8_000,
  };
  const route = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek"]));
  assert.equal(route.selected.id, "deepseek");
  assert.equal(route.fallback, undefined);
  store.close();
});

test("routes an economical read-only planned item to a Worker", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "inspect", objective: "inspect routing implementation", kind: "simple", risk: "low", complexity: 0.2,
    estimatedInputTokens: 3000, estimatedOutputTokens: 600,
  };
  const decision = routePlannedTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  assert.equal(decision.route, "deepseek");
  assert.ok(decision.predictedCostUsd < decision.directCostUsd);
  store.close();
});

test("passthrough removes Manager verification but includes expected rework", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "direct-worker", objective: "extract bounded facts", kind: "simple", risk: "low", complexity: 0.15,
    estimatedInputTokens: 12_000, estimatedOutputTokens: 1_000,
  };
  const passthrough = routePlannedTask(
    task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]),
    { returnPolicy: "passthrough", planningCostShareUsd: 0.02 },
  );
  const verified = routePlannedTask(
    task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]),
    { returnPolicy: "manager_synthesis", planningCostShareUsd: 0.02 },
  );
  assert.equal(passthrough.route, "deepseek");
  assert.ok(passthrough.expectedReworkCostUsd > 0);
  assert.equal(passthrough.orchestrationCostUsd, 0.02);
  assert.ok(verified.orchestrationCostUsd > passthrough.orchestrationCostUsd);
  assert.ok(passthrough.predictedCostUsd < verified.predictedCostUsd);
  assert.match(passthrough.explanation.join(" "), /策略=passthrough/);
  store.close();
});

test("shared planning cost is reported without changing the incremental route", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "cost-share", objective: "inspect bounded source", kind: "simple", risk: "low", complexity: 0.2,
    estimatedInputTokens: 8_000, estimatedOutputTokens: 800,
  };
  const withoutPlanning = routePlannedTask(
    task, DEFAULT_CONFIG, store, new Set(["deepseek"]), { returnPolicy: "passthrough" },
  );
  const withPlanning = routePlannedTask(
    task, DEFAULT_CONFIG, store, new Set(["deepseek"]),
    { returnPolicy: "passthrough", planningCostShareUsd: 0.08 },
  );
  assert.equal(withoutPlanning.route, withPlanning.route);
  assert.ok(Math.abs(withPlanning.predictedCostUsd - withoutPlanning.predictedCostUsd - 0.08) < 1e-9);
  assert.ok(Math.abs(withPlanning.directCostUsd - withoutPlanning.directCostUsd - 0.08) < 1e-9);
  store.close();
});

test("keeps writes and high-risk planned items on the Manager", () => {
  const store = ledger();
  const write = routePlannedTask({
    id: "edit", objective: "edit router", kind: "coding", risk: "low", complexity: 0.6,
    estimatedInputTokens: 10_000, estimatedOutputTokens: 2_000, requiresWrite: true,
  }, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  const risky = routePlannedTask({
    id: "deploy", objective: "deploy service", kind: "coding", risk: "high", complexity: 0.8,
    estimatedInputTokens: 10_000, estimatedOutputTokens: 2_000,
  }, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  assert.equal(write.route, "manager");
  assert.equal(risky.route, "manager");
  store.close();
});

test("bounded sample-deficit exploration gives under-sampled DeepSeek a finite chance", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "explore-research", objective: "research bounded facts", kind: "research", risk: "low", complexity: 0.5,
    estimatedInputTokens: 10_000, estimatedOutputTokens: 1000,
  };
  const exploit = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  const state = { spentUsd: 0, selections: 0 };
  const explored = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]), state);
  assert.equal(exploit.selected.id, "glm");
  assert.equal(explored.selected.id, "deepseek");
  assert.equal(state.selections, 1);
  assert.ok(state.spentUsd > 0 && state.spentUsd <= DEFAULT_CONFIG.routing.explorationBudgetUsd);
  assert.match(explored.explanation.join(" "), /样本缺口/);
  state.spentUsd = DEFAULT_CONFIG.routing.explorationBudgetUsd;
  assert.equal(routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]), state).selected.id, "glm");
  store.close();
});

test("routes to a dynamically discovered third-party Worker", () => {
  const store = ledger();
  const kimi: ModelRef = {
    id: "moonshot/kimi-k2", provider: "moonshot", model: "kimi-k2", thinking: "max",
    quality: 0.94, inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.05, outputUsdPerMillion: 1,
    contextWindow: 256_000, affinity: ["research", "coding", "long-context"],
  };
  const task: DelegatedTask = {
    id: "dynamic", objective: "analyze a large codebase", kind: "long-context", risk: "low", complexity: 0.8,
    estimatedInputTokens: 80_000, estimatedOutputTokens: 4_000,
  };
  const route = routeTask(task, DEFAULT_CONFIG, store, [DEFAULT_CONFIG.workers.glm, kimi]);
  assert.equal(route.selected.id, "moonshot/kimi-k2");
  store.close();
});

test("semantic outcomes gradually override the cold-start routing prior", () => {
  const store = ledger();
  const task: DelegatedTask = {
    id: "learned-simple", objective: "extract facts", kind: "simple", risk: "low", complexity: 0.2,
    estimatedInputTokens: 3000, estimatedOutputTokens: 600,
  };
  const coldRoute = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  assert.equal(coldRoute.selected.id, "deepseek");

  const deepseekRoute: RouteDecision = {
    ...coldRoute,
    selected: DEFAULT_CONFIG.workers.deepseek,
    fallback: DEFAULT_CONFIG.workers.glm,
  };
  for (let index = 0; index < 10; index++) {
    const result: WorkerResult = {
      task, route: deepseekRoute, output: "wrong", exitCode: 0, durationMs: 1000,
      usage: { ...emptyUsage(), input: 3000, output: 600, totalTokens: 3600 },
      model: DEFAULT_CONFIG.workers.deepseek.model, stopReason: "stop", retried: false,
    };
    store.recordOutcome(`delegation-${index}`, result, {
      taskId: task.id, status: "rejected", quality: 0, confidence: 1,
    }, DEFAULT_CONFIG.workers.deepseek);
  }

  const learned = store.getLearnedProfile(task, DEFAULT_CONFIG.workers.deepseek, 0.1);
  assert.equal(learned.samples, 10);
  assert.ok(learned.posteriorQuality < 0.5);
  const adaptedRoute = routeTask(task, DEFAULT_CONFIG, store, new Set(["deepseek", "glm"]));
  assert.equal(adaptedRoute.selected.id, "glm");
  assert.match(adaptedRoute.explanation.join(" "), /备选模型同类样本=10/);
  store.close();
});
