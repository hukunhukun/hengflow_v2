import type { HengFlowConfig } from "./config.js";
import type { LearnedStat, UsageLedger } from "./ledger.js";
import type { CostBreakdown, QuotaReport, TaskBoard, WorkerProgress } from "./types.js";
import { displayWidth, fitDisplayLines, truncateDisplay } from "./ui-layout.js";
import { displayedQuotaLimits } from "./usage.js";

export interface PanelPalette {
  accent(text: string): string;
  success(text: string): string;
  warning(text: string): string;
  error(text: string): string;
  muted(text: string): string;
  bold(text: string): string;
}

export interface HengFlowFooterSnapshot {
  cwd: string;
  branch?: string | null;
  breakdown: CostBreakdown;
  contextPercent?: number | null;
  contextWindow?: number;
  model: string;
  managerProvider?: string;
  workerModels?: readonly { provider: string; model: string; label?: string }[];
  thinking: string;
  phase: "idle" | "planning" | "running" | "complete" | "failed";
  completedTasks: number;
  totalTasks: number;
  runningWorkers: number;
  managerReady: boolean;
  workerAvailability?: string;
  quotaReports?: readonly QuotaReport[];
}

function compactNumber(value: number): string {
  if (value < 1000) return Math.round(value).toString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function shortModel(model: string): string {
  return model.length <= 24 ? model : `${model.slice(0, 21)}…`;
}

function workerName(provider: string, model: string): string {
  if (provider === "deepseek" || model.toLowerCase().includes("deepseek")) return "DS";
  if (provider === "zai-coding-cn" || model.toLowerCase().includes("glm")) return "GLM";
  return shortModel(model);
}

function isGlm(provider: string, model: string): boolean {
  return provider === "zai-coding-cn" || model.toLowerCase().includes("glm");
}

function visibleCost(rows: readonly CostBreakdown["rows"][number][]): number {
  return rows.filter((row) => !isGlm(row.provider, row.model)).reduce((sum, row) => sum + row.shadowCostUsd, 0);
}

function workerDetails(breakdown: CostBreakdown): string {
  const rows = breakdown.rows.filter((row) => row.role === "worker");
  if (rows.length === 0) return "Workers —";
  return rows.map((row) => isGlm(row.provider, row.model)
    ? `${workerName(row.provider, row.model)}×${row.calls} (plan)`
    : `${workerName(row.provider, row.model)}×${row.calls} $${row.shadowCostUsd.toFixed(3)}`).join(" · ");
}

function money(value: number, currency?: string): string {
  const symbol = currency === "CNY" ? "¥" : currency === "USD" || !currency ? "$" : `${currency} `;
  return `${symbol}${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}`;
}

function quotaLimitValue(limit: QuotaReport["limits"][number]): string {
  if (limit.remaining === undefined) return "Unknown";
  if (limit.unit === "money") return `Balance ${money(limit.remaining, limit.currency)}`;
  const total = limit.unit === "percent" ? 100 : limit.limit;
  if (!total || total <= 0) return `Left ${compactNumber(limit.remaining)}`;
  const used = limit.used ?? Math.max(0, total - limit.remaining);
  const usedRatio = Math.max(0, Math.min(1, used / total));
  const usedText = limit.unit === "percent" ? `${used.toFixed(0)}%` : `${compactNumber(used)}/${compactNumber(total)}`;
  const leftText = limit.unit === "percent" ? `${limit.remaining.toFixed(0)}%` : `${compactNumber(limit.remaining)}/${compactNumber(total)}`;
  return `${bar(usedRatio, 1, 6)} Used ${usedText} · Left ${leftText}`;
}

function quotaWindows(reports: readonly QuotaReport[] | undefined, provider: string): string {
  const report = reports?.find((item) => item.provider === provider);
  if (!report) return "Loading quota…";
  const limits = displayedQuotaLimits(report);
  if (report.error || limits.length === 0) return "Quota unavailable";
  return limits.map((limit) => `${limit.label} ${quotaLimitValue(limit)}`).join(" · ");
}

function quotaWindowLines(reports: readonly QuotaReport[] | undefined, provider: string): string[] {
  const report = reports?.find((item) => item.provider === provider);
  if (!report || report.error || displayedQuotaLimits(report).length === 0) return [`  Quota · ${quotaWindows(reports, provider)}`];
  return displayedQuotaLimits(report).map((limit) => `  Quota · ${limit.label} ${quotaLimitValue(limit)}`);
}

function currentUsage(breakdown: CostBreakdown, role: "manager" | "worker", provider: string, showCost = true): string {
  const rows = breakdown.rows.filter((row) => row.role === role && row.provider === provider);
  if (rows.length === 0) return "Session —";
  const calls = rows.reduce((sum, row) => sum + row.calls, 0);
  const input = rows.reduce((sum, row) => sum + row.inputTokens, 0);
  const output = rows.reduce((sum, row) => sum + row.outputTokens, 0);
  const cost = rows.reduce((sum, row) => sum + row.shadowCostUsd, 0);
  return `Session ×${calls} ↑${compactNumber(input)} ↓${compactNumber(output)}${showCost ? ` $${cost.toFixed(3)}` : ""}`;
}

function currentWorkerUsage(breakdown: CostBreakdown, provider: string): string {
  return currentUsage(breakdown, "worker", provider, provider !== "zai-coding-cn");
}

function bar(value: number, maximum: number, width = 12): string {
  const filled = maximum <= 0 ? 0 : Math.max(0, Math.min(width, Math.round((value / maximum) * width)));
  return `${"█".repeat(filled)}${"░".repeat(Math.max(0, width - filled))}`;
}

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function renderWorkerPanel(progress: WorkerProgress, palette?: PanelPalette): string[] {
  const rawStatus = progress.status === "starting" ? "WAITING"
    : progress.status === "running" ? "RUNNING"
      : progress.status === "completed" ? "COMPLETE" : "FAILED";
  const paint = progress.status === "completed" ? palette?.success
    : progress.status === "failed" ? palette?.error
      : progress.status === "running" ? palette?.accent : palette?.warning;
  const status = paint?.(rawStatus) ?? rawStatus;
  const border = paint ?? ((text: string) => text);
  const activity = progress.currentTool ? `${progress.currentTool} · ${progress.lastEvent || "Running"}` : progress.lastEvent || "Waiting for events";
  const tokens = progress.inputTokens + progress.outputTokens;
  const preview = progress.outputPreview?.replace(/\s+/g, " ").trim();
  const lines = [
    `${border("╭─ HENGFLOW WORKER")} · ${palette?.bold(shortModel(progress.model)) ?? shortModel(progress.model)} · ${status} ${border("─────────────────────")}`,
    `${palette?.muted("│") ?? "│"} ${palette?.bold(progress.taskId) ?? progress.taskId}  ${progress.objective.slice(0, 52)}`,
    `${palette?.muted("│") ?? "│"} ${bar(progress.elapsedMs || 1, Math.max(progress.elapsedMs, 30_000), 18)}  ${duration(progress.elapsedMs).padStart(6)} ` +
      `· ${progress.requests} req · ${progress.toolCalls} tools · ${compactNumber(tokens)} tok`,
    `${palette?.muted("│") ?? "│"} ${palette?.accent("›") ?? "›"} ${activity.slice(0, 72)}`,
  ];
  if (preview) {
    lines.push(
      `${palette?.muted("├─") ?? "├─"} ${palette?.success("OUTPUT") ?? "OUTPUT"} ${palette?.muted("────────────────────────────────────────────────────") ?? "────────────────────────────────────────────────────"}`,
      `${palette?.muted("│") ?? "│"} ${preview.slice(0, 92)}${preview.length > 92 ? "…" : ""}`,
    );
  }
  if (progress.error) lines.push(`${palette?.error("│ !") ?? "│ !"} ${progress.error.slice(0, 72)}`);
  lines.push(border("╰────────────────────────────────────────────────────────────────"));
  return lines;
}

function wrapDisplay(text: string, width: number): string[] {
  if (width <= 0) return [];
  const wrapped: string[] = [];
  for (const sourceLine of text.replace(/\r/g, "").split("\n")) {
    if (!sourceLine) {
      wrapped.push("");
      continue;
    }
    let line = "";
    for (const character of sourceLine) {
      if (line && displayWidth(line + character) > width) {
        wrapped.push(line);
        line = character;
      } else {
        line += character;
      }
    }
    if (line) wrapped.push(line);
  }
  return wrapped;
}

/** One anchored live surface for every task. Running Workers expand; settled Workers collapse to one line. */
export function renderLiveExecutionPanel(
  board: TaskBoard,
  workers: readonly WorkerProgress[],
  width = 96,
  palette?: PanelPalette,
): string[] {
  const panelWidth = Math.max(1, width);
  if (panelWidth < 36) {
    return [
      truncateDisplay("HENGFLOW", panelWidth),
      ...board.items.map((item) => {
        const worker = workers.find((candidate) => candidate.taskId === item.id);
        const icon = worker?.status === "completed" || item.status === "completed" ? "✓"
          : worker?.status === "failed" || item.status === "failed" || item.status === "blocked" ? "×"
            : worker ? "◉" : "○";
        return truncateDisplay(`${icon} ${item.phase}${worker ? ` · ${worker.model}` : ""}`, panelWidth);
      }),
    ];
  }
  const innerWidth = panelWidth - 2;
  const workerByTask = new Map(workers.map((worker) => [worker.taskId, worker]));
  const completed = board.items.filter((item) =>
    item.status === "completed" || workerByTask.get(item.id)?.status === "completed",
  ).length;
  const failed = board.items.filter((item) =>
    item.status === "failed" || item.status === "blocked" || workerByTask.get(item.id)?.status === "failed",
  ).length;
  const running = workers.filter((worker) => worker.status === "starting" || worker.status === "running").length;
  const verifying = board.items.some((item) => item.status === "verifying");
  const rawState = failed > 0 ? `× ${failed} FAILED · ${completed}/${board.items.length}`
    : running > 0 ? `◉ EXECUTING · ${completed}/${board.items.length}`
      : verifying ? `◇ VERIFYING · ${completed}/${board.items.length}`
        : `✓ COMPLETE · ${completed}/${board.items.length}`;
  const statePaint = failed > 0 ? palette?.error : running > 0 ? palette?.accent : verifying ? palette?.warning : palette?.success;
  const border = palette?.muted ?? ((text: string) => text);
  const frame = (raw: string, styled = raw): string => {
    const compact = truncateDisplay(raw, innerWidth - 1);
    const content = displayWidth(raw) <= innerWidth - 1 ? styled : compact;
    return `${border("│")} ${content}${" ".repeat(Math.max(0, innerWidth - displayWidth(compact) - 1))}${border("│")}`;
  };
  const rule = (label: string): string => {
    const compact = truncateDisplay(` ${label} `, Math.max(1, innerWidth - 2));
    return `${border("├─")}${palette?.muted(compact) ?? compact}${border(`${"─".repeat(Math.max(0, innerWidth - displayWidth(compact) - 1))}┤`)}`;
  };
  const brand = " HENGFLOW · ";
  const state = truncateDisplay(rawState, Math.max(1, innerWidth - displayWidth(brand) - 2));
  // Account for both two-column corner segments: "╭─" and "─╮".
  // The previous innerWidth - 1 formula made the heading exactly one cell wider
  // than the render width (for example 156 cells in a 155-column terminal).
  const topFill = "─".repeat(Math.max(0, innerWidth - displayWidth(brand) - displayWidth(state) - 2));
  const lines = [
    `${border("╭─")}${palette?.bold(brand) ?? brand}${statePaint?.(state) ?? state}${border(`${topFill}─╮`)}`,
  ];

  for (const [index, item] of board.items.entries()) {
    const worker = workerByTask.get(item.id);
    const number = String(index + 1).padStart(2, "0");
    if (!worker) {
      const icon = item.status === "completed" ? "✓" : item.status === "failed" || item.status === "blocked" ? "×" : item.status === "running" ? "◉" : "○";
      const dependency = item.dependsOn?.length ? ` · ← ${item.dependsOn.join(",")}` : "";
      lines.push(frame(`${icon} ${number} · ${item.phase} · MANAGER · ${item.status}${dependency}`));
      continue;
    }

    const tokens = worker.inputTokens + worker.outputTokens;
    const cost = worker.costUsd ? ` · $${worker.costUsd.toFixed(3)}` : "";
    const stats = `${duration(worker.elapsedMs)} · ${worker.requests} req · ${worker.toolCalls} tools · ${compactNumber(tokens)} tok${cost}`;
    if (worker.status === "completed" || worker.status === "failed") {
      const icon = worker.status === "completed" ? "✓" : "×";
      const raw = `${icon} ${number} · ${item.phase} · ${shortModel(worker.model)} · ${stats}`;
      const paint = worker.status === "completed" ? palette?.success : palette?.error;
      lines.push(frame(raw, paint?.(raw) ?? raw));
      continue;
    }

    lines.push(rule(`◉ ${number} · ${item.phase} · ${shortModel(worker.model)} · ${stats}`));
    const toolElapsed = worker.currentToolStartedAt ? ` · ${duration(Date.now() - worker.currentToolStartedAt)}` : "";
    const activity = worker.currentTool ? `└ ${worker.currentTool}${toolElapsed} · ${worker.lastEvent || "Running"}` : worker.lastEvent || "Waiting for events";
    lines.push(frame(activity, `${palette?.accent(worker.currentTool ? "└" : "›") ?? (worker.currentTool ? "└" : "›")} ${palette?.muted(activity.replace(/^[└›]\s*/, "")) ?? activity}`));
    const liveText = worker.streamingText || worker.toolPreview;
    if (liveText) {
      const recent = wrapDisplay(liveText, Math.max(12, innerWidth - 3)).slice(-3);
      for (const text of recent) lines.push(frame(`  ${text}`, palette?.muted(`  ${text}`) ?? `  ${text}`));
    }
  }

  const actual = board.items.reduce((sum, item) => sum + (item.actualCostUsd ?? 0), 0);
  const totalRequests = workers.reduce((sum, worker) => sum + worker.requests, 0);
  const totalTools = workers.reduce((sum, worker) => sum + worker.toolCalls, 0);
  const footer = `${running} running · ${completed} completed · ${totalRequests} req · ${totalTools} tools · W $${actual.toFixed(4)}`;
  const maxRows = Math.max(8, Math.min(14, Math.floor((process.stdout.rows ?? 36) * 0.35)));
  if (lines.length >= maxRows) {
    const hidden = lines.length - (maxRows - 2);
    lines.splice(maxRows - 2, lines.length, frame(`… ${hidden} more rows · /tasks 查看完整任务分配`));
  }
  const bottom = truncateDisplay(` ${footer} `, Math.max(1, innerWidth - 2));
  lines.push(`${border("╰─")}${palette?.muted(bottom) ?? bottom}${border(`${"─".repeat(Math.max(0, innerWidth - displayWidth(bottom) - 1))}╯`)}`);
  return fitDisplayLines(lines, panelWidth);
}

function alignFooter(left: string, right: string, width: number): string {
  const minimumGap = 2;
  if (displayWidth(left) + minimumGap + displayWidth(right) <= width) {
    return `${left}${" ".repeat(width - displayWidth(left) - displayWidth(right))}${right}`;
  }
  const leftWidth = Math.max(12, width - displayWidth(right) - minimumGap);
  const compactLeft = truncateDisplay(left, leftWidth);
  const remaining = width - displayWidth(compactLeft) - minimumGap;
  if (remaining <= 8) return truncateDisplay(left, width);
  const compactRight = truncateDisplay(right, remaining);
  return `${compactLeft}${" ".repeat(Math.max(minimumGap, width - displayWidth(compactLeft) - displayWidth(compactRight)))}${compactRight}`;
}

export function renderHengFlowFooter(snapshot: HengFlowFooterSnapshot, width: number): string[] {
  const pwd = snapshot.branch ? `${snapshot.cwd} (${snapshot.branch})` : snapshot.cwd;
  const context = snapshot.contextPercent === null || snapshot.contextPercent === undefined
    ? `?/${compactNumber(snapshot.contextWindow ?? 0)} (auto)`
    : `${snapshot.contextPercent.toFixed(1)}%/${compactNumber(snapshot.contextWindow ?? 0)} (auto)`;
  const workerRows = snapshot.breakdown.rows.filter((row) => row.role === "worker");
  const managerRows = snapshot.breakdown.rows.filter((row) => row.role === "manager");
  const managerProvider = snapshot.managerProvider ?? managerRows[0]?.provider ?? "openai-codex";
  const workerModels: readonly { provider: string; model: string; label?: string }[] = snapshot.workerModels?.length
    ? snapshot.workerModels
    : workerRows.map((row) => ({ provider: row.provider, model: row.model }));
  const workerCost = visibleCost(workerRows);
  const managerCost = visibleCost(managerRows);
  const taskCost = workerCost + managerCost;
  const model = `${snapshot.model} • ${snapshot.thinking}`;
  const phaseIcon = snapshot.phase === "running" || snapshot.phase === "planning" ? "◉"
    : snapshot.phase === "complete" ? "✓" : snapshot.phase === "failed" ? "×" : "○";
  const progress = snapshot.totalTasks > 0 ? `${snapshot.completedTasks}/${snapshot.totalTasks}`
    : snapshot.phase === "planning" ? "planning"
      : snapshot.phase === "running" ? "running"
        : snapshot.phase === "complete" ? "complete"
          : snapshot.phase === "failed" ? "failed" : "ready";
  const workers = snapshot.runningWorkers > 0 ? ` · ${snapshot.runningWorkers} worker running` : "";
  const manager = snapshot.managerReady ? "sol · medium" : "login required";
  const availability = snapshot.workerAvailability ? ` · workers ${snapshot.workerAvailability}` : "";
  const status = `HF manager: ${manager} · ${phaseIcon} ${progress}${workers}${availability}`;

  // Preserve a compact three-line footer in narrow terminals; wider terminals expose Manager and Worker quota windows.
  if (width < 96) {
    const usage = `Task $${taskCost.toFixed(3)} · M $${managerCost.toFixed(3)} · W $${workerCost.toFixed(3)}`;
    const quota = `M ${quotaWindows(snapshot.quotaReports, managerProvider)} · W ${workerModels.slice(0, 1).map((worker) => quotaWindows(snapshot.quotaReports, worker.provider)).join("") || "—"}`;
    return [truncateDisplay(pwd, width), alignFooter(usage, model, width), alignFooter(quota, context, width)];
  }

  const taskUsage = `Task $${taskCost.toFixed(3)} · M $${managerCost.toFixed(3)} · ${workerDetails(snapshot.breakdown)}`;
  const managerUsage = `Manager · ${currentUsage(snapshot.breakdown, "manager", managerProvider)}`;
  const workerLines = workerModels.slice(0, 4).flatMap((worker) => {
    const label = worker.label || (isGlm(worker.provider, worker.model) ? "GLM Coding Plan" : workerName(worker.provider, worker.model));
    const report = snapshot.quotaReports?.find((item) => item.provider === worker.provider);
    const limits = report ? displayedQuotaLimits(report) : [];
    const usage = `${label} · ${currentWorkerUsage(snapshot.breakdown, worker.provider)}`;
    if (limits.length <= 1) return [`${usage} · ${quotaWindows(snapshot.quotaReports, worker.provider)}`];
    return [usage, ...quotaWindowLines(snapshot.quotaReports, worker.provider)];
  });
  return [
    truncateDisplay(pwd, width),
    alignFooter(taskUsage, model, width),
    truncateDisplay(managerUsage, width),
    ...quotaWindowLines(snapshot.quotaReports, managerProvider).map((line) => truncateDisplay(line, width)),
    ...workerLines.map((line) => truncateDisplay(line, width)),
    alignFooter(status, context, width),
  ];
}

export function renderCostPanel(breakdown: CostBreakdown, title = "TASK USAGE"): string[] {
  const lines = [`╭─ HENGFLOW · ${title} ─────────────────────────────────────`];
  if (breakdown.rows.length === 0) {
    lines.push("│ No model calls yet");
  } else {
    const maxCost = Math.max(...breakdown.rows.filter((row) => !isGlm(row.provider, row.model)).map((row) => row.shadowCostUsd), 0);
    for (const row of breakdown.rows) {
      const role = row.role === "manager" ? "M" : "W";
      const economics = isGlm(row.provider, row.model)
        ? "Coding Plan quota"
        : `${bar(row.shadowCostUsd, maxCost)} $${row.shadowCostUsd.toFixed(5)}`;
      lines.push(
        `│ ${role} ${shortModel(row.model).padEnd(24)} ${economics} ` +
        `↑${compactNumber(row.inputTokens).padStart(5)} ↓${compactNumber(row.outputTokens).padStart(5)}`,
      );
    }
  }
  lines.push("├──────────────────────────────────────────────────────────");
  lines.push(
    `│ ${breakdown.calls} calls · ↑${compactNumber(breakdown.inputTokens)} · ↓${compactNumber(breakdown.outputTokens)} ` +
    `· tracked $${visibleCost(breakdown.rows).toFixed(5)} · provider $${breakdown.reportedCostUsd.toFixed(5)}`,
  );
  lines.push("╰─ GLM Coding Plan displays the 5h / week quota windows ─");
  return lines;
}

function learnedLine(stat: LearnedStat): string {
  const key = `${shortModel(stat.model)}/${stat.taskKind}/${stat.complexityBucket}`;
  return `│ ${key.padEnd(42)} n=${String(stat.samples).padStart(3)} q=${stat.posteriorQuality.toFixed(3)} ` +
    `fail=${(stat.failureProbability * 100).toFixed(0).padStart(2)}% cost×${stat.costRatio.toFixed(2)}`;
}

export function renderDashboard(ledger: UsageLedger, config: HengFlowConfig): string[] {
  const cost = ledger.getCostBreakdown();
  const configuredWorkers = Object.values(config.workers);
  const learned = ledger.getLearnedStats(configuredWorkers);
  const stats = ledger.getModelStats();
  const maximumCost = Math.max(...cost.rows.filter((row) => !isGlm(row.provider, row.model)).map((row) => row.shadowCostUsd), 0);
  const trackedCost = visibleCost(cost.rows);
  const workerCost = visibleCost(cost.rows.filter((row) => row.role === "worker"));
  const workerCalls = cost.rows.filter((row) => row.role === "worker").reduce((sum, row) => sum + row.calls, 0);
  const lines = [
    "╭─ HENGFLOW · CONTROL CENTER ───────────────────────────────────",
    `│ TRACKED $${visibleCost(cost.rows).toFixed(4).padStart(9)}   PROVIDER $${cost.reportedCostUsd.toFixed(4).padStart(9)}   CALLS ${String(cost.calls).padStart(5)}`,
    `│ TOKENS  ↑${compactNumber(cost.inputTokens).padStart(7)} ↓${compactNumber(cost.outputTokens).padStart(7)}   WORKERS ${String(workerCalls).padStart(4)} calls / $${workerCost.toFixed(4)}`,
    "├─ MODEL ECONOMICS ─────────────────────────────────────────────",
    "│ R  MODEL                    CALLS   COST       SHARE / LATENCY",
  ];
  if (cost.rows.length === 0) lines.push("│ ·  No model calls yet");
  for (const row of cost.rows) {
    const modelStat = stats.find((item) => item.provider === row.provider && item.model === row.model);
    const role = row.role === "manager" ? "M" : "W";
    const latency = modelStat ? duration(modelStat.averageLatencyMs) : "-";
    lines.push(
      `│ ${role}  ${shortModel(row.model).padEnd(23)} ${String(row.calls).padStart(5)}  ` +
      `${isGlm(row.provider, row.model) ? " PLAN QUOTA         " : `$${row.shadowCostUsd.toFixed(4).padStart(8)}  ${bar(row.shadowCostUsd, maximumCost, 10)}`} ${latency.padStart(6)}`,
    );
  }
  lines.push(
    "├─ ROUTING HEALTH ──────────────────────────────────────────────",
    `│ Worker cost share ${trackedCost > 0 ? ((workerCost / trackedCost) * 100).toFixed(1).padStart(5) : "  0.0"}%   ` +
      `quota pressure  ${configuredWorkers.map((worker) => `${worker.model} ${(ledger.getQuotaPressure(worker.provider) * 100).toFixed(0)}%`).join("  ") || "n/a"}`,
    "├─ LEARNING · MODEL / KIND / COMPLEXITY ───────────────────────",
  );
  if (learned.length === 0) {
    lines.push("│ COLD START  No Manager review samples; Router is using fixed priors");
  } else {
    for (const stat of learned.slice(0, 8)) lines.push(learnedLine(stat));
  }
  lines.push("╰─ q posterior quality · fail semantic failure rate · cost× EWMA ─");
  return lines;
}
