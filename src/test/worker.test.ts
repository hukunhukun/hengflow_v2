import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import type { DelegatedTask, RouteDecision } from "../types.js";
import {
  buildWorkerPrompt,
  createForkedSessionManager,
  runWorker,
  snapshotParentContext,
  withInheritedContextCost,
  type WorkerSessionFactory,
  type WorkerSessionOptions,
} from "../worker.js";

function userMessage(text: string, timestamp: number) {
  return { role: "user", content: text, timestamp };
}

function assistantMessage(content: unknown[], timestamp: number) {
  return {
    role: "assistant",
    content,
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp,
  };
}

test("fork snapshot preserves canonical request and evidence but trims the active execution call", () => {
  const entries = [
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-10T00:00:00Z", message: userMessage("分析订单取消率，不要修改文件", 1) },
    {
      type: "message", id: "a1", parentId: "u1", timestamp: "2026-08-10T00:00:01Z",
      message: assistantMessage([{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "metrics.sql" } }], 2),
    },
    {
      type: "message", id: "r1", parentId: "a1", timestamp: "2026-08-10T00:00:02Z",
      message: {
        role: "toolResult", toolCallId: "read-1", toolName: "read",
        content: [{ type: "text", text: "cancel_rate = cancels / calls" }], isError: false, timestamp: 3,
      },
    },
    {
      type: "message", id: "a2", parentId: "r1", timestamp: "2026-08-10T00:00:03Z",
      message: assistantMessage([{ type: "toolCall", id: "execute-1", name: "execute_plan", arguments: { mode: "direct_worker" } }], 4),
    },
  ] as any;

  const snapshot = snapshotParentContext(entries, "a2", "/tmp/manager.jsonl");
  assert.equal(snapshot.messages.length, 3);
  assert.equal(snapshot.messages[0].role, "user");
  assert.match(JSON.stringify(snapshot.messages), /订单取消率/);
  assert.match(JSON.stringify(snapshot.messages), /cancel_rate/);
  assert.doesNotMatch(JSON.stringify(snapshot.messages), /execute_plan/);
  assert.ok(snapshot.estimatedTokens > 0);

  const fork = createForkedSessionManager(snapshot, "/tmp");
  const forked = fork.buildSessionContext();
  assert.match(JSON.stringify(forked.messages), /订单取消率/);
  assert.match(JSON.stringify(forked.messages), /cancel_rate/);
});

test("inherited transcript tokens replace stale planning estimates", () => {
  const task: DelegatedTask = {
    id: "analyze", objective: "分析指标", kind: "research", risk: "low", complexity: 0.5,
    estimatedInputTokens: 500, estimatedOutputTokens: 300,
  };
  const effective = withInheritedContextCost(task, { messages: [], estimatedTokens: 12_000 });
  assert.equal(effective.estimatedInputTokens, 12_250);
  assert.equal(task.estimatedInputTokens, 500);
});

test("SDK Worker receives the fork and exposes only read-only tools", async () => {
  const task: DelegatedTask = {
    id: "inspect", objective: "解释指标定义", kind: "research", risk: "low", complexity: 0.4,
    estimatedInputTokens: 3000, estimatedOutputTokens: 500,
  };
  const route: RouteDecision = {
    taskId: task.id,
    selected: DEFAULT_CONFIG.workers.deepseek,
    score: 0,
    predictedCostUsd: 0.001,
    predictedFailureProbability: 0.1,
    explanation: ["test"],
  };
  const parent = snapshotParentContext([
    { type: "message", id: "u1", parentId: null, timestamp: "2026-08-10T00:00:00Z", message: userMessage("原始用户约束", 1) },
  ] as any, "u1");
  let received: WorkerSessionOptions | undefined;
  let disposed = false;
  const progress: any[] = [];
  const factory: WorkerSessionFactory = async (options) => {
    received = options;
    let listener: ((event: any) => void) | undefined;
    return {
      sessionId: "child-session",
      subscribe(callback) {
        listener = callback;
        return () => { listener = undefined; };
      },
      async prompt(prompt) {
        assert.match(prompt, /解释指标定义/);
        listener?.({ type: "tool_execution_start", toolCallId: "r", toolName: "read", args: {} });
        listener?.({
          type: "message_update",
          message: {
            ...assistantMessage([{ type: "text", text: "正在基于父会话分析" }], 2),
            provider: "deepseek", model: "deepseek-v4-flash", stopReason: "stop",
          },
          assistantMessageEvent: { type: "text_delta", delta: "分析" },
        });
        listener?.({ type: "tool_execution_update", toolCallId: "r", toolName: "read", args: {}, partialResult: "正在读取指标定义" });
        listener?.({ type: "tool_execution_end", toolCallId: "r", toolName: "read", args: {}, result: "指标定义读取完成", isError: false });
        listener?.({
          type: "message_end",
          message: {
            ...assistantMessage([{ type: "text", text: "已基于父会话完成分析" }], 2),
            provider: "deepseek", model: "deepseek-v4-flash", stopReason: "stop",
          },
        });
      },
      async abort() {},
      dispose() { disposed = true; },
    };
  };

  const result = await runWorker(task, route, "/tmp", DEFAULT_CONFIG, parent, undefined, (item) => progress.push(item), factory);
  assert.equal(result.exitCode, 0);
  assert.equal(result.childSessionId, "child-session");
  assert.match(result.output, /父会话完成分析/);
  assert.match(JSON.stringify(received?.context.messages), /原始用户约束/);
  assert.deepEqual(received?.tools, ["read", "grep", "find", "ls"]);
  assert.equal(disposed, true);
  assert.doesNotMatch(buildWorkerPrompt(task), /原始用户约束/);
  assert.ok(progress.some((item) => /正在基于父会话分析/.test(item.streamingText ?? "")));
  assert.match(progress.at(-1)?.streamingText ?? "", /父会话完成分析/);
  assert.match(progress.at(-1)?.outputPreview ?? "", /父会话完成分析/);
});
