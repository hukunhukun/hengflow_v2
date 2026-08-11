import type { TaskBoard, TaskBoardItem, TaskStatus } from "./types.js";
import { alignDisplay, displayWidth, fitDisplayLines, truncateDisplay } from "./ui-layout.js";

export const TASK_BOARD_ENTRY = "hengflow-task-board";
export const TASK_SUMMARY_ENTRY = "hengflow-task-summary";
let processTaskBoard: TaskBoard | undefined;

export function setProcessTaskBoard(board: TaskBoard | undefined): void {
  processTaskBoard = board;
}

export function getProcessTaskBoard(): TaskBoard | undefined {
  return processTaskBoard;
}

const ACTION_RE = /(?:实现|修改|修复|创建|增加|新增|删除|重构|检查|分析|调研|搜索|执行|运行|测试|部署|开发|编写|帮我|请开始|implement|modify|fix|build|create|add|remove|refactor|inspect|analy[sz]e|research|search|run|test|deploy|write)/i;
const LIST_RE = /(?:^|\n)\s*(?:[-*+] |\d+[.)、])/m;

/** Cheap deterministic gate: simple conversational answers stay single-turn. */
export function requiresPlan(prompt: string): boolean {
  const text = prompt.trim();
  if (!text) return false;
  if (LIST_RE.test(text) || text.length >= 240) return true;
  return ACTION_RE.test(text);
}

export function latestTaskBoard(entries: readonly unknown[]): TaskBoard | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index] as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== TASK_BOARD_ENTRY) continue;
    const board = entry.data as TaskBoard | undefined;
    if (board && typeof board.id === "string" && Array.isArray(board.items)) return board;
  }
  return undefined;
}

export function updateBoardItem(
  board: TaskBoard,
  taskId: string,
  status: TaskStatus,
  values: Partial<Pick<TaskBoardItem, "actualCostUsd" | "estimatedCostUsd" | "note" | "route" | "model">> = {},
): TaskBoard {
  const items = board.items.map((item) => item.id === taskId ? { ...item, ...values, status } : item);
  return { ...board, updatedAt: Date.now(), items };
}

export function completeOpenManagerTasks(board: TaskBoard): TaskBoard {
  const items = board.items.map((item) =>
    item.route === "manager" && (item.status === "pending" || item.status === "running")
      ? { ...item, status: "completed" as const }
      : item,
  );
  return { ...board, updatedAt: Date.now(), items };
}

export function completeVerifiedWorkerTasks(board: TaskBoard): TaskBoard {
  const items = board.items.map((item) =>
    item.status === "verifying"
      ? { ...item, status: "completed" as const, note: item.note === "等待 Manager 阶段验收" ? "阶段综合完成" : item.note }
      : item,
  );
  return { ...board, updatedAt: Date.now(), items };
}

function shortModel(model: string): string {
  const normalized = model.replace("deepseek-", "");
  return truncateDisplay(normalized, 20);
}

function money(value: number | undefined): string {
  return value === undefined ? "" : `$${value.toFixed(4)}`;
}

const STATUS_ICON: Record<TaskStatus, string> = {
  pending: "○",
  running: "◉",
  verifying: "◇",
  completed: "✓",
  blocked: "!",
  failed: "×",
};

const STATUS_LABEL: Record<TaskStatus, string> = {
  pending: "等待",
  running: "执行中",
  verifying: "验收中",
  completed: "已完成",
  blocked: "阻塞",
  failed: "失败",
};

export interface TaskBoardPalette {
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  text(text: string): string;
  border(text: string): string;
  bold(text: string): string;
}

export interface TaskBoardRenderOptions {
  width?: number;
  palette?: TaskBoardPalette;
  mode?: "live" | "summary";
}

export function isTaskBoardSettled(board: TaskBoard): boolean {
  return board.items.every((item) => item.status === "completed" || item.status === "blocked" || item.status === "failed");
}

function compactNote(note: string): string {
  const roi = note.match(/委派预计改善\s*([^，,]+)[，,]\s*低于\s*([^ ]+)\s*门槛/);
  if (roi) return `本地执行 · ROI ${roi[1]} · 门槛 ${roi[2]}`;
  return note.replace("等待 Manager 阶段验收", "等待 Manager 验收");
}

function routeLabel(item: TaskBoardItem): string {
  if (item.route === "manager") return "MANAGER";
  const route = item.route.includes("/") ? item.route.split("/").at(-1)! : item.route;
  return truncateDisplay(route.toUpperCase(), 16);
}

