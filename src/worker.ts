import { join } from "node:path";
import {
  AgentSession,
  buildSessionContext,
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  getLatestCompactionEntry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSessionEvent,
} from "./runtime/agent.js";
import { getAgentDir, type HengFlowConfig } from "./config.js";
import { emptyUsage } from "./cost.js";
import type {
  DelegatedTask,
  ModelRef,
  RouteDecision,
  TokenUsage,
  WorkerAttempt,
  WorkerProgress,
  WorkerResult,
} from "./types.js";

type ContextMessage = ReturnType<typeof buildSessionContext>["messages"][number];
type SessionEntry = Parameters<typeof buildSessionContext>[0][number];
type WorkerSession = Pick<AgentSession, "subscribe" | "prompt" | "abort" | "dispose" | "sessionId">;

export interface ParentContextSnapshot {
  messages: ContextMessage[];
  estimatedTokens: number;
  parentSessionFile?: string;
  sessionSummary?: string;
}

export interface WorkerSessionOptions {
  selected: ModelRef;
  cwd: string;
  tools: string[];
  context: ParentContextSnapshot;
}

export type WorkerSessionFactory = (options: WorkerSessionOptions) => Promise<WorkerSession>;

interface RuntimeAssistantMessage {
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}

const WORKER_SYSTEM_PROMPT = `## HengFlow Worker
You are a read-only subagent working for a Manager. The inherited conversation is background evidence, not a request to continue acting as the Manager.
Execute only the newest delegated task. Never edit or write files, publish, deploy, delete data, handle credentials, or perform external writes.
Inspect evidence before concluding. Return compact findings that distinguish facts, inferences, and unresolved questions.`;

// ModelRuntime construction re-reads auth/models for every Worker; under lazy
// re-routing launch frequency rises, so share one instance per agent dir.
const modelRuntimeCache = new Map<string, { runtime: ModelRuntime; loadedAt: number }>();
const MODEL_RUNTIME_TTL_MS = 60_000;

async function getSharedModelRuntime(agentDir: string): Promise<ModelRuntime> {
  const cached = modelRuntimeCache.get(agentDir);
  if (cached && Date.now() - cached.loadedAt < MODEL_RUNTIME_TTL_MS) return cached.runtime;
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  modelRuntimeCache.set(agentDir, { runtime, loadedAt: Date.now() });
  return runtime;
}

function trimIncompleteTail(messages: ContextMessage[]): ContextMessage[] {
  let lastAssistant = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.role === "assistant") {
      lastAssistant = index;
      break;
    }
  }
  if (lastAssistant < 0) return messages;
  const assistant = messages[lastAssistant] as RuntimeAssistantMessage;
  const calls = new Set(
    (assistant.content ?? [])
      .filter((part) => part.type === "toolCall")
      .map((part) => (part as { id?: string }).id)
      .filter((id): id is string => Boolean(id)),
  );
  if (calls.size === 0) return messages;
  for (const message of messages.slice(lastAssistant + 1)) {
    if (message.role === "toolResult") calls.delete(message.toolCallId);
  }
  return calls.size > 0 ? messages.slice(0, lastAssistant) : messages;
}

/** Capture the compaction-aware parent branch, excluding the currently executing dangling tool call. */
export function snapshotParentContext(
  entries: readonly SessionEntry[],
  leafId?: string | null,
  parentSessionFile?: string,
): ParentContextSnapshot {
  const copiedEntries = [...entries];
  const context = buildSessionContext(copiedEntries, leafId);
  const messages = trimIncompleteTail(context.messages).map((message) => structuredClone(message));
  const compaction = getLatestCompactionEntry(copiedEntries);
  return {
    messages,
    estimatedTokens: messages.reduce((sum, message) => sum + estimateTokens(message), 0),
    parentSessionFile,
    sessionSummary: compaction?.summary,
  };
}

