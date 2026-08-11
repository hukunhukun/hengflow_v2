export type Risk = "low" | "medium" | "high";
export type TaskKind = "simple" | "research" | "coding" | "long-context" | "synthesis";
export type WorkerId = string;
export type TaskRoute = "manager" | WorkerId;
export type ExecutionMode = "direct_manager" | "direct_worker" | "parallel";
export type ReturnPolicy = "passthrough" | "manager_synthesis";
export type ContextPolicy = "latest_turn" | "dependency_outputs" | "session_summary" | "full_fork";
export type TaskStatus = "pending" | "running" | "verifying" | "completed" | "blocked" | "failed";

export interface ModelRef {
  id: WorkerId | "manager";
  provider: string;
  model: string;
  label?: string;
  thinking: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  quality: number;
  inputUsdPerMillion: number;
  cachedInputUsdPerMillion: number;
  outputUsdPerMillion: number;
  contextWindow?: number;
  affinity?: TaskKind[];
}

export interface DelegatedTask {
  id: string;
  objective: string;
  kind: TaskKind;
  risk: Risk;
  complexity: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  context?: string;
  /** Worker id (`provider/model`) or a configured worker alias. */
  preferredWorker?: "auto" | WorkerId;
  allowBash?: boolean;
  requiresWrite?: boolean;
  /** Direct predecessors in the execution graph. */
  dependsOn?: string[];
  /** Optional override; the Harness chooses a bounded policy when omitted. */
  contextPolicy?: ContextPolicy;
}

export interface PlannedTask extends DelegatedTask {
  phase?: string;
}

export interface TaskBoardItem {
  id: string;
  objective: string;
  phase: string;
  status: TaskStatus;
  route: TaskRoute;
  model: string;
  estimatedCostUsd: number;
  actualCostUsd?: number;
  note?: string;
  dependsOn?: string[];
  contextPolicy?: ContextPolicy;
}

export interface TaskBoard {
  id: string;
  prompt: string;
  rationale: string;
  createdAt: number;
  updatedAt: number;
  items: TaskBoardItem[];
}

export interface PlanRouteDecision {
  taskId: string;
  route: TaskRoute;
  model: ModelRef;
  workerRoute?: RouteDecision;
  directCostUsd: number;
  predictedCostUsd: number;
  orchestrationCostUsd: number;
  expectedReworkCostUsd: number;
  explanation: string[];
}

export interface PlanRoutingOptions {
  returnPolicy: ReturnPolicy;
  planningCostShareUsd?: number;
}

export interface DelegationProposal {
  rationale: string;
  directEstimatedInputTokens: number;
  directEstimatedOutputTokens: number;
  mergeEstimatedOutputTokens?: number;
  parallelizable?: boolean;
  expectedQualityGain?: number;
  tasks: DelegatedTask[];
}

export interface RouteDecision {
  taskId: string;
  selected: ModelRef;
  fallback?: ModelRef;
  score: number;
  predictedCostUsd: number;
  predictedFailureProbability: number;
  explanation: string[];
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  reportedCostUsd: number;
}

export interface WorkerResult {
  task: DelegatedTask;
  route: RouteDecision;
  output: string;
  exitCode: number;
  durationMs: number;
  usage: TokenUsage;
  model?: string;
  stopReason?: string;
  error?: string;
  childSessionId?: string;
  retried: boolean;
  attempts?: WorkerAttempt[];
}

export interface WorkerAttempt {
  model: ModelRef;
  usage: TokenUsage;
  durationMs: number;
  exitCode: number;
  stopReason?: string;
  error?: string;
}

export interface WorkerProgress {
  taskId: string;
  objective: string;
  model: string;
  status: "starting" | "running" | "completed" | "failed";
  startedAt: number;
  elapsedMs: number;
  requests: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  currentTool?: string;
  currentToolStartedAt?: number;
  recentTools?: Array<{ tool: string; detail?: string; startedAt: number; durationMs?: number }>;
  costUsd?: number;
  contextTokens?: number;
  contextWindow?: number;
  lastEvent?: string;
  /** Latest assistant text observed from message_update, capped by the Worker runner. */
  streamingText?: string;
  /** Latest partial tool output, used until assistant text is available. */
  toolPreview?: string;
  outputPreview?: string;
  updatedAt?: number;
  error?: string;
}

export type OutcomeStatus = "accepted" | "accepted_edit" | "reworked" | "rejected" | "failed";

export interface TaskOutcome {
  taskId: string;
  status: OutcomeStatus;
  quality: number;
  confidence: number;
  reason?: string;
}

export interface LearnedProfile {
  samples: number;
  posteriorQuality: number;
  failureProbability: number;
  costRatio: number;
  latencyMs: number;
}

export interface CostBreakdownRow {
  role: "manager" | "worker";
  provider: string;
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  reportedCostUsd: number;
  shadowCostUsd: number;
}

export interface CostBreakdown {
  rows: CostBreakdownRow[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  reportedCostUsd: number;
  shadowCostUsd: number;
}

export interface QuotaLimit {
  id: string;
  label: string;
  used?: number;
  remaining?: number;
  limit?: number;
  unit: "percent" | "tokens" | "requests" | "money";
  currency?: string;
  resetAt?: number;
}

export interface QuotaReport {
  provider: string;
  fetchedAt: number;
  source: "official-api" | "provider-private-api" | "response-headers" | "local-ledger";
  limits: QuotaLimit[];
  note?: string;
  error?: string;
}
