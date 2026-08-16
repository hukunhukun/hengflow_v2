import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BudgetController } from "../budget-controller.js";
import { DEFAULT_CONFIG, type HengFlowConfig } from "../config.js";
import { emptyUsage, estimateCost } from "../cost.js";
import { UsageLedger } from "../ledger.js";
import { routeTask } from "../router.js";
import type { DelegatedTask, ModelRef } from "../types.js";

/**
 * Offline replay harness (P3): replays a synthetic workload trace through the
 * router twice — once with the legacy fixed-cost-weight scorer (no budget
 * state) and once with the lambda BudgetController enforcing a tight provider
 * window — then compares selections and total spend. This is the minimal
 * evidence base for any further routing change.
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

function executeSpend(ledger: UsageLedger, model: ModelRef, usd: number): void {
  ledger.recordManagerCall(model.provider, model.model, emptyUsage(), usd, "stop", 0);
}

test("lambda pacing shifts a homogeneous workload off the expensive model before the hard wall", () => {
  const config: HengFlowConfig = structuredClone(DEFAULT_CONFIG);
  const glm = config.workers.glm;
  const deepseek = config.workers.deepseek;
  const tasks = Array.from({ length: 20 }, (_unused, index) => researchTask(index));
  const glmCost = estimateCost(glm, 10_000, 800);

  // Baseline: static weights, no budget state → the expensive model wins every time.
  const staticLedger = tempLedger();
  const staticPicks = { glm: 0, deepseek: 0 };
  for (const task of tasks) {
    const route = routeTask(task, config, staticLedger, new Set(["deepseek", "glm"]));
    staticPicks[route.selected.id === "glm" ? "glm" : "deepseek"] += 1;
    executeSpend(staticLedger, route.selected, route.selected.id === "glm" ? glmCost : estimateCost(deepseek, 10_000, 800));
  }
  assert.equal(staticPicks.glm, 20);
  const staticSpend = staticLedger.getSpendSince(0, glm.provider);
  staticLedger.close();

  // Paced run: tight provider window on the expensive model, with a kappa
  // strong enough that the shadow price can flip the (quality-dominated)
  // decision before the hard wall is reached.
  config.budget.providerLimitsUsd = { [glm.provider]: 0.05 };
  config.budget.lambdaKappa = 10;
  const pacedLedger = tempLedger();
  const budget = new BudgetController(pacedLedger, config);
  budget.registerSession(0);
  budget.registerProvider(glm.provider, 0.05);
  const pacedPicks = { glm: 0, deepseek: 0, blocked: 0 };
  let softShifts = 0;
  for (const task of tasks) {
    pacedLedger.recordDecision(
      { taskId: task.id, selected: glm, score: 0, predictedCostUsd: glmCost, predictedFailureProbability: 0.1, explanation: [] },
      "launch",
    );
    const route = routeTask(task, config, pacedLedger, new Set(["deepseek", "glm"]), undefined, budget);
    const cost = route.selected.id === "glm" ? glmCost : estimateCost(deepseek, 10_000, 800);
    if (route.selected.id === "deepseek" && budget.multiplierForModel(glm) > 1.01) softShifts += 1;
    const feasibility = budget.checkFeasibility(cost, budget.scopesFor(route.selected));
    if (!feasibility.feasible) {
      pacedPicks.blocked += 1;
      continue;
    }
    pacedPicks[route.selected.id === "glm" ? "glm" : "deepseek"] += 1;
    executeSpend(pacedLedger, route.selected, cost);
  }
  const pacedSpend = pacedLedger.getSpendSince(0, glm.provider);
  pacedLedger.close();

  assert.ok(pacedPicks.glm < 20, `paced run should divert from glm, got ${pacedPicks.glm} glm picks`);
  assert.ok(pacedPicks.glm >= 1, "paced run should still use glm while budget allows");
  assert.ok(pacedPicks.deepseek >= 15, `cheap model should absorb the workload, got ${pacedPicks.deepseek}`);
  assert.equal(pacedPicks.blocked, 0, "diversion should happen before the hard wall");
  assert.ok(pacedSpend <= 0.05 + 1e-9, `provider spend must respect the window, spent ${pacedSpend}`);
  assert.ok(pacedSpend < staticSpend, `paced spend ${pacedSpend} should undercut static ${staticSpend}`);
  assert.ok(softShifts >= 1, `shadow price should flip decisions before hard infeasibility, got ${softShifts}`);
});