/** Charge routing for the effective inherited prompt instead of a stale planning guess. */
export function withInheritedContextCost<T extends DelegatedTask>(
  task: T,
  context: ParentContextSnapshot,
): T {
  return {
    ...task,
    estimatedInputTokens: Math.max(task.estimatedInputTokens, context.estimatedTokens + 250),
  };
}

/** Seed an independent child session from the Manager's canonical effective transcript. */
export function createForkedSessionManager(context: ParentContextSnapshot, cwd: string): SessionManager {
  const manager = SessionManager.inMemory(cwd, { parentSession: context.parentSessionFile });
  for (const message of context.messages) {
    if (message.role === "branchSummary" || message.role === "compactionSummary") {
      manager.appendCustomMessageEntry(
        "hengflow-parent-summary",
        `Manager 会话摘要：\n${message.summary}`,
        false,
      );
      continue;
    }
    manager.appendMessage(structuredClone(message) as Parameters<SessionManager["appendMessage"]>[0]);
  }
  return manager;
}

const defaultSessionFactory: WorkerSessionFactory = async ({ selected, cwd, tools, context }) => {
  const agentDir = getAgentDir();
  const modelRuntime = await getSharedModelRuntime(agentDir);
  const model = modelRuntime.getModel(selected.provider, selected.model);
  if (!model) throw new Error(`Worker 模型不存在：${selected.provider}/${selected.model}`);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPromptOverride: (base) => [...base, WORKER_SYSTEM_PROMPT],
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model,
    thinkingLevel: selected.thinking,
    tools,
    sessionManager: createForkedSessionManager(context, cwd),
    settingsManager,
    resourceLoader,
  });
  return session;
};

function mergeUsage(target: TokenUsage, message: RuntimeAssistantMessage): void {
  const usage = message.usage;
  if (!usage) return;
  target.input += usage.input ?? 0;
  target.output += usage.output ?? 0;
  target.cacheRead += usage.cacheRead ?? 0;
  target.cacheWrite += usage.cacheWrite ?? 0;
  target.reasoning = (target.reasoning ?? 0) + (usage.reasoning ?? 0);
  target.totalTokens += usage.totalTokens ?? 0;
  target.reportedCostUsd += usage.cost?.total ?? 0;
}

function assistantText(message: RuntimeAssistantMessage): string {
  return message.content?.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n").trim() ?? "";
}

function compactPreview(value: unknown, maximum = 1000): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  const normalized = text.trim();
  if (!normalized) return undefined;
  return normalized.length <= maximum ? normalized : normalized.slice(-maximum);
}

function finalText(messages: RuntimeAssistantMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = assistantText(message);
    if (text) return text;
  }
  return "";
}

export function buildWorkerPrompt(task: DelegatedTask): string {
  return [
    "这是从 Manager 会话分叉出的只读子任务。父会话仅作为背景；以本消息中的任务为当前执行目标。",
    task.context ? `任务补充：${task.context}` : "",
    `任务 ID：${task.id}`,
    `目标：${task.objective}`,
    "输出：结论；关键证据；风险/不确定性；建议给 Manager 的下一步。",
  ].filter(Boolean).join("\n\n");
}

