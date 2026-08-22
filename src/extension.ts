import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext, Theme } from "./runtime/agent.js";
import { Type } from "typebox";
import { saveModelSelection, type HengFlowConfig } from "./config.js";
import { estimateCost, usageShadowCost, workerShadowCost } from "./cost.js";
import {
  renderDashboard,
  renderHengFlowFooter,
  renderLiveExecutionPanel,
  type PanelPalette,
} from "./dashboard.js";
import { UsageLedger } from "./ledger.js";
import { evaluateSplit, routePlannedTask } from "./router.js";
import { buildTaskContext, chooseContextPolicy } from "./context-policy.js";
import { validateTaskGraph } from "./graph.js";
import { StageOrchestrator } from "./orchestrator.js";
import {
  completeOpenManagerTasks,
  completeVerifiedWorkerTasks,
  isTaskBoardSettled,
  latestTaskBoard,
  renderTaskBoard,
  requiresPlan,
  setProcessTaskBoard,
  TASK_BOARD_ENTRY,
  TASK_SUMMARY_ENTRY,
  type TaskBoardPalette,
  updateBoardItem,
} from "./task-board.js";
import type {
  ContextPolicy,
  DelegatedTask,
  LearnedProfile,
  ExecutionMode,
  PlannedTask,
  ReturnPolicy,
  ModelRef,
  CostBreakdown,
  RouteDecision,
  TaskBoard,
  TaskOutcome,
  TaskStatus,
  WorkerProgress,
  WorkerResult,
} from "./types.js";
import { fetchAllUsage, latestQuotaReports, parseCodexHeaders, renderUsagePanel } from "./usage.js";
import { runWorker, snapshotParentContext, withInheritedContextCost } from "./worker.js";
import { discoverWorkers, modelRefFromRuntime, workerDisplayName } from "./model-catalog.js";
import { managerInstructions, routingGate, shouldBlockTool } from "./manager-policy.js";
import { managerKey, selectManager } from "./manager-selector.js";
import { hashSeed, SeededRandom } from "./rng.js";

const TaskSchema = Type.Object({
  id: Type.String({ description: "Stable short task ID" }),
  objective: Type.String({ description: "Concrete objective with a verifiable deliverable; the Worker inherits the Manager transcript" }),
  kind: Type.Union([
    Type.Literal("simple"), Type.Literal("research"), Type.Literal("coding"),
    Type.Literal("long-context"), Type.Literal("synthesis"),
  ]),
  risk: Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")]),
  complexity: Type.Number({ minimum: 0, maximum: 1 }),
  estimatedInputTokens: Type.Number({ minimum: 1 }),
  estimatedOutputTokens: Type.Number({ minimum: 1 }),
  context: Type.Optional(Type.String({ description: "Optional task-local clarification, not a copy of the parent conversation" })),
  preferredWorker: Type.Optional(Type.String({ description: "auto or a discovered worker id (provider/model)" })),
  allowBash: Type.Optional(Type.Boolean({ description: "Allow read-only shell inspection/tests for a low-risk task" })),
  requiresWrite: Type.Optional(Type.Boolean({ description: "True when this item changes files or external state" })),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Direct predecessor task IDs in the DAG" })),
  contextPolicy: Type.Optional(Type.Union([
    Type.Literal("latest_turn"), Type.Literal("dependency_outputs"),
    Type.Literal("session_summary"), Type.Literal("full_fork"),
  ], { description: "Optional override; Harness chooses automatically when omitted" })),
  phase: Type.Optional(Type.String({ description: "Short phase name used by the progress panel" })),
});

const ExecutionPlanSchema = Type.Object({
  mode: Type.Union([
    Type.Literal("direct_manager"), Type.Literal("direct_worker"), Type.Literal("parallel"),
  ], { description: "One Manager task, one cheap Worker, or multiple concurrently routed tasks" }),
  returnPolicy: Type.Union([
    Type.Literal("passthrough"), Type.Literal("manager_synthesis"),
  ], { description: "Pass through one low-risk Worker result, or let Manager verify/synthesize" }),
  rationale: Type.String({ description: "Compact explanation of the decomposition" }),
  tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 8 }),
});

const CollectStageSchema = Type.Object({
  delegationId: Type.String({ description: "delegationId returned immediately by execute_plan" }),
});

const ReportOutcomesSchema = Type.Object({
  delegationId: Type.String({ description: "delegationId returned by execute_plan when Manager verification is required" }),
  outcomes: Type.Array(Type.Object({
    taskId: Type.String(),
    status: Type.Union([
      Type.Literal("accepted"), Type.Literal("accepted_edit"), Type.Literal("reworked"),
      Type.Literal("rejected"), Type.Literal("failed"),
    ]),
    quality: Type.Number({ minimum: 0, maximum: 1, description: "Evidence-based quality score" }),
    confidence: Type.Number({ minimum: 0, maximum: 1, description: "Confidence in this evaluation" }),
    reason: Type.Optional(Type.String()),
  }), { minItems: 1, maxItems: 8 }),
});

const UpdateTaskSchema = Type.Object({
  taskId: Type.String({ description: "Exact task ID from execute_plan" }),
  status: Type.Union([
    Type.Literal("running"), Type.Literal("completed"), Type.Literal("blocked"), Type.Literal("failed"),
  ]),
  note: Type.Optional(Type.String()),
});

interface OutcomeReportDetails {
  updated: Array<{ taskId: string; model: string; status: TaskOutcome["status"]; profile: LearnedProfile }>;
  missing?: string[];
  unknown?: string[];
}

interface ActiveStage {
  id: string;
  returnPolicy: ReturnPolicy;
  tasks: PlannedTask[];
  routed: Array<{ task: PlannedTask; decision: ReturnType<typeof routePlannedTask> }>;
  results: Map<string, WorkerResult>;
  statuses: Map<string, TaskStatus>;
  promise: Promise<WorkerResult[]>;
  collected: boolean;
  controller: AbortController;
  kick: () => void;
}

