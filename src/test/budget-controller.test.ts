import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BudgetController } from "../budget-controller.js";
import { DEFAULT_CONFIG, type HengFlowConfig } from "../config.js";
import { emptyUsage } from "../cost.js";
import { UsageLedger } from "../ledger.js";
import { routePlannedTask, routeTask } from "../router.js";
import type { DelegatedTask, RouteDecision, WorkerResult } from "../types.js";

function tempLedger(): UsageLedger {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-budget-"));
  return new UsageLedger(join(dir, "usage.sqlite"));
}

function spend(ledger: UsageLedger, provider: string, usd: number): void {
  ledger.recordManagerCall(provider, "test-model", emptyUsage(), usd, "stop", 0);
}

function seedWindow(
  controller: BudgetController,
  scope: string,
  at: { windowStartAgoMs: number; resetAheadMs: number; lastAdvancedAgoMs: number; lastSpentUsd: number; debtUsd?: number },
): void {
  const now = Date.now();
  const state = controller.window(scope, now);
  // Re-seed controlled pacing state directly so tests do not depend on wall-clock sleeps.
  controller.ledger.upsertBudgetWindow({
    ...state,
    windowStart: now - at.windowStartAgoMs,
    resetAt: now + at.resetAheadMs,
    debtUsd: at.debtUsd ?? 0,
    lastAdvancedAt: now - at.lastAdvancedAgoMs,
    lastSpentUsd: at.lastSpentUsd,
  });
}

test("lambda stays 1 without configured limits", () => {
  const ledger = tempLedger();
  const controller = new BudgetController(ledger, DEFAULT_CONFIG);
  controller.registerSession(0);
  spend(ledger, "deepseek", 5);
  controller.advanceTracked();
  assert.equal(controller.multiplierForModel(DEFAULT_CONFIG.workers.glm), 1);
  ledger.close();
});

test("over-pace spending accrues debt and raises the shadow price", () => {
  const ledger = tempLedger();
  const controller = new BudgetController(ledger, DEFAULT_CONFIG);
  controller.registerSession(1);
  spend(ledger, "zai-coding-cn", 0.9);
  seedWindow(controller, "session", { windowStartAgoMs: 60_000, resetAheadMs: 6 * 3600_000, lastAdvancedAgoMs: 60_000, lastSpentUsd: 0 });
  const state = controller.advance("session");
  assert.ok(state.debtUsd > 0.8, `debt should accrue, got ${state.debtUsd}`);
  assert.ok(state.lambdaMultiplier > 2.9, `lambda should reach cap, got ${state.lambdaMultiplier}`);
  ledger.close();
});

test("on-pace spending keeps debt and lambda at neutral", () => {
  const ledger = tempLedger();
  const controller = new BudgetController(ledger, DEFAULT_CONFIG);
  controller.registerSession(0.6);
  spend(ledger, "zai-coding-cn", 0.5);
  seedWindow(controller, "session", { windowStartAgoMs: 5 * 3600_000, resetAheadMs: 3600_000, lastAdvancedAgoMs: 5 * 3600_000, lastSpentUsd: 0 });
  const state = controller.advance("session");
  assert.ok(state.debtUsd < 1e-6, `on-pace debt should stay zero, got ${state.debtUsd}`);
  assert.ok(Math.abs(state.lambdaMultiplier - 1) < 1e-9, `on-pace lambda should stay neutral, got ${state.lambdaMultiplier}`);
  ledger.close();
});

test("hard feasibility blocks spend beyond the remaining window", () => {
  const ledger = tempLedger();
  const config: HengFlowConfig = structuredClone(DEFAULT_CONFIG);
  const controller = new BudgetController(ledger, config);
  controller.registerSession(1);
  spend(ledger, "zai-coding-cn", 0.9);
  const blocked = controller.checkFeasibility(0.2, ["session"]);
  assert.equal(blocked.feasible, false);
  assert.match(blocked.reason ?? "", /session 预算不可行/);
  const fits = controller.checkFeasibility(0.05, ["session"]);
  assert.equal(fits.feasible, true);
  config.budget.hardFeasibility = false;
  assert.equal(controller.checkFeasibility(0.2, ["session"]).feasible, true);
  ledger.close();
});

test("debt and lambda persist across ledger reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-budget-"));
  const path = join(dir, "usage.sqlite");
  const ledger = new UsageLedger(path);
  const controller = new BudgetController(ledger, DEFAULT_CONFIG);
  controller.registerSession(1);
  spend(ledger, "zai-coding-cn", 0.9);
  seedWindow(controller, "session", { windowStartAgoMs: 60_000, resetAheadMs: 6 * 3600_000, lastAdvancedAgoMs: 60_000, lastSpentUsd: 0 });
  const before = controller.advance("session");
  ledger.close();

  const reopened = new UsageLedger(path);
  const controller2 = new BudgetController(reopened, DEFAULT_CONFIG);
  controller2.registerSession(1);
  const after = controller2.advance("session");
  // Debt may decay by rho*dt between the two advances (correct pacing math);
  // what must persist is the accumulated state, not bit-identical values.
  assert.ok(after.debtUsd >= before.debtUsd - 1e-6);
  assert.ok(after.lambdaMultiplier > 2.9);
  reopened.close();
});

