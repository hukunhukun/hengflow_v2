import assert from "node:assert/strict";
import test from "node:test";
import { completeVerifiedWorkerTasks, renderTaskBoard, requiresPlan, updateBoardItem } from "../task-board.js";
import type { TaskBoardPalette } from "../task-board.js";
import { displayWidth, stripAnsi } from "../ui-layout.js";
import type { TaskBoard } from "../types.js";

test("keeps simple conversational questions on the direct fast path", () => {
  assert.equal(requiresPlan("李雅普诺夫优化是什么？"), false);
  assert.equal(requiresPlan("What is Lyapunov optimization?"), false);
});

test("requires a plan for actionable and multi-item prompts", () => {
  assert.equal(requiresPlan("请开始修改代码并运行测试"), true);
  assert.equal(requiresPlan("1. inspect router\n2. implement the fix"), true);
});

test("renders routed task progress and actual worker cost", () => {
  let board: TaskBoard = {
    id: "board-1",
    prompt: "test",
    rationale: "test",
    createdAt: 1,
    updatedAt: 1,
    items: [{
      id: "inspect",
      objective: "检查路由实现",
      phase: "Analysis",
      status: "running",
      route: "deepseek",
      model: "deepseek-v4-flash",
      estimatedCostUsd: 0.002,
    }],
  };
  board = updateBoardItem(board, "inspect", "verifying", { actualCostUsd: 0.0015 });
  const text = renderTaskBoard(board).join("\n");
  assert.match(text, /HENGFLOW.*EXECUTING.*0\/1/);
  assert.match(text, /v4-flash/);
  assert.match(text, /\$0\.0015/);
  assert.match(text, /◇/);
});

test("renders a responsive themed task card without overflowing CJK terminal widths", () => {
  const board: TaskBoard = {
    id: "responsive", prompt: "p", rationale: "r", createdAt: 1, updatedAt: 1,
    items: [
      {
        id: "one", objective: "将字符串 HengFlow 反转，并用一句很长的中文给出最终结果",
        phase: "本地实现调研", status: "completed", route: "manager", model: "gpt-5.6-sol",
        estimatedCostUsd: 0.0233, note: "委派预计改善 -31.8%，低于 15% 门槛",
      },
      {
        id: "two", objective: "检查超长说明不会破坏右侧边框", phase: "验收",
        status: "verifying", route: "glm", model: "glm-5.2", estimatedCostUsd: 0.02,
        actualCostUsd: 0.018, note: "等待 Manager 阶段验收",
      },
    ],
  };
  const color = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
  const palette: TaskBoardPalette = {
    accent: color(36), success: color(32), warning: color(33), error: color(31),
    muted: color(90), dim: color(2), text: color(37), border: color(90), bold: color(1),
  };
  for (const width of [48, 80, 120]) {
    const lines = renderTaskBoard(board, { width, palette, mode: "summary" });
    assert.ok(lines.every((line) => displayWidth(line) <= width));
    assert.match(stripAnsi(lines.join("\n")), /本地执行 · ROI -31\.8% · 门槛 15%/);
  }
  assert.match(renderTaskBoard(board, { width: 80, palette }).join("\n"), /\x1b\[/);
});

test("uses a compact live board and a richer final summary", () => {
  const board: TaskBoard = {
    id: "modes", prompt: "p", rationale: "r", createdAt: 1, updatedAt: 1,
    items: [{
      id: "one", objective: "执行任务", phase: "实现", status: "running", route: "manager",
      model: "gpt-5.6-sol", estimatedCostUsd: 0.01, note: "详细路由说明",
    }],
  };
  assert.doesNotMatch(renderTaskBoard(board, { mode: "live" }).join("\n"), /详细路由说明/);
  assert.match(renderTaskBoard(board, { mode: "summary" }).join("\n"), /详细路由说明/);
});

test("closes successful Worker verification at a stage boundary", () => {
  const board: TaskBoard = {
    id: "b", prompt: "p", rationale: "r", createdAt: 1, updatedAt: 1,
    items: [{
      id: "w", objective: "inspect", phase: "Parallel", status: "verifying",
      route: "glm", model: "glm-5.2", estimatedCostUsd: 0.02, note: "等待 Manager 阶段验收",
    }],
  };
  const completed = completeVerifiedWorkerTasks(board);
  assert.equal(completed.items[0].status, "completed");
  assert.equal(completed.items[0].note, "阶段综合完成");
});