export function renderTaskBoard(board: TaskBoard, options: TaskBoardRenderOptions = {}): string[] {
  const requestedWidth = Math.max(1, options.width ?? 96);
  if (requestedWidth < 20) {
    return [
      truncateDisplay("HENGFLOW", requestedWidth),
      ...board.items.map((item) => truncateDisplay(`${STATUS_ICON[item.status]} ${item.objective}`, requestedWidth)),
    ];
  }
  const width = requestedWidth;
  const innerWidth = width - 2;
  const palette = options.palette;
  const mode = options.mode ?? "summary";
  const paint = (key: keyof TaskBoardPalette, text: string): string => palette?.[key](text) ?? text;
  const statusPaint = (status: TaskStatus, text: string): string => {
    if (status === "completed") return paint("success", text);
    if (status === "failed" || status === "blocked") return paint("error", text);
    if (status === "verifying") return paint("warning", text);
    if (status === "running") return paint("accent", text);
    return paint("dim", text);
  };
  const framed = (raw: string, styled = raw): string => {
    const compactRaw = truncateDisplay(raw, innerWidth);
    const content = displayWidth(raw) <= innerWidth ? styled : paint("text", compactRaw);
    return `${paint("border", "│")}${content}${" ".repeat(Math.max(0, innerWidth - displayWidth(compactRaw)))}${paint("border", "│")}`;
  };
  const rule = (label?: string): string => {
    if (!label) return paint("border", `├${"─".repeat(innerWidth)}┤`);
    const compact = truncateDisplay(` ${label} `, Math.max(1, innerWidth - 2));
    return `${paint("border", "├─")}${paint("muted", compact)}${paint("border", `${"─".repeat(Math.max(0, innerWidth - displayWidth(compact) - 1))}┤`)}`;
  };

  const completed = board.items.filter((item) => item.status === "completed").length;
  const running = board.items.filter((item) => item.status === "running" || item.status === "verifying").length;
  const failed = board.items.filter((item) => item.status === "failed" || item.status === "blocked").length;
  const actual = board.items.reduce((sum, item) => sum + (item.actualCostUsd ?? 0), 0);
  const estimated = board.items.reduce((sum, item) => sum + item.estimatedCostUsd, 0);
  const settled = isTaskBoardSettled(board);
  const headline = failed > 0 ? `× ${failed} FAILED · ${completed}/${board.items.length}`
    : settled ? `✓ COMPLETE · ${completed}/${board.items.length}`
      : `◉ EXECUTING · ${completed}/${board.items.length} · ${running} running`;
  const headlineColor: keyof TaskBoardPalette = failed > 0 ? "error" : settled ? "success" : "accent";
  const brand = " HENGFLOW";
  const state = truncateDisplay(` · ${headline} `, Math.max(1, width - displayWidth(brand) - 4));
  const fill = "─".repeat(Math.max(0, width - displayWidth(brand) - displayWidth(state) - 4));
  const lines = [
    `${paint("border", "╭─")}${paint("accent", palette ? palette.bold(brand) : brand)}${paint(headlineColor, state)}${paint("border", `${fill}─╮`)}`,
  ];

  for (const [index, item] of board.items.entries()) {
    lines.push(rule(`${String(index + 1).padStart(2, "0")} · ${item.phase}`));
    const objectiveRaw = truncateDisplay(` ${STATUS_ICON[item.status]} ${item.objective}`, innerWidth);
    const icon = statusPaint(item.status, ` ${STATUS_ICON[item.status]}`);
    const objective = paint("text", ` ${truncateDisplay(item.objective, Math.max(1, innerWidth - 4))}`);
    lines.push(framed(objectiveRaw, `${icon}${objective}`));

    const cost = item.actualCostUsd === undefined ? `est ${money(item.estimatedCostUsd)}` : `actual ${money(item.actualCostUsd)}`;
    const model = shortModel(item.model);
    const metaLeft = `   ${routeLabel(item)} · ${STATUS_LABEL[item.status]} · ${model}`;
    const metaRaw = alignDisplay(metaLeft, cost, innerWidth);
    const metaStyled = displayWidth(metaLeft) + 2 + displayWidth(cost) <= innerWidth
      ? `${paint("muted", metaLeft)}${" ".repeat(innerWidth - displayWidth(metaLeft) - displayWidth(cost))}${paint("warning", cost)}`
      : paint("muted", metaRaw);
    lines.push(framed(metaRaw, metaStyled));

    if (mode === "summary" && item.note) {
      const noteRaw = truncateDisplay(`   ↳ ${compactNote(item.note)}`, innerWidth);
      lines.push(framed(noteRaw, paint("dim", noteRaw)));
    }
  }

  lines.push(rule());
  const costRaw = alignDisplay(` Worker actual $${actual.toFixed(4)}`, `Total est $${estimated.toFixed(4)} `, innerWidth);
  lines.push(framed(costRaw, paint("muted", costRaw)));
  const rawFooter = failed > 0 ? " ! ATTENTION REQUIRED " : settled ? " ✓ ALL TASKS SETTLED " : " ○ WAIT  ◉ RUN  ◇ VERIFY  ✓ DONE ";
  const footer = truncateDisplay(rawFooter, Math.max(1, width - 4));
  const bottomFill = "─".repeat(Math.max(0, width - displayWidth(footer) - 4));
  lines.push(`${paint("border", "╰─")}${statusPaint(failed > 0 ? "failed" : settled ? "completed" : "running", footer)}${paint("border", `${bottomFill}─╯`)}`);
  return fitDisplayLines(lines, width);
}
