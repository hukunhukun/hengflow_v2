import assert from "node:assert/strict";
import test from "node:test";
import { buildTaskContext, chooseContextPolicy } from "../context-policy.js";
import { emptyUsage } from "../cost.js";
import { DEFAULT_CONFIG } from "../config.js";
import type { DelegatedTask, RouteDecision, WorkerResult } from "../types.js";
import type { ParentContextSnapshot } from "../worker.js";

const parent: ParentContextSnapshot = {
  messages: [
    { role: "user", content: "旧请求", timestamp: 1 } as any,
    { role: "assistant", content: [{ type: "text", text: "旧回答" }], timestamp: 2 } as any,
    { role: "user", content: "当前原始用户输入", timestamp: 3 } as any,
  ],
  estimatedTokens: 100,
  sessionSummary: "Pi compaction summary",
};
const task: DelegatedTask = {
  id: "child", objective: "分析依赖结果", kind: "research", risk: "low", complexity: 0.5,
  estimatedInputTokens: 1000, estimatedOutputTokens: 300, dependsOn: ["dep"],
};
const route: RouteDecision = {
  taskId: "dep", selected: DEFAULT_CONFIG.workers.deepseek, score: 0,
  predictedCostUsd: 0.001, predictedFailureProbability: 0.1, explanation: [],
};
const dep: WorkerResult = {
  task: { ...task, id: "dep", dependsOn: [] }, route, output: "直接依赖证据", exitCode: 0,
  durationMs: 1, usage: emptyUsage(), retried: false,
};

test("Harness chooses summary policy for a DAG child when Pi has compaction", () => {
  assert.equal(chooseContextPolicy(task, parent), "session_summary");
  const context = buildTaskContext(task, parent, new Map([["dep", dep]]));
  const text = JSON.stringify(context.messages);
  assert.match(text, /Pi compaction summary/);
  assert.match(text, /当前原始用户输入/);
  assert.match(text, /直接依赖证据/);
  assert.doesNotMatch(text, /旧请求/);
});

test("latest_turn excludes unrelated history and dependency output", () => {
  const context = buildTaskContext({ ...task, dependsOn: [], contextPolicy: "latest_turn" }, parent, new Map([["dep", dep]]));
  const text = JSON.stringify(context.messages);
  assert.match(text, /当前原始用户输入/);
  assert.doesNotMatch(text, /旧请求|直接依赖证据|compaction/);
});

test("full_fork preserves the effective parent transcript", () => {
  const context = buildTaskContext({ ...task, contextPolicy: "full_fork" }, parent, new Map());
  assert.equal(context.messages.length, parent.messages.length);
  assert.match(JSON.stringify(context.messages), /旧请求/);
});
