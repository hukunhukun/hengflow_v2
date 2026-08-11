import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG } from "../config.js";
import { renderCostPanel, renderDashboard, renderHengFlowFooter, renderLiveExecutionPanel } from "../dashboard.js";
import type { HengFlowFooterSnapshot } from "../dashboard.js";
import { UsageLedger } from "../ledger.js";
import type { WorkerProgress } from "../types.js";
import { displayWidth } from "../ui-layout.js";

test("renders a compact branded per-task cost panel", () => {
  const panel = renderCostPanel({
    rows: [{
      role: "manager", provider: "openai-codex", model: "gpt-5.6-sol", calls: 2,
      inputTokens: 1200, outputTokens: 300, reportedCostUsd: 0.02, shadowCostUsd: 0.02,
    }],
    calls: 2, inputTokens: 1200, outputTokens: 300, reportedCostUsd: 0.02, shadowCostUsd: 0.02,
  });
  assert.match(panel.join("\n"), /HENGFLOW · TASK USAGE/);
  assert.match(panel.join("\n"), /gpt-5\.6-sol/);
  assert.match(panel.join("\n"), /tracked \$0\.02000/);
});

test("renders all Workers in one live panel and collapses settled Workers without exceeding terminal width", () => {
  const now = Date.now();
  const board = {
    id: "board", prompt: "inspect", rationale: "parallel", createdAt: now, updatedAt: now,
    items: [
      { id: "done", objective: "已完成任务", phase: "审视 HengFlow", status: "verifying" as const, route: "glm" as const, model: "glm-5.2", estimatedCostUsd: 0.1, actualCostUsd: 0.08 },
      { id: "live", objective: "实时任务", phase: "研究 OMP", status: "running" as const, route: "glm" as const, model: "glm-5.2", estimatedCostUsd: 0.1 },
    ],
  };
  const workers: WorkerProgress[] = [
    {
      taskId: "done", objective: "已完成任务", model: "glm-5.2", status: "completed", startedAt: now - 20_000,
      elapsedMs: 20_000, requests: 2, toolCalls: 4, inputTokens: 9000, outputTokens: 1200,
      streamingText: "这段完成输出不应继续展开。",
    },
    {
      taskId: "live", objective: "实时任务", model: "glm-5.2", status: "running", startedAt: now - 12_000,
      elapsedMs: 12_000, requests: 3, toolCalls: 5, inputTokens: 10_000, outputTokens: 1500,
      currentTool: "read", lastEvent: "正在执行 read", streamingText: "已发现 get_subagents。\n| **`src/extension.ts`** (941) ⭐核心 |\n正在继续检查实时事件。",
    },
  ];
  const panel = renderLiveExecutionPanel(board, workers, 100).join("\n");
  assert.match(panel, /HENGFLOW · ◉ EXECUTING/);
  assert.match(panel, /✓ 01 · 审视 HengFlow · glm-5\.2/);
  assert.match(panel, /◉ 02 · 研究 OMP · glm-5\.2/);
  assert.match(panel, /3 req · 5 tools · 12k tok/);
  assert.match(panel, /已发现 get_subagents/);
  assert.match(panel, /正在继续检查实时事件/);
  assert.doesNotMatch(panel, /这段完成输出不应继续展开/);

  const ansiPalette = {
    accent: (text: string) => `\x1b[36m${text}\x1b[0m`,
    success: (text: string) => `\x1b[32m${text}\x1b[0m`,
    warning: (text: string) => `\x1b[33m${text}\x1b[0m`,
    error: (text: string) => `\x1b[31m${text}\x1b[0m`,
    muted: (text: string) => `\x1b[2m${text}\x1b[0m`,
    bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
  };
  assert.equal(displayWidth("⭐"), 2, "width must match Pi TUI for ambiguous-width symbols");
  for (const width of [48, 80, 100, 120, 136, 155]) {
    const lines = renderLiveExecutionPanel(board, workers, width, ansiPalette);
    assert.ok(lines.every((line) => displayWidth(line) <= width), `live panel overflowed at ${width} columns`);
  }
});