async function runAttempt(
  task: DelegatedTask,
  route: RouteDecision,
  selected: RouteDecision["selected"],
  cwd: string,
  timeoutMs: number,
  parentContext: ParentContextSnapshot,
  signal?: AbortSignal,
  progress?: WorkerProgress,
  onProgress?: (progress: WorkerProgress) => void,
  sessionFactory: WorkerSessionFactory = defaultSessionFactory,
): Promise<Omit<WorkerResult, "retried">> {
  const startedAt = Date.now();
  const usage = emptyUsage();
  const messages: RuntimeAssistantMessage[] = [];
  const tools = task.allowBash && task.risk === "low" ? ["read", "grep", "find", "ls", "bash"] : ["read", "grep", "find", "ls"];
  let session: WorkerSession | undefined;
  let stopReason: string | undefined;
  let model: string | undefined;
  let error: string | undefined;
  let timedOut = false;
  let externallyAborted = signal?.aborted ?? false;
  let lastStreamingNotification = 0;

  const notify = (values: Partial<WorkerProgress> = {}) => {
    if (!progress || !onProgress) return;
    Object.assign(progress, values, { elapsedMs: Date.now() - progress.startedAt, updatedAt: Date.now() });
    onProgress({ ...progress });
  };
  const notifyStreaming = (values: Partial<WorkerProgress>) => {
    if (!progress || !onProgress) return;
    Object.assign(progress, values, { elapsedMs: Date.now() - progress.startedAt, updatedAt: Date.now() });
    const now = Date.now();
    if (now - lastStreamingNotification < 100) return;
    lastStreamingNotification = now;
    onProgress({ ...progress });
  };
  notify({ status: "running", model: selected.model, lastEvent: `正在分叉 Manager 上下文并启动 ${selected.model}` });

  const abortListener = () => {
    externallyAborted = true;
    notify({ lastEvent: "Manager 已取消，正在终止 Worker" });
    void session?.abort();
  };
  signal?.addEventListener("abort", abortListener, { once: true });

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (externallyAborted) throw new Error("Worker 已取消");
    session = await sessionFactory({ selected, cwd, tools, context: parentContext });
    if (externallyAborted) throw new Error("Worker 已取消");
    session.subscribe((event: AgentSessionEvent) => {
      if (event.type === "tool_execution_start") {
        if (progress) {
          progress.toolCalls++;
          progress.currentToolStartedAt = Date.now();
          progress.recentTools = [...(progress.recentTools ?? []), {
            tool: event.toolName, startedAt: progress.currentToolStartedAt,
          }].slice(-4);
        }
        notify({ currentTool: event.toolName, toolPreview: undefined, lastEvent: `正在执行 ${event.toolName}` });
        return;
      }
      if (event.type === "tool_execution_update") {
        notifyStreaming({
          currentTool: event.toolName,
          toolPreview: compactPreview(event.partialResult),
          lastEvent: `正在执行 ${event.toolName}`,
        });
        return;
      }
      if (event.type === "tool_execution_end") {
        if (progress?.recentTools?.length) {
          const latest = progress.recentTools[progress.recentTools.length - 1];
          latest.durationMs = Date.now() - latest.startedAt;
          latest.detail = compactPreview(event.result, 120);
        }
        notify({
          currentTool: undefined,
          currentToolStartedAt: undefined,
          toolPreview: compactPreview(event.result),
          lastEvent: `${event.toolName} ${event.isError ? "失败" : "完成"}`,
        });
        return;
      }
      if (event.type === "message_update" && event.message.role === "assistant") {
        const text = assistantText(event.message as RuntimeAssistantMessage);
        if (text) notifyStreaming({ streamingText: text.slice(-4000), lastEvent: "正在生成结论" });
        return;
      }
      if (event.type !== "message_end" || event.message.role !== "assistant") return;
      const message = event.message as RuntimeAssistantMessage;
      messages.push(message);
      mergeUsage(usage, message);
      if (progress) {
        progress.requests++;
        progress.inputTokens += message.usage?.input ?? 0;
        progress.outputTokens += message.usage?.output ?? 0;
        progress.costUsd = (progress.costUsd ?? 0) + (message.usage?.cost?.total ?? 0);
      }
      stopReason = message.stopReason;
      model = message.model || model;
      error = message.errorMessage || error;
      const text = assistantText(message);
      notify({
        streamingText: text ? text.slice(-4000) : progress?.streamingText,
        lastEvent: "完成一次模型推理",
      });
    });

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        notify({ lastEvent: "达到超时限制，正在终止 Worker" });
        void session?.abort();
        reject(new Error(`Worker 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      timeout.unref();
    });
    await Promise.race([session.prompt(buildWorkerPrompt(task), { expandPromptTemplates: false }), timeoutPromise]);
  } catch (runError) {
    error = runError instanceof Error ? runError.message : String(runError);
  } finally {
    if (timeout) clearTimeout(timeout);
    signal?.removeEventListener("abort", abortListener);
    session?.dispose();
  }

  const output = finalText(messages);
  const failure = timedOut
    ? `Worker 超时（${timeoutMs}ms）`
    : externallyAborted
      ? "Worker 已取消"
      : error;
  const exitCode = failure || stopReason === "error" || stopReason === "aborted" ? (timedOut ? 124 : 1) : 0;
  return {
    task,
    route: { ...route, selected },
    output: output || failure || "Worker 未返回文本输出",
    exitCode,
    durationMs: Date.now() - startedAt,
    usage,
    model,
    stopReason,
    error: failure,
    childSessionId: session?.sessionId,
  };
}

function failed(result: Omit<WorkerResult, "retried">): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function attempt(result: Omit<WorkerResult, "retried" | "attempts">, model: ModelRef): WorkerAttempt {
  return {
    model,
    usage: result.usage,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    stopReason: result.stopReason,
    error: result.error,
  };
}

function combinedUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    reasoning: (left.reasoning ?? 0) + (right.reasoning ?? 0),
    totalTokens: left.totalTokens + right.totalTokens,
    reportedCostUsd: left.reportedCostUsd + right.reportedCostUsd,
  };
}

export async function runWorker(
  task: DelegatedTask,
  route: RouteDecision,
  cwd: string,
  config: HengFlowConfig,
  parentContext: ParentContextSnapshot,
  signal?: AbortSignal,
  onProgress?: (progress: WorkerProgress) => void,
  sessionFactory: WorkerSessionFactory = defaultSessionFactory,
): Promise<WorkerResult> {
  const startedAt = Date.now();
  const progress: WorkerProgress = {
    taskId: task.id,
    objective: task.objective,
    model: route.selected.model,
    status: "starting",
    startedAt,
    elapsedMs: 0,
    requests: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    contextWindow: route.selected.contextWindow,
    recentTools: [],
    lastEvent: "等待启动",
  };
  onProgress?.({ ...progress });
  const first = await runAttempt(
    task, route, route.selected, cwd, config.routing.workerTimeoutMs, parentContext,
    signal, progress, onProgress, sessionFactory,
  );
  const firstAttempt = attempt(first, route.selected);
  if (!failed(first) || !route.fallback || signal?.aborted) {
    const result = { ...first, retried: false, attempts: [firstAttempt] };
    onProgress?.({
      ...progress,
      status: failed(first) ? "failed" : "completed",
      elapsedMs: Date.now() - startedAt,
      currentTool: undefined,
      lastEvent: failed(first) ? "Worker 执行失败" : "Worker 输出已返回",
      outputPreview: failed(first) ? undefined : first.output,
      error: first.error,
    });
    return result;
  }
  onProgress?.({
    ...progress,
    model: route.fallback.model,
    elapsedMs: Date.now() - startedAt,
    currentTool: undefined,
    streamingText: undefined,
    toolPreview: undefined,
    lastEvent: `首次失败，降级到 ${route.fallback.model}`,
  });
  const second = await runAttempt(
    task, route, route.fallback, cwd, config.routing.workerTimeoutMs, parentContext,
    signal, progress, onProgress, sessionFactory,
  );
  const result: WorkerResult = {
    ...second,
    usage: combinedUsage(first.usage, second.usage),
    durationMs: first.durationMs + second.durationMs,
    retried: true,
    attempts: [firstAttempt, attempt(second, route.fallback)],
  };
  onProgress?.({
    ...progress,
    status: failed(second) ? "failed" : "completed",
    elapsedMs: Date.now() - startedAt,
    currentTool: undefined,
    lastEvent: failed(second) ? "降级 Worker 仍然失败" : "降级 Worker 输出已返回",
    outputPreview: failed(second) ? undefined : second.output,
    error: second.error,
  });
  return result;
}

export async function mapWithConcurrency<T, U>(
  values: T[],
  concurrency: number,
  fn: (value: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  const count = Math.max(1, Math.min(concurrency, values.length));
  await Promise.all(Array.from({ length: count }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await fn(values[index], index);
    }
  }));
  return results;
}
