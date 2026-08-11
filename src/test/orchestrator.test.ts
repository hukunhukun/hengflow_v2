import assert from "node:assert/strict";
import test from "node:test";
import { StageOrchestrator } from "../orchestrator.js";
import type { PlannedTask, WorkerResult } from "../types.js";

function task(id: string, dependsOn?: string[]): PlannedTask {
  return { id, objective: id, kind: "simple", risk: "low", complexity: 0.2, estimatedInputTokens: 10, estimatedOutputTokens: 10, dependsOn };
}

function result(item: PlannedTask, exitCode = 0): WorkerResult {
  const model = { id: "test/model", provider: "test", model: "model", thinking: "off" as const, quality: 0.8, inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  return { task: item, route: { taskId: item.id, selected: model, score: 0, predictedCostUsd: 0, predictedFailureProbability: 0, explanation: [] }, output: item.id, exitCode, durationMs: 1, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedCostUsd: 0 }, retried: false };
}

test("orchestrator activates DAG waves in order", async () => {
  const root = task("root");
  const child = task("child", ["root"]);
  const launched: string[] = [];
  const orchestrator = new StageOrchestrator(
    [{ task: root, decision: {}, worker: true }, { task: child, decision: {}, worker: true }],
    ["root", "child"], 1, new AbortController().signal,
    { launch: async ({ task }) => { launched.push(task.id); return result(task); }, onTransition: () => {} },
  );
  orchestrator.kick();
  const results = await orchestrator.promise;
  assert.deepEqual(launched, ["root", "child"]);
  assert.deepEqual(results.map((item) => item.task.id), ["root", "child"]);
});

test("orchestrator blocks descendants after failure", async () => {
  const root = task("root");
  const child = task("child", ["root"]);
  const launched: string[] = [];
  const orchestrator = new StageOrchestrator(
    [{ task: root, decision: {}, worker: true }, { task: child, decision: {}, worker: true }],
    ["root", "child"], 2, new AbortController().signal,
    { launch: async ({ task }) => { launched.push(task.id); return result(task, 1); }, onTransition: () => {} },
  );
  orchestrator.kick();
  await orchestrator.promise;
  assert.deepEqual(launched, ["root"]);
  assert.equal(orchestrator.statuses.get("child"), "blocked");
});