test("renders persistent task usage in a Pi-style footer", () => {
  const snapshot: HengFlowFooterSnapshot = {
    cwd: "~/Documents/code/table_analysis",
    branch: "main",
    breakdown: {
      rows: [
        { role: "manager", provider: "openai-codex", model: "gpt-5.6-sol", calls: 2, inputTokens: 5000, outputTokens: 400, reportedCostUsd: 0, shadowCostUsd: 0.03 },
        { role: "worker", provider: "deepseek", model: "deepseek-v4-flash", calls: 1, inputTokens: 3000, outputTokens: 500, reportedCostUsd: 0.001, shadowCostUsd: 0.001 },
        { role: "worker", provider: "zai-coding-cn", model: "glm-5.2", calls: 2, inputTokens: 4000, outputTokens: 600, reportedCostUsd: 0, shadowCostUsd: 0.006 },
      ],
      calls: 5, inputTokens: 12000, outputTokens: 1500, reportedCostUsd: 0.001, shadowCostUsd: 0.037,
    },
    contextPercent: 2.4,
    contextWindow: 272_000,
    model: "gpt-5.6-sol",
    thinking: "medium",
    phase: "running",
    completedTasks: 1,
    totalTasks: 3,
    runningWorkers: 1,
    managerReady: true,
    workerAvailability: "DS/GLM",
    quotaReports: [
      { provider: "openai-codex", fetchedAt: Date.now(), source: "provider-private-api", limits: [
        { id: "manager-5h", label: "5h", used: 37, remaining: 63, limit: 100, unit: "percent" },
      ] },
      { provider: "deepseek", fetchedAt: Date.now(), source: "official-api", limits: [{ id: "ds", label: "Balance USD", remaining: 12.5, unit: "money", currency: "USD" }] },
      { provider: "zai-coding-cn", fetchedAt: Date.now(), source: "provider-private-api", limits: [
        { id: "5h", label: "5h Token", remaining: 94, limit: 100, unit: "tokens" },
        { id: "1w", label: "1w Token", remaining: 89, limit: 100, unit: "tokens" },
        { id: "1mo", label: "1mo Request", remaining: 990, limit: 1000, unit: "requests" },
      ] },
    ],
  };
  const wideLines = renderHengFlowFooter(snapshot, 120);
  const footer = wideLines.join("\n");
  assert.equal(wideLines.length, 9);
  assert.match(footer, /~\/Documents\/code\/table_analysis \(main\)/);
  assert.match(footer, /Task \$0\.031 · M \$0\.030 · DS×1 \$0\.001 · GLM×2 \(plan\)/);
  assert.match(footer, /Manager · Session ×2 ↑5\.0k ↓400 \$0\.030/);
  assert.match(footer, /Quota · 5h .*Used 37% · Left 63%/);
  assert.match(footer, /DS · Session ×1 ↑3\.0k ↓500 \$0\.001 · Balance USD Balance \$12\.5/);
  assert.match(footer, /GLM Coding Plan · Session ×2 ↑4\.0k ↓600/);
  assert.doesNotMatch(footer, /GLM Coding Plan[^\n]*\$/);
  assert.match(footer, /Quota · 5h Token .*Used 6\/100 · Left 94\/100/);
  assert.match(footer, /Quota · 1w Token .*Used 11\/100 · Left 89\/100/);
  assert.doesNotMatch(footer, /Quota · 1mo Request/);
  assert.equal(wideLines.filter((line) => /Quota · (?:5h|1w) Token/.test(line)).length, 2);
  assert.doesNotMatch(footer, /save|all-GLM/);
  assert.match(footer, /2\.4%\/272k \(auto\)/);
  assert.match(footer, /gpt-5\.6-sol • medium/);
  assert.match(footer, /HF manager: sol · medium · ◉ 1\/3 · 1 worker running · workers DS\/GLM/);
  assert.ok(wideLines.every((line) => displayWidth(line) <= 120));
  const narrow = renderHengFlowFooter(snapshot, 48);
  assert.equal(narrow.length, 3);
  assert.ok(narrow.every((line) => displayWidth(line) <= 48));
});

test("renders the redesigned control-center dashboard", () => {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-dashboard-"));
  const ledger = new UsageLedger(join(dir, "usage.sqlite"));
  try {
    const panel = renderDashboard(ledger, DEFAULT_CONFIG).join("\n");
    assert.match(panel, /HENGFLOW · CONTROL CENTER/);
    assert.match(panel, /MODEL ECONOMICS/);
    assert.match(panel, /ROUTING HEALTH/);
    assert.match(panel, /LEARNING/);
  } finally {
    ledger.close();
  }
});