function formatWorkerResults(results: Awaited<ReturnType<typeof runWorker>>[]): string {
  return results.map((result) => {
    const status = result.exitCode === 0 && result.stopReason !== "error" ? "ok" : "failed";
    return [
      `## ${result.task.id} [${status}]`,
      `route: ${result.route.selected.provider}/${result.route.selected.model}`,
      `reason: ${result.route.explanation.join("; ")}`,
      `usage: input=${result.usage.input} output=${result.usage.output} cache=${result.usage.cacheRead} reported=$${result.usage.reportedCostUsd.toFixed(5)}`,
      result.retried ? "retry: used the single configured fallback" : "",
      "",
      result.output,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function availableWorkers(ctx: ExtensionContext, config: HengFlowConfig) {
  return discoverWorkers(ctx.modelRegistry, config);
}

function taskBoardPalette(theme: Theme): TaskBoardPalette {
  return {
    accent: (text) => theme.fg("accent", text),
    success: (text) => theme.fg("success", text),
    warning: (text) => theme.fg("warning", text),
    error: (text) => theme.fg("error", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    text: (text) => theme.fg("text", text),
    border: (text) => theme.fg("borderMuted", text),
    bold: (text) => theme.bold(text),
  };
}

function taskBoardComponent(board: TaskBoard, theme: Theme, mode: "live" | "summary") {
  return {
    render: (width: number) => renderTaskBoard(board, { width, palette: taskBoardPalette(theme), mode }),
    invalidate() {},
  };
}

export function createHengFlowExtension(config: HengFlowConfig) {
  return function hengflowExtension(pi: ExtensionAPI): void {
    const ledger = new UsageLedger();
    let managerTurnStartedAt = 0;
    let turnCounter = 0;
    let championId: string | undefined;
    const writeExploration = new Map<string, { turns: number; failures: number }>();
    let turnStartedAt = 0;
    let turnReworkCount = 0;
    let verifiedDelegations = 0;
    let lastManagerExploratory: string | undefined;
    let taskCallBaseline: number | undefined;
    let activePrompt = "";
    let planRequired = false;
    let planCreated = false;
    let lastManagerStopReason: string | undefined;
    let managerReady = false;
    let footerPhase: "idle" | "planning" | "running" | "complete" | "failed" = "idle";
    let workerAvailability = "checking";
    let discoveredWorkerModels = Object.values(config.workers);
    let lastTaskBreakdown: CostBreakdown = {
      rows: [], calls: 0, inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, shadowCostUsd: 0,
    };
    let currentBoard: TaskBoard | undefined;
    const workerProgress = new Map<string, WorkerProgress>();
    let liveRefreshTimer: ReturnType<typeof setInterval> | undefined;
    let quotaRefresh: Promise<void> | undefined;
    let quotaAbort: AbortController | undefined;
    const pendingDelegations = new Map<string, Map<string, WorkerResult>>();
    const activeStages = new Map<string, ActiveStage>();
    const bench = config.bench;
    const benchSingle = bench?.variant === "single";
    const benchFrozen = Boolean(bench?.freezeLearning);
    const routeSeed = (taskId: string) => new SeededRandom(hashSeed("route", taskId, String(bench?.seed ?? 0)));
    let economicsOverridden = false;

    // Keep rendering summaries from older sessions, but new runs no longer append a duplicate completed board.
    pi.registerEntryRenderer<TaskBoard>(TASK_SUMMARY_ENTRY, (entry, _options, theme) =>
      entry.data ? taskBoardComponent(entry.data, theme, "summary") : undefined);

    const livePanelPalette = (theme: Theme): PanelPalette => ({
      accent: (text) => theme.fg("accent", text),
      success: (text) => theme.fg("success", text),
      warning: (text) => theme.fg("warning", text),
      error: (text) => theme.fg("error", text),
      muted: (text) => theme.fg("dim", text),
      bold: (text) => theme.bold(text),
    });

    const clearLivePanel = (ctx: ExtensionContext) => {
      if (liveRefreshTimer) clearInterval(liveRefreshTimer);
      liveRefreshTimer = undefined;
      if (ctx.mode === "tui") ctx.ui.setWidget("hengflow-live", undefined);
    };

    const publishLivePanel = (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui" || !currentBoard) return;
      ctx.ui.setWidget(
        "hengflow-live",
        (_tui, theme) => ({
          render(width: number) {
            const now = Date.now();
            const workers = [...workerProgress.values()].map((worker) =>
              worker.status === "starting" || worker.status === "running"
                ? { ...worker, elapsedMs: now - worker.startedAt }
                : worker,
            );
            return renderLiveExecutionPanel(currentBoard!, workers, width, livePanelPalette(theme));
          },
          invalidate() {},
        }),
        { placement: "aboveEditor" },
      );
    };

    const publishBoard = (ctx: ExtensionContext, persist = true, visible = true) => {
      setProcessTaskBoard(currentBoard);
      if (!currentBoard) {
        clearLivePanel(ctx);
        return;
      }
      if (persist) pi.appendEntry(TASK_BOARD_ENTRY, currentBoard);
      if (visible) publishLivePanel(ctx);
      else clearLivePanel(ctx);
    };

    const recordPlanDecision = (decision: ReturnType<typeof routePlannedTask>) => {
      if (decision.workerRoute) {
        ledger.recordDecision(decision.workerRoute);
        return;
      }
      ledger.recordDecision({
        taskId: decision.taskId,
        selected: config.manager,
        score: 0,
        predictedCostUsd: decision.predictedCostUsd,
        predictedFailureProbability: 0,
        explanation: decision.explanation,
      });
    };

    const publishWorkerProgress = (ctx: ExtensionContext, progress: WorkerProgress) => {
      workerProgress.set(progress.taskId, { ...progress });
      if (progress.status === "starting" || progress.status === "running") footerPhase = "running";
      publishLivePanel(ctx);
      const hasRunningWorkers = [...workerProgress.values()].some((worker) =>
        worker.status === "starting" || worker.status === "running",
      );
      if (hasRunningWorkers && !liveRefreshTimer) {
        liveRefreshTimer = setInterval(() => publishLivePanel(ctx), 1000);
        liveRefreshTimer.unref();
      } else if (!hasRunningWorkers && liveRefreshTimer) {
        clearInterval(liveRefreshTimer);
        liveRefreshTimer = undefined;
      }
    };

    const refreshQuota = (ctx: ExtensionContext): Promise<void> => {
      if (quotaRefresh) return quotaRefresh;
      const controller = new AbortController();
      quotaAbort = controller;
      const pending = fetchAllUsage(
        { getAuth: (provider: string) => ctx.modelRegistry.getProviderAuth(provider) },
        ledger,
        config.usage.cacheTtlMs,
        false,
        controller.signal,
      ).then(() => undefined).catch(() => undefined).finally(() => {
        if (quotaRefresh === pending) quotaRefresh = undefined;
        if (quotaAbort === controller) quotaAbort = undefined;
      });
      quotaRefresh = pending;
      return pending;
    };

    const installFooter = (ctx: ExtensionContext) => {
      if (ctx.mode !== "tui") return;
      ctx.ui.setFooter((tui, theme, footerData) => {
        const requestRender = () => tui.requestRender();
        const branchSubscription = footerData.onBranchChange(requestRender);
        const refresh = setInterval(requestRender, 1000);
        refresh.unref();
        return {
          invalidate() {},
          dispose() {
            clearInterval(refresh);
            branchSubscription();
          },
          render(width: number): string[] {
            const breakdown = taskCallBaseline === undefined
              ? lastTaskBreakdown
              : ledger.getCostBreakdown(taskCallBaseline);
            const quotaReports = latestQuotaReports(
              ledger,
              config.manager.provider,
              discoveredWorkerModels.map((worker) => worker.provider),
            );
            const context = ctx.getContextUsage();
            const completedTasks = currentBoard?.items.filter((item) => item.status === "completed").length ?? 0;
            const totalTasks = currentBoard?.items.length ?? 0;
            const runningWorkers = [...workerProgress.values()].filter((item) =>
              item.status === "starting" || item.status === "running",
            ).length;
            const home = homedir();
            const cwd = ctx.cwd === home ? "~" : ctx.cwd.startsWith(`${home}/`) ? `~/${ctx.cwd.slice(home.length + 1)}` : ctx.cwd;
            const lines = renderHengFlowFooter({
              cwd,
              branch: footerData.getGitBranch(),
              breakdown,
              contextPercent: context?.percent,
              contextWindow: context?.contextWindow ?? ctx.model?.contextWindow,
              model: ctx.model?.id ?? config.manager.model,
              managerProvider: config.manager.provider,
              workerModels: discoveredWorkerModels,
              thinking: ctx.thinkingLevel ?? config.manager.thinking,
              phase: footerPhase,
              completedTasks,
              totalTasks,
              runningWorkers,
              managerReady,
              workerAvailability,
              quotaReports,
            }, width);
            const statusColor = footerPhase === "failed" ? "error"
              : footerPhase === "complete" ? "success"
                : footerPhase === "running" || footerPhase === "planning" ? "accent" : "dim";
            return lines.map((line, index) => theme.fg(index === lines.length - 1 ? statusColor : "dim", line));
          },
        };
      });
    };

    const poolAuthenticated = (ctx: ExtensionContext) => config.pool.filter((model) =>
      ctx.modelRegistry.getAvailable().some(
        (available) => available.provider === model.provider && available.id === model.model,
      ));

    // v4: the Manager is selected per turn from the authenticated pool via a
    // seeded sticky-Thompson selector. The chosen model overwrites
    // config.manager so router cost constants and worker-pool exclusion follow
    // automatically; the pool anchor remains the safety floor.
    const enforcePool = async (ctx: ExtensionContext, prompt: string): Promise<boolean> => {
      if (!config.modelsConfigured || config.pool.length < 2) {
        ctx.ui.notify("HengFlow v4：请先执行 /models 配置至少 2 个模型（首位为锚点）", "error");
        return false;
      }
      const authenticated = poolAuthenticated(ctx);
      if (authenticated.length < 2) {
        ctx.ui.notify(
          `请求已阻止：已认证模型 ${authenticated.length}/2；请执行 /login 或 /models`,
          "error",
        );
        return false;
      }
      const parentContext = snapshotParentContext(
        ctx.sessionManager.getEntries(),
        ctx.sessionManager.getLeafId(),
        ctx.sessionManager.getSessionFile(),
      );
      const managerProfiles = new Map(ledger.getManagerProfiles().map(
        (profile) => [`${profile.provider}/${profile.model}`, profile] as const,
      ));
      const profiles = new Map(authenticated.map((model) => {
        const profile = managerProfiles.get(`${model.provider}/${model.model}`);
        return [`${model.provider}/${model.model}`, {
          model,
          samples: profile?.samples ?? 0,
          successes: profile?.successes ?? 0,
        }] as const;
      }));
      const rng = new SeededRandom(hashSeed(String(turnCounter), prompt, championId ?? "-"));
      const selection = selectManager({
        pool: authenticated,
        profiles,
        requiresWrite: requiresPlan(prompt),
        sessionHistoryTokens: parentContext.estimatedTokens,
        championId,
        rng,
        explorationLedger: writeExploration,
      });
      championId = selection.nextChampionId;
      turnCounter += 1;
      lastManagerExploratory = selection.exploratory ? selection.selectedId : undefined;
      const chosen = selection.selected;
      config.manager = chosen;
      const runtime = ctx.modelRegistry.getAvailable().find(
        (model) => model.provider === chosen.provider && model.id === chosen.model,
      );
      if (!runtime) {
        ctx.ui.notify(`选中的 Manager ${chosen.provider}/${chosen.model} 已不可用；请重新登录后重试`, "error");
        return false;
      }
      if (ctx.model?.provider !== chosen.provider || ctx.model?.id !== chosen.model) {
        const changed = await pi.setModel(runtime);
        if (!changed) {
          ctx.ui.notify(`无法切换 Manager 到 ${chosen.provider}/${chosen.model}`, "error");
          return false;
        }
      }
      pi.setThinkingLevel(chosen.thinking);
      ledger.recordDecision({
        taskId: `manager:turn${turnCounter}`,
        selected: chosen,
        score: selection.sampledUtilityUsd,
        predictedCostUsd: selection.planningCostUsd,
        predictedFailureProbability: selection.failureProbability,
        explanation: [selection.reason],
      }, "manager");
      return true;
    };

    pi.on("input", (_event, ctx) => {
      if (!config.modelsConfigured) {
        ctx.ui.notify("请求已阻止：请先执行 /login 和 /models 完成模型配置", "error");
        return { action: "handled" };
      }
      if (poolAuthenticated(ctx).length < 2) {
        ctx.ui.notify(
          "请求已阻止：HengFlow v4 需要至少 2 个已认证模型；请执行 /login 或 /models",
          "error",
        );
        return { action: "handled" };
      }
      return { action: "continue" };
    });

    pi.on("session_start", async (_event, ctx) => {
      // Manager selection happens per turn in before_agent_start; here we
      // only validate the pool so misconfiguration surfaces before input.
      managerReady = benchSingle
        || (config.modelsConfigured && poolAuthenticated(ctx).length >= 2);
      const workers = availableWorkers(ctx, config);
      discoveredWorkerModels = workers;
      workerAvailability = workers.length ? workers.map(workerDisplayName).slice(0, 3).join("/") : "none";
      const entries = ctx.sessionManager.getEntries();
      currentBoard = latestTaskBoard(entries);
      setProcessTaskBoard(currentBoard);
      ctx.ui.setTitle("HengFlow · 衡流");
      ctx.ui.setStatus("hengflow", undefined);
      installFooter(ctx);
      void refreshQuota(ctx);
      if (currentBoard && ctx.mode === "tui" && !isTaskBoardSettled(currentBoard)) publishBoard(ctx, false);
    });

    pi.on("before_agent_start", async (event, ctx) => {
      turnStartedAt = Date.now();
      turnReworkCount = 0;
      verifiedDelegations = 0;
      if (!benchSingle) {
        const ready = await enforcePool(ctx, event.prompt);
        managerReady = ready;
        if (!ready) throw new Error("HengFlow 模型尚未配置或不可用；请先执行 /login 和 /models");
        void refreshQuota(ctx);
      }
      taskCallBaseline ??= ledger.getLastCallId();
      activePrompt = event.prompt;
      footerPhase = benchSingle ? "running" : "planning";
      planRequired = requiresPlan(event.prompt);
      planCreated = false;
      economicsOverridden = false;
      lastManagerStopReason = undefined;
      currentBoard = undefined;
      clearLivePanel(ctx);
      workerProgress.clear();
      if (ctx.mode === "tui") {
        ctx.ui.setWidget("hengflow-cost", undefined);
        ctx.ui.setWidget("hengflow-tasks", undefined);
      }
      publishBoard(ctx, false);
      return benchSingle
        ? { systemPrompt: event.systemPrompt }
        : { systemPrompt: `${event.systemPrompt}\n\n${managerInstructions(config)}\n\n${routingGate(planRequired)}` };
    });

    pi.on("tool_call", (event) => {
      if (benchSingle) return undefined;
      const reason = shouldBlockTool(event.toolName, planCreated);
      return reason ? { block: true, reason } : undefined;
    });

    pi.on("turn_start", () => {
      managerTurnStartedAt = Date.now();
    });

    pi.on("message_end", (event) => {
      const message = event.message as any;
      if (message.role !== "assistant" || !message.usage) return;
      lastManagerStopReason = message.stopReason;
      if (message.stopReason === "error" || message.stopReason === "aborted") footerPhase = "failed";
      const usage = {
        input: message.usage.input ?? 0,
        output: message.usage.output ?? 0,
        cacheRead: message.usage.cacheRead ?? 0,
        cacheWrite: message.usage.cacheWrite ?? 0,
        reasoning: message.usage.reasoning,
        totalTokens: message.usage.totalTokens ?? 0,
        reportedCostUsd: message.usage.cost?.total ?? 0,
      };
      ledger.recordManagerCall(
        config.manager.provider,
        config.manager.model,
        usage,
        usageShadowCost(config.manager, usage),
        message.stopReason,
        managerTurnStartedAt ? Date.now() - managerTurnStartedAt : 0,
      );
    });

    pi.on("after_provider_response", (event, ctx) => {
      if (config.manager.provider !== "openai-codex" || ctx.model?.provider !== config.manager.provider) return;
      const normalized = Object.fromEntries(Object.entries(event.headers).map(([key, value]) => [key.toLowerCase(), value]));
      const report = parseCodexHeaders(normalized);
      if (report) ledger.recordQuota(report);
    });

    pi.registerTool({
      name: "execute_plan",
      label: "HengFlow Execute DAG",
      description: "Create and route a DAG, start ready read-only Workers, and return immediately.",
      promptSnippet: "Submit task dependencies once; then work on Manager nodes while Workers run and collect at the stage barrier.",
      parameters: ExecutionPlanSchema,
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, _signal, onUpdate, ctx) {
        if (benchSingle) {
          return { content: [{ type: "text", text: "benchmark single 模式：编排工具未启用。" }], details: {}, isError: true };
        }
        if (planCreated) {
          return {
            content: [{ type: "text", text: "当前请求已提交执行图；不要重复规划。" }],
            details: { board: currentBoard },
          };
        }
        const raw = rawParams as {
          mode: ExecutionMode;
          returnPolicy: ReturnPolicy;
          rationale: string;
          tasks: PlannedTask[];
        };
        const params = {
          ...raw,
          tasks: raw.tasks.map((task) => ({
            ...task,
            id: task.id.trim(),
            dependsOn: [...new Set((task.dependsOn ?? []).map((id) => id.trim()))],
          })),
        };
        const ids = params.tasks.map((task) => task.id);
        const invalidDirectWorker = params.mode === "direct_worker" && params.tasks.length !== 1;
        const invalidPassthrough = params.returnPolicy === "passthrough" && (
          params.mode !== "direct_worker" || params.tasks.length !== 1 || params.tasks[0].risk !== "low"
          || params.tasks[0].requiresWrite || params.tasks[0].kind === "synthesis"
        );
        const graph = validateTaskGraph(params.tasks);
        if (new Set(ids).size !== ids.length || invalidDirectWorker || invalidPassthrough || !graph.valid) {
          return {
            content: [{
              type: "text",
              text: `执行图无效：任务 ID 必须唯一；direct_worker/passthrough 规则必须满足；${graph.errors.join("；")}`,
            }],
            details: { board: currentBoard, graph },
            isError: true,
          };
        }

        const parentContext = snapshotParentContext(
          ctx.sessionManager.getEntries(),
          ctx.sessionManager.getLeafId(),
          ctx.sessionManager.getSessionFile(),
        );
        const workers = availableWorkers(ctx, config);
        discoveredWorkerModels = workers;
        workerAvailability = workers.length ? workers.map(workerDisplayName).slice(0, 3).join("/") : "none";
        const taskById = new Map(params.tasks.map((task) => [task.id, task]));
        const effectiveTasks = params.tasks.map((task) => {
          const contextPolicy = chooseContextPolicy(task, parentContext);
          const taskContext = buildTaskContext({ ...task, contextPolicy }, parentContext, new Map());
          const dependencyTokens = (task.dependsOn ?? []).reduce(
            (sum, id) => sum + (taskById.get(id)?.estimatedOutputTokens ?? 0), 0,
          );
          return withInheritedContextCost(
            { ...task, contextPolicy },
            { ...taskContext, estimatedTokens: taskContext.estimatedTokens + dependencyTokens },
          );
        });
        // P2 economics gate: validate the Manager's decomposition against the
        // full-path cost model before committing. A rejected plan can be
        // resubmitted once (economicsOverridden) so the Manager stays the
        // proposer while the Harness acts as economic validator.
        if (!economicsOverridden && params.mode !== "direct_manager" && effectiveTasks.length > 1) {
          const split = evaluateSplit({
            rationale: params.rationale,
            directEstimatedInputTokens: Math.max(parentContext.estimatedTokens, config.routing.managerControlInputTokens),
            directEstimatedOutputTokens: Math.min(
              4000,
              800 + effectiveTasks.reduce((sum, task) => sum + task.estimatedOutputTokens, 0) * 0.6,
            ),
            parallelizable: effectiveTasks.filter((task) => !(task.dependsOn?.length)).length >= 2,
            tasks: effectiveTasks,
          }, config);
          if (!split.accepted) {
            economicsOverridden = true;
            return {
              content: [{
                type: "text",
                text: [
                  "执行图未通过分解经济学评估（全路径成本 vs Manager 直接执行）：",
                  ...split.reasons.map((reason) => `- ${reason}`),
                  "请简化任务、合并低复杂度节点，或改用 direct_manager；确认原拆分仍有必要时，可再次调用 execute_plan 覆盖本次评估。",
                ].join("\n"),
              }],
              details: { board: currentBoard, split },
              isError: true,
            };
          }
        }
        const planningInputTokens = Math.max(parentContext.estimatedTokens, config.routing.managerControlInputTokens);
        const planningCostUsd = estimateCost(
          config.manager,
          planningInputTokens,
          config.routing.managerPlanningOutputTokens,
        );
        const planningCostShareUsd = planningCostUsd / Math.max(1, effectiveTasks.length);
        const routed = effectiveTasks.map((task) => {
          const eligibleWorkers = params.mode === "direct_manager" ? [] : workers;
          const decision = routePlannedTask(task, config, ledger, eligibleWorkers, {
            returnPolicy: params.returnPolicy,
            planningCostShareUsd,
          }, routeSeed(task.id));
          recordPlanDecision(decision);
          return { task, decision };
        });

        const now = Date.now();
        currentBoard = {
          id: randomUUID(),
          prompt: activePrompt,
          rationale: params.rationale,
          createdAt: now,
          updatedAt: now,
          items: routed.map(({ task, decision }) => ({
            id: task.id,
            objective: task.objective,
            phase: task.phase?.trim() || (params.mode === "parallel" ? "DAG" : "Direct"),
            status: "pending",
            route: decision.route,
            model: decision.model.model,
            estimatedCostUsd: decision.predictedCostUsd,
            dependsOn: task.dependsOn,
            contextPolicy: task.contextPolicy as ContextPolicy,
            note: `${decision.explanation[0]}; context=${task.contextPolicy}; deps=${task.dependsOn?.join(",") || "none"}`,
          })),
        };
        planCreated = true;
        publishBoard(ctx);

        const delegationId = randomUUID();
        const controller = new AbortController();
        let orchestrator!: StageOrchestrator<(typeof routed)[number]["decision"]>;
        orchestrator = new StageOrchestrator(
          routed.map(({ task, decision }) => ({ task, decision, worker: Boolean(decision.workerRoute) })),
          graph.order,
          config.routing.maxConcurrency,
          controller.signal,
          {
            launch: ({ task, decision }) => launchRoutedTask(task, decision),
            onTransition: (taskId, status, result, error) => {
              if (!currentBoard) return;
              const routedItem = routed.find(({ task }) => task.id === taskId)!;
              if (status === "running") {
                currentBoard = updateBoardItem(currentBoard, taskId, "running", {
                  note: routedItem.decision.workerRoute
                    ? `Worker 已 ready; context=${routedItem.task.contextPolicy}`
                    : "Manager 节点已 ready",
                });
              } else if (status === "blocked") {
                currentBoard = updateBoardItem(currentBoard, taskId, "blocked", { note: "直接依赖失败，节点未启动" });
              } else if (result) {
                const actualCost = workerShadowCost(result);
                ledger.recordWorkerCall(result, actualCost);
                const ok = status === "completed";
                currentBoard = updateBoardItem(
                  currentBoard, taskId,
                  ok ? (params.returnPolicy === "passthrough" ? "completed" : "verifying") : "failed",
                  { actualCostUsd: actualCost, note: ok ? "DAG 节点完成，等待阶段屏障" : (result.error || "Worker 执行失败") },
                );
              } else if (status === "failed") {
                currentBoard = updateBoardItem(currentBoard, taskId, "failed", {
                  note: error instanceof Error ? error.message : String(error ?? "Worker 执行失败"),
                });
              }
              publishBoard(ctx);
            },
          },
        );

        // Lazy routing: plan-time decisions are tentative; the launch
        // callback re-routes with the freshest learning state and the
        // actual dependency outputs available by then.
        const launchRoutedTask = async (
          task: PlannedTask,
          planDecision: (typeof routed)[number]["decision"],
        ): Promise<WorkerResult> => {
          const eligible = params.mode === "direct_manager" ? [] : workers;
          const fresh = routePlannedTask(task, config, ledger, eligible, {
            returnPolicy: params.returnPolicy,
            planningCostShareUsd,
          }, routeSeed(task.id));
          const runPlanned = () => runWorker(
            task,
            planDecision.workerRoute!,
            ctx.cwd,
            config,
            buildTaskContext(task, parentContext, orchestrator.results),
            controller.signal,
            (progress) => publishWorkerProgress(ctx, progress),
          );
          if (fresh.route !== "manager" && fresh.workerRoute) {
            ledger.recordDecision(fresh.workerRoute, "launch", { kind: task.kind, complexity: task.complexity });
            const rerouted = fresh.model.provider !== planDecision.model.provider
              || fresh.model.model !== planDecision.model.model;
            if (rerouted && currentBoard) {
              currentBoard = updateBoardItem(currentBoard, task.id, "running", {
                model: fresh.model.model,
                note: `launch 重路由 ${planDecision.model.provider}/${planDecision.model.model} → ${fresh.model.provider}/${fresh.model.model}（最新预算/学习状态）`,
              });
              publishBoard(ctx, false);
            }
            return runWorker(
              task,
              fresh.workerRoute,
              ctx.cwd,
              config,
              buildTaskContext(task, parentContext, orchestrator.results),
              controller.signal,
              (progress) => publishWorkerProgress(ctx, progress),
            );
          }
          // Quality-margin flips at launch keep the plan-time commitment to
          // avoid thrashing.
          return runPlanned();
        };

        const stage: ActiveStage = {
          id: delegationId, returnPolicy: params.returnPolicy, tasks: effectiveTasks,
          routed, results: orchestrator.results, statuses: orchestrator.statuses,
          promise: orchestrator.promise, collected: false, controller, kick: orchestrator.kick,
        };
        activeStages.set(delegationId, stage);
        orchestrator.kick();
        onUpdate?.({
          content: [{ type: "text", text: `DAG 已提交；ready Worker 正在后台启动，阶段 ID=${delegationId}` }],
          details: { board: currentBoard, graph, delegationId },
        });
        const managerIds = routed.filter(({ decision }) => decision.route === "manager").map(({ task }) => task.id);
        return {
          content: [{
            type: "text",
            text: [
              `delegationId: ${delegationId}`,
              `DAG 已提交并立即返回；Harness 会自动激活 ready Worker 与后继节点。`,
              managerIds.length ? `Manager 节点：${managerIds.join(", ")}` : "Manager 无执行节点。",
              "完成 Manager 节点后调用 collect_stage_results；阶段结束前不会向 Manager 注入 Worker 输出。",
            ].join("\n"),
          }],
          details: {
            delegationId, passthrough: false, mode: params.mode, board: currentBoard,
            routed, graph, contextTokens: parentContext.estimatedTokens, planningCostUsd,
          },
        };
      },
    });

    pi.registerTool({
      name: "collect_stage_results",
      label: "HengFlow Stage Barrier",
      description: "Wait for the submitted DAG stage and return dependency-ordered Worker results once.",
      parameters: CollectStageSchema,
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, signal, onUpdate) {
        if (benchSingle) {
          return { content: [{ type: "text", text: "benchmark single 模式：编排工具未启用。" }], details: {}, isError: true };
        }
        const { delegationId } = rawParams as { delegationId: string };
        const stage = activeStages.get(delegationId);
        if (!stage) {
          return { content: [{ type: "text", text: "未知或已释放的 delegationId。" }], details: {}, isError: true };
        }
        if (stage.collected) {
          return { content: [{ type: "text", text: "该阶段结果已收集；不要重复调用。" }], details: {}, isError: true };
        }
        onUpdate?.({ content: [{ type: "text", text: "阶段屏障等待中；依赖节点会自动激活…" }], details: { board: currentBoard } });
        const aborted = new Promise<never>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("阶段收集已取消")), { once: true });
        });
        const results = await Promise.race([stage.promise, aborted]);
        stage.collected = true;
        const successful = results.filter((result) =>
          result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted",
        );
        if (stage.returnPolicy === "manager_synthesis" && results.length) {
          pendingDelegations.set(delegationId, new Map(results.map((result) => [result.task.id, result])));
        }
        const passthrough = stage.returnPolicy === "passthrough" && successful.length === 1;
        const text = passthrough
          ? `passthrough=true\n直接向用户返回以下 Worker 答案；不要复核、改写或总结。\n\n${successful[0].output}`
          : results.length
            ? `delegationId: ${delegationId}\n阶段已结束。请一次性综合结果；正常接受无需上报，异常才调用 report_task_outcomes。\n\n${formatWorkerResults(results)}`
            : "阶段已结束，没有 Worker 结果；请完成 Manager 项目并直接回答。";
        return {
          content: [{ type: "text", text }],
          details: { delegationId, passthrough, board: currentBoard, results },
        };
      },
    });

    pi.registerTool<typeof ReportOutcomesSchema, OutcomeReportDetails>({
      name: "report_task_outcomes",
      label: "HengFlow Learn",
      description: "Report Manager verification outcomes for delegated tasks so bounded routing statistics improve.",
      parameters: ReportOutcomesSchema,
      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        if (benchSingle) {
          return { content: [{ type: "text", text: "benchmark single 模式：编排工具未启用。" }], details: { updated: [] }, isError: true };
        }
        const params = rawParams as { delegationId: string; outcomes: TaskOutcome[] };
        const pending = pendingDelegations.get(params.delegationId);
        if (!pending) {
          return {
            content: [{ type: "text", text: "未知或已完成的 delegationId；未更新任何策略统计。" }],
            details: { updated: [] },
          };
        }
        const expected = new Set(pending.keys());
        const received = new Set(params.outcomes.map((outcome) => outcome.taskId));
        const missing = [...expected].filter((taskId) => !received.has(taskId));
        const unknown = [...received].filter((taskId) => !expected.has(taskId));
        if (missing.length || unknown.length) {
          return {
            content: [{
              type: "text",
              text: `验收集合不完整，未更新统计。missing=${missing.join(",") || "none"} unknown=${unknown.join(",") || "none"}`,
            }],
            details: { updated: [], missing, unknown },
          };
        }

        verifiedDelegations += params.outcomes.length;
        turnReworkCount += params.outcomes.filter((outcome) =>
          outcome.status === "reworked" || outcome.status === "rejected" || outcome.status === "failed").length;
        const leniencyDiscount = 1 - ledger.getLeniency(config.manager.provider, config.manager.model);
        const updated: OutcomeReportDetails["updated"] = benchFrozen || config.bench ? [] : params.outcomes.map((outcome) => {
          const result = pending.get(outcome.taskId)!;
          const profile = ledger.recordOutcome(params.delegationId, result, outcome, result.route.selected, leniencyDiscount);
          return { taskId: outcome.taskId, model: result.route.selected.model, status: outcome.status, profile };
        });
        pendingDelegations.delete(params.delegationId);
        if (currentBoard) {
          for (const outcome of params.outcomes) {
            const completed = outcome.status === "accepted" || outcome.status === "accepted_edit";
            currentBoard = updateBoardItem(
              currentBoard,
              outcome.taskId,
              completed ? "completed" : "failed",
              { note: outcome.reason || outcome.status },
            );
          }
          publishBoard(ctx);
        }
        return {
          content: [{
            type: "text",
            text: updated.length
              ? updated.map((item) =>
                `${item.taskId}: ${item.status}; ${item.model} samples=${item.profile.samples} posterior_quality=${item.profile.posteriorQuality.toFixed(3)} cost×${item.profile.costRatio.toFixed(2)}`,
              ).join("\n")
              : "冻结学习模式：验收已记录，未更新策略统计。",
          }],
          details: { updated },
        };
      },
    });

    pi.registerTool({
      name: "update_task_status",
      label: "HengFlow Task Status",
      description: "Update a material Manager Todo transition, blocker, or failure on the visible HengFlow task board.",
      parameters: UpdateTaskSchema,
      executionMode: "sequential",
      async execute(_toolCallId, rawParams, _signal, _onUpdate, ctx) {
        if (benchSingle) {
          return { content: [{ type: "text", text: "benchmark single 模式：编排工具未启用。" }], details: {}, isError: true };
        }
        const params = rawParams as { taskId: string; status: TaskStatus; note?: string };
        const item = currentBoard?.items.find((candidate) => candidate.id === params.taskId);
        if (!currentBoard || !item) {
          return {
            content: [{ type: "text", text: `任务 ${params.taskId} 不存在；请使用 execute_plan 返回的精确 ID。` }],
            details: { board: currentBoard },
            isError: true,
          };
        }
        if (item.route !== "manager" && params.status !== "blocked") {
          return {
            content: [{ type: "text", text: "Worker 项目由执行与验收事件自动更新，不能手工覆盖。" }],
            details: { board: currentBoard },
            isError: true,
          };
        }
        currentBoard = updateBoardItem(currentBoard, params.taskId, params.status, { note: params.note });
        for (const stage of activeStages.values()) {
          if (!stage.statuses.has(params.taskId)) continue;
          stage.statuses.set(params.taskId, params.status);
          stage.kick();
        }
        publishBoard(ctx);
        return {
          content: [{ type: "text", text: `${params.taskId}: ${params.status}` }],
          details: { board: currentBoard },
        };
      },
    });

    pi.registerCommand("models", {
      description: "Select and persist HengFlow Manager, Workers, and thinking levels",
      handler: async (_args, ctx) => {
        const available = ctx.modelRegistry.getAvailable()
          .map(modelRefFromRuntime)
          .sort((left, right) => left.id.localeCompare(right.id));
        if (available.length === 0) {
          ctx.ui.notify("没有已认证模型；请先执行 /login", "error");
          return;
        }

        const chooseThinking = async (
          model: ModelRef,
          current?: ModelRef["thinking"],
        ): Promise<ModelRef["thinking"] | undefined> => {
          if (model.thinking === "off") return "off";
          const levels: ModelRef["thinking"][] = ["minimal", "low", "medium", "high", "xhigh", "max"];
          const ordered = current && levels.includes(current)
            ? [current, ...levels.filter((level) => level !== current)]
            : levels;
          return await ctx.ui.select(
            `设置 ${model.provider}/${model.model} 的思考强度`,
            ordered,
          ) as ModelRef["thinking"] | undefined;
        };

        const managerOptions = available.map(
          (model) => `${model.provider}/${model.model} — ${model.label ?? model.model}`,
        );
        const managerChoice = await ctx.ui.select("选择 HengFlow Manager", managerOptions);
        if (!managerChoice) return;
        const managerIndex = managerOptions.indexOf(managerChoice);
        const managerBase = available[managerIndex];
        if (!managerBase) return;
        const managerThinking = await chooseThinking(
          managerBase,
          config.modelsConfigured
            && managerBase.provider === config.manager.provider
            && managerBase.model === config.manager.model
            ? config.manager.thinking
            : undefined,
        );
        if (!managerThinking) return;
        const manager: ModelRef = { ...managerBase, id: "manager", thinking: managerThinking };

        const workerCandidates = available.filter(
          (model) => model.provider !== manager.provider || model.model !== manager.model,
        );
        const selectedWorkers = new Map<string, ModelRef>();
        if (config.modelsConfigured) {
          for (const configured of Object.values(config.workers)) {
            const key = `${configured.provider}/${configured.model}`;
            const runtime = workerCandidates.find(
              (model) => model.provider === configured.provider && model.model === configured.model,
            );
            if (runtime) selectedWorkers.set(key, { ...runtime, ...configured, id: key });
          }
        }

        while (true) {
          const saveLabel = `保存配置（${selectedWorkers.size} 个 Worker）`;
          const workerOptions = workerCandidates.map((model) => {
            const key = `${model.provider}/${model.model}`;
            const selected = selectedWorkers.get(key);
            return `${selected ? "[x]" : "[ ]"} ${key}${selected ? `:${selected.thinking}` : ""}`;
          });
          const choice = await ctx.ui.select("选择 Worker；可重复添加、修改或移除", [saveLabel, ...workerOptions]);
          if (!choice) return;
          if (choice === saveLabel) {
            if (selectedWorkers.size > 0 || await ctx.ui.confirm(
              "不配置 Worker？",
              "HengFlow 将只使用 Manager 直接执行任务。",
            )) break;
            continue;
          }
          const candidateIndex = workerOptions.indexOf(choice);
          const candidate = workerCandidates[candidateIndex];
          if (!candidate) continue;
          const key = `${candidate.provider}/${candidate.model}`;
          const existing = selectedWorkers.get(key);
          if (existing) {
            const action = await ctx.ui.select(`修改 ${key}`, ["修改思考强度", "移除 Worker"]);
            if (action === "移除 Worker") {
              selectedWorkers.delete(key);
              continue;
            }
            if (!action) continue;
          }
          const thinking = await chooseThinking(candidate, existing?.thinking);
          if (thinking) selectedWorkers.set(key, { ...candidate, id: key, thinking });
        }

        const workers = Object.fromEntries(selectedWorkers);
        const path = saveModelSelection(manager, workers);
        config.modelsConfigured = true;
        config.manager = manager;
        config.workers = workers;
        config.pool = [manager, ...Object.values(workers)];
        const runtimeManager = ctx.modelRegistry.find(manager.provider, manager.model);
        managerReady = runtimeManager ? await pi.setModel(runtimeManager) : false;
        if (managerReady) pi.setThinkingLevel(manager.thinking);
        discoveredWorkerModels = availableWorkers(ctx, config);
        workerAvailability = discoveredWorkerModels.length
          ? discoveredWorkerModels.map(workerDisplayName).slice(0, 3).join("/")
          : "none";
        ctx.ui.notify(
          `模型配置已保存：Manager=${manager.provider}/${manager.model}:${manager.thinking}，Workers=${discoveredWorkerModels.length}；${path}`,
          managerReady ? "info" : "warning",
        );
      },
    });
    pi.registerCommand("usage", {
      description: "Show provider quota windows, local tokens and shadow cost",
      handler: async (args, ctx) => {
        ctx.ui.notify("正在刷新 HengFlow 用量…", "info");
        const reports = await fetchAllUsage(
          { getAuth: (provider: string) => ctx.modelRegistry.getProviderAuth(provider) },
          ledger,
          config.usage.cacheTtlMs,
          args.trim() === "refresh",
        );
        if (ctx.mode === "tui") {
          ctx.ui.setWidget(
            "hengflow-usage",

            (_tui, theme) => ({
              render(width: number) {
                return renderUsagePanel(reports, ledger, width).map((line, index) =>
                  index === 0 ? theme.fg("accent", theme.bold(line)) : theme.fg("dim", line),
                );
              },
              invalidate() {},
            }),
            { placement: "aboveEditor" },
          );
          ctx.ui.notify("HengFlow Usage 已刷新", "info");
        } else {
          ctx.ui.notify(renderUsagePanel(reports, ledger).join("\n"), "info");
        }
      },
    });

    pi.registerCommand("hf-status", {
      description: "Show HengFlow manager, worker authentication and routing policy",
      handler: async (_args, ctx) => {
        if (!config.modelsConfigured) {
          ctx.ui.notify("模型尚未配置。请先 /login，再执行 /models 选择 Manager、Worker 和思考强度。", "warning");
          return;
        }
        const workers = availableWorkers(ctx, config);
        const text = [
          `Manager: ${config.manager.provider}/${config.manager.model}:${config.manager.thinking}`,
          `Workers (${workers.length}): ${workers.map((worker) => `${worker.id}:${worker.thinking}`).join(", ") || "none selected or authenticated"}`,
          `Routing: margin=${(config.routing.splitImprovementMargin * 100).toFixed(0)}% concurrency=${config.routing.maxConcurrency} maxTasks=${config.routing.maxTasks} passthroughFailure≤${(config.routing.passthroughFailureLimit * 100).toFixed(0)}%`,
          `ManagerPool: ${ledger.getManagerProfiles().map((profile) => `${profile.provider}/${profile.model} ${profile.successes}/${profile.samples}`).join(", ") || "尚无轮级样本"}`,
          `Verifier: leniency=${ledger.getLeniency(config.manager.provider, config.manager.model).toFixed(2)}`,
          `Calibration: ${(() => { const c = ledger.getCalibration(); return c.pairs ? `pairs=${c.pairs} brier=${c.brierFailure.toFixed(3)} costBias=${c.costBiasRatio.toFixed(2)}` : "暂无已验收样本"; })()}`,
        ].join("\n");
        ctx.ui.notify(text, "info");
      },
    });

    pi.registerCommand("dashboard", {
      description: "Show cumulative cost and learned HengFlow routing statistics",
      handler: async (_args, ctx) => {
        ctx.ui.setWidget("hengflow-dashboard", renderDashboard(ledger, config), { placement: "aboveEditor" });
      },
    });

    pi.registerCommand("tasks", {
      description: "Show the current HengFlow Todo and routing board",
      handler: async (_args, ctx) => {
        if (!currentBoard) {
          ctx.ui.notify("当前没有 HengFlow 任务板。", "info");
          return;
        }
        const board = currentBoard;
        ctx.ui.setWidget(
          "hengflow-tasks",
          (_tui, theme) => taskBoardComponent(board, theme, "summary"),
          { placement: "aboveEditor" },
        );
      },
    });

    pi.on("agent_settled", (_event, ctx) => {
      const turnOk = lastManagerStopReason !== "error" && lastManagerStopReason !== "aborted";
      const boardFailed = Boolean(currentBoard?.items.some((item) => item.status === "failed"));
      const finalStatus = !turnOk ? "failed" : boardFailed || turnReworkCount > 0 ? "reworked" : "accepted";
      const turnDurationMs = turnStartedAt ? Date.now() - turnStartedAt : 0;
      // Exploratory write turns end on the first failure — the challenger
      // loses its allowance and the next turn re-anchors.
      if (lastManagerExploratory && (lastManagerStopReason === "error" || lastManagerStopReason === "aborted")) {
        const used = writeExploration.get(lastManagerExploratory);
        if (used) used.failures += 1;
      }
      if (config.bench) {
        ledger.recordTurnOutcome({
          turnId: `bench:${bench!.taskId ?? "task"}:${turnCounter}`,
          benchId: bench!.benchId ?? "bench",
          taskId: bench!.taskId ?? activePrompt.slice(0, 60),
          managerProvider: config.manager.provider,
          managerModel: config.manager.model,
          finalStatus,
          totalCostUsd: taskCallBaseline === undefined ? 0 : ledger.getCostBreakdown(taskCallBaseline).shadowCostUsd,
          durationMs: turnDurationMs,
          reworkCount: turnReworkCount,
        });
      }
      // Bench training defers ALL learning to the runner, which owns the
      // external judge result (confidence 1.0). In-process signals here would
      // double-count and bias the same cells.
      if (!config.bench && !benchSingle && !benchFrozen) {
        const succeeded = finalStatus === "accepted";
        ledger.recordManagerTurnOutcome(
          config.manager.provider,
          config.manager.model,
          succeeded,
          succeeded ? 1 : 0,
          turnDurationMs,
        );
        if (lastManagerExploratory && !succeeded) {
          const used = writeExploration.get(lastManagerExploratory);
          if (used) used.failures += 1;
        }
        if (verifiedDelegations > 0) {
          ledger.recordVerifierOutcome(config.manager.provider, config.manager.model, succeeded);
        }
      }
      lastManagerExploratory = undefined;
      if (currentBoard) {
        if (turnOk) {
          currentBoard = completeVerifiedWorkerTasks(currentBoard);
        }
        currentBoard = completeOpenManagerTasks(currentBoard);
        publishBoard(ctx, true, false);
      }
      clearLivePanel(ctx);
      workerProgress.clear();
      for (const [delegationId, pending] of pendingDelegations) {
        for (const result of pending.values()) {
          const ok = result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted";
          if (!ok || benchFrozen || config.bench) continue;
          ledger.recordOutcome(delegationId, result, {
            taskId: result.task.id,
            status: "accepted",
            quality: 0.8,
            confidence: 0.35,
            reason: "阶段正常结束后的保守自动回流",
          }, result.route.selected, 1 - ledger.getLeniency(config.manager.provider, config.manager.model));
        }
      }
      pendingDelegations.clear();
      for (const stage of activeStages.values()) stage.controller.abort();
      activeStages.clear();
      if (taskCallBaseline === undefined) return;
      const breakdown = ledger.getCostBreakdown(taskCallBaseline);
      lastTaskBreakdown = breakdown;
      const failed = lastManagerStopReason === "error" || lastManagerStopReason === "aborted"
        || currentBoard?.items.some((item) => item.status === "failed");
      footerPhase = failed ? "failed" : "complete";
      taskCallBaseline = undefined;
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      clearLivePanel(ctx);
      workerProgress.clear();
      for (const stage of activeStages.values()) stage.controller.abort();
      activeStages.clear();
      quotaAbort?.abort();
      await quotaRefresh;
      ledger.close();
    });
  };
}