test("window rollover resets debt after reset_at", () => {
  const ledger = tempLedger();
  const controller = new BudgetController(ledger, DEFAULT_CONFIG);
  controller.registerProvider("zai-coding-cn", 1);
  const now = Date.now();
  ledger.upsertBudgetWindow({
    scope: "provider:zai-coding-cn", limitUsd: 1,
    windowStart: now - 25 * 3600_000, resetAt: now - 1000,
    debtUsd: 0.9, lambdaMultiplier: 3, lastAdvancedAt: now - 1000, lastSpentUsd: 0.9,
  });
  const rolled = controller.advance("provider:zai-coding-cn");
  assert.equal(rolled.debtUsd, 0);
  assert.equal(rolled.lambdaMultiplier, 1);
  ledger.close();
});

test("session and provider lambdas multiply for a model", () => {
  const ledger = tempLedger();
  const controller = new BudgetController(ledger, DEFAULT_CONFIG);
  controller.registerSession(1);
  controller.registerProvider("zai-coding-cn", 1);
  spend(ledger, "zai-coding-cn", 0.95);
  seedWindow(controller, "session", { windowStartAgoMs: 60_000, resetAheadMs: 6 * 3600_000, lastAdvancedAgoMs: 60_000, lastSpentUsd: 0 });
  seedWindow(controller, "provider:zai-coding-cn", { windowStartAgoMs: 60_000, resetAheadMs: 24 * 3600_000, lastAdvancedAgoMs: 60_000, lastSpentUsd: 0.9, debtUsd: 0.02 });
  const sessionLambda = controller.advance("session").lambdaMultiplier;
  const providerLambda = controller.advance("provider:zai-coding-cn").lambdaMultiplier;
  const combined = controller.multiplierForModel(DEFAULT_CONFIG.workers.glm);
  assert.ok(sessionLambda > 1.5, `session lambda expected >1.5, got ${sessionLambda}`);
  assert.ok(providerLambda > 1, `provider lambda expected >1, got ${providerLambda}`);
  assert.ok(combined >= sessionLambda * providerLambda - 0.05, `combined ${combined} should multiply ${sessionLambda} x ${providerLambda}`);
  const deepseekOnly = controller.multiplierForModel(DEFAULT_CONFIG.workers.deepseek);
  assert.ok(deepseekOnly < combined, "model without provider window should see a lower multiplier");
  ledger.close();
});

test("calibration joins route_decisions with realized outcomes", () => {
  const ledger = tempLedger();
  const task: DelegatedTask = {
    id: "cal-1", objective: "calibrate", kind: "research", risk: "low", complexity: 0.5,
    estimatedInputTokens: 10_000, estimatedOutputTokens: 1_000,
  };
  const decision: RouteDecision = {
    taskId: "cal-1", selected: DEFAULT_CONFIG.workers.glm, score: 1,
    predictedCostUsd: 0.01, predictedFailureProbability: 0.5, explanation: [],
  };
  ledger.recordDecision(decision, "launch");
  const phase = ledger.db.prepare("SELECT phase FROM route_decisions ORDER BY id DESC LIMIT 1").get() as { phase: string };
  assert.equal(phase.phase, "launch");
  const result: WorkerResult = {
    task, route: decision, output: "ok", exitCode: 0, durationMs: 1000,
    // glm: 10k input * 1.4/M + 1k output * 4.4/M = 0.0184 shadow cost
    usage: { ...emptyUsage(), input: 10_000, output: 1_000, totalTokens: 11_000 },
    stopReason: "stop", retried: false, attempts: [],
  };
  ledger.recordWorkerCall(result, 0.02);
  ledger.recordOutcome("del-1", result, { taskId: "cal-1", status: "accepted", quality: 0.9, confidence: 0.9 }, DEFAULT_CONFIG.workers.glm);
  const report = ledger.getCalibration();
  assert.equal(report.pairs, 1);
  assert.ok(Math.abs(report.brierFailure - 0.25) < 1e-9, `brier expected 0.25, got ${report.brierFailure}`);
  assert.ok(Math.abs(report.costBiasRatio - 1.84) < 1e-6, `cost bias expected 1.84, got ${report.costBiasRatio}`);
  assert.equal(report.byModel[0].model, DEFAULT_CONFIG.workers.glm.model);
  ledger.close();
});

