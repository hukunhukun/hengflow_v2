import type { HengFlowConfig } from "./config.js";
import { estimateCost } from "./cost.js";
import type { UsageLedger } from "./ledger.js";
import { hashSeed, SeededRandom } from "./rng.js";
import type {
  DelegatedTask,
  DelegationProposal,
  ModelRef,
  PlanRouteDecision,
  PlanRoutingOptions,
  RouteDecision,
  TaskKind,
  WorkerId,
} from "./types.js";

/**
 * Router v4: net-utility routing with Thompson sampling.
 *
 * Every candidate model w is scored in dollars:
 *   U(w) = θ̃·V − [ c_w·verbosity_w + (1−θ̃)·c_rework + c_verify ]
 * where θ̃ is a Beta posterior sample over success probability (learning),
 * V is the dollar value of one correct completion (defaults to the Manager's
 * direct cost, self-calibrating), and rework/verify are priced at the
 * *currently selected* Manager. Selection is argmax U over the Pareto
 * frontier (dominated candidates dropped). The runner-up becomes the single
 * bounded fallback. Hard safety gates live in routePlannedTask, unchanged.
 */

export interface SplitDecision {
  accepted: boolean;
  directCostUsd: number;
  splitCostUsd: number;
  improvement: number;
  reasons: string[];
}

const AFFINITY_MATCH_FACTOR = 1.08;
const AFFINITY_MISS_FACTOR = 0.92;
/** Beta prior concentration for θ̃; grows with observed samples. */
const UTILITY_PRIOR_STRENGTH = 10;

function adjustedQualityPrior(model: ModelRef, kind: TaskKind): number {
  const base = Math.min(0.99, Math.max(0.01, model.quality));
  const factor = model.affinity?.includes(kind) ? AFFINITY_MATCH_FACTOR : AFFINITY_MISS_FACTOR;
  return Math.min(0.99, base * factor);
}

export function evaluateSplit(proposal: DelegationProposal, config: HengFlowConfig): SplitDecision {
  const directCostUsd = estimateCost(
    config.manager,
    proposal.directEstimatedInputTokens,
    proposal.directEstimatedOutputTokens,
  );
  const mergeOutput = proposal.mergeEstimatedOutputTokens ?? Math.min(2500, Math.max(500, proposal.tasks.length * 500));
  let splitCostUsd = estimateCost(config.manager, proposal.directEstimatedInputTokens * 0.15, mergeOutput);
  for (const task of proposal.tasks) {
    const model = chooseStaticWorker(task, config);
    splitCostUsd += estimateCost(model, task.estimatedInputTokens, task.estimatedOutputTokens);
  }
  const improvement = directCostUsd > 0 ? (directCostUsd - splitCostUsd) / directCostUsd : -1;
  const reasons: string[] = [];

  if (proposal.tasks.length === 0) reasons.push("没有可执行子任务");
  if (proposal.tasks.length > config.routing.maxTasks) reasons.push(`子任务超过上限 ${config.routing.maxTasks}`);
  if (proposal.tasks.some((task) => task.risk === "high")) reasons.push("高风险任务必须由 Manager 直接处理");
  if (proposal.tasks.some((task) => task.requiresWrite)) reasons.push("需要写入的任务必须由 Manager 直接处理");
  if (proposal.tasks.length === 1 && proposal.tasks[0].complexity < 0.35) reasons.push("单个低复杂度子任务的编排开销过高");
  if (improvement < config.routing.splitImprovementMargin && !(proposal.parallelizable && proposal.tasks.length >= 2)) {
    reasons.push(`预计改善 ${(improvement * 100).toFixed(1)}%，低于 ${(config.routing.splitImprovementMargin * 100).toFixed(0)}% 门槛`);
  }

  return { accepted: reasons.length === 0, directCostUsd, splitCostUsd, improvement, reasons };
}

function configuredWorkers(config: HengFlowConfig): ModelRef[] {
  return Object.values(config.workers);
}

function chooseStaticWorker(task: DelegatedTask, config: HengFlowConfig): ModelRef {
  const workers = configuredWorkers(config);
  const preferred = task.preferredWorker && task.preferredWorker !== "auto"
    ? workers.find((worker) => worker.id === task.preferredWorker)
    : undefined;
  if (preferred) return preferred;
  return [...workers].sort((left, right) => {
    const leftFit = left.affinity?.includes(task.kind) ? 0.12 : 0;
    const rightFit = right.affinity?.includes(task.kind) ? 0.12 : 0;
    return (right.quality + rightFit) - (left.quality + leftFit);
  })[0] ?? config.manager;
}

function baseFailure(model: ModelRef, task: DelegatedTask): number {
  const fit = model.affinity?.includes(task.kind) ?? false;
  const qualityLoss = Math.max(0.02, 1 - model.quality);
  const complexityPenalty = task.complexity * (0.12 + qualityLoss * 0.5);
  const kindPenalty = (task.kind === "coding" || task.kind === "long-context") && !fit ? 0.1 : 0;
  return Math.min(0.75, qualityLoss * 0.45 + complexityPenalty + kindPenalty);
}

function availableModels(config: HengFlowConfig, available: Set<WorkerId> | readonly ModelRef[]): ModelRef[] {
  if (!(available instanceof Set)) return [...available];
  return configuredWorkers(config).filter((worker) => available.has(worker.id));
}

export interface UtilityRoutingOptions {
  /** Deterministic RNG; defaults to a per-task seed so plan/launch agree. */
  rng?: SeededRandom;
  /** Dollar value of one correct completion (defaults to Manager direct cost). */
  valueUsd?: number;
  /** Manager-side rework cost on worker failure (defaults to valueUsd). */
  reworkCostUsd?: number;
  /** Manager verification cost; 0 for passthrough. */
  verifyCostUsd?: number;
}

interface ScoredCandidate {
  model: ModelRef;
  theta: number;
  predictedCostUsd: number;
  failure: number;
  utility: number;
  paretoDominated: boolean;
  learned: ReturnType<UsageLedger["getLearnedProfile"]>;
}

/** Drop candidates strictly dominated on (quality, cost, failure) posterior means. */
function paretoFilter(candidates: ScoredCandidate[]): ScoredCandidate[] {
  return candidates.map((candidate) => ({
    ...candidate,
    paretoDominated: candidates.some((other) =>
      other !== candidate
      && other.learned.posteriorQuality >= candidate.learned.posteriorQuality
      && other.predictedCostUsd <= candidate.predictedCostUsd
      && other.failure <= candidate.failure
      && (other.learned.posteriorQuality > candidate.learned.posteriorQuality
        || other.predictedCostUsd < candidate.predictedCostUsd
        || other.failure < candidate.failure)),
  }));
}

export function routeTask(
  task: DelegatedTask,
  config: HengFlowConfig,
  ledger: UsageLedger,
  availableWorkers: Set<WorkerId> | readonly ModelRef[],
  options: UtilityRoutingOptions = {},
): RouteDecision {
  const candidates = availableModels(config, availableWorkers);
  if (candidates.length === 0) throw new Error("没有已认证且可用的 Worker 模型；请先登录任意受支持的模型提供方");

  const rng = options.rng ?? new SeededRandom(hashSeed("route", task.id));
  const valueUsd = options.valueUsd
    ?? estimateCost(config.manager, task.estimatedInputTokens, task.estimatedOutputTokens);
  const reworkCostUsd = options.reworkCostUsd ?? valueUsd;
  const verifyCostUsd = options.verifyCostUsd ?? 0;
  const preferred = task.preferredWorker && task.preferredWorker !== "auto" ? task.preferredWorker : undefined;

  const scored = paretoFilter(candidates.map((model): ScoredCandidate => {
    const staticFail = baseFailure(model, task);
    const learned = ledger.getLearnedProfile(task, model, staticFail);
    const predictedCostUsd = estimateCost(model, task.estimatedInputTokens, task.estimatedOutputTokens)
      * Math.max(0.25, learned.costRatio);
    // Moment-matched Beta: mean = posterior quality, concentration grows with samples.
    const concentration = UTILITY_PRIOR_STRENGTH + learned.samples;
    const priorMean = learned.samples > 0
      ? learned.posteriorQuality
      : adjustedQualityPrior(model, task.kind);
    const alpha = Math.max(0.1, priorMean * concentration);
    const beta = Math.max(0.1, (1 - priorMean) * concentration);
    const theta = rng.beta(alpha, beta);
    const preferenceBonus = preferred === model.id ? 0.15 * valueUsd : 0;
    const utility = theta * valueUsd
      - (predictedCostUsd + (1 - theta) * reworkCostUsd + verifyCostUsd)
      + preferenceBonus;
    return { model, theta, predictedCostUsd, failure: learned.failureProbability, utility, paretoDominated: false, learned };
  }));

  const eligible = scored.filter((candidate) => !candidate.paretoDominated || scored.length === 1);
  const ranked = eligible.sort((left, right) => right.utility - left.utility);
  // Benchmark fixed-mapping policy: forced kind→worker mapping wins outright
  // (hard gates still apply upstream in routePlannedTask).
  const forcedId = config.routing.forcedWorkerByKind?.[task.kind];
  const forcedEntry = forcedId ? ranked.find((entry) => entry.model.id === forcedId) : undefined;
  // If the preferred worker was dominated, still honor it (advisory, bounded).
  const preferredEntry = preferred ? ranked.find((entry) => entry.model.id === preferred) : undefined;
  const selected = forcedEntry ?? preferredEntry ?? ranked[0];
  const fallback = ranked.find((entry) => entry !== selected);

  const explanation = [
    `任务类型=${task.kind}，复杂度=${task.complexity.toFixed(2)}`,
    `任务价值 V=$${valueUsd.toFixed(5)}，TS 抽样成功率=${(selected.theta * 100).toFixed(1)}%`,
    `全路径预测=$${(selected.predictedCostUsd + (1 - selected.theta) * reworkCostUsd + verifyCostUsd).toFixed(5)}（执行=$${selected.predictedCostUsd.toFixed(5)}）`,
    `净效用=$${selected.utility.toFixed(5)}`,
  ];
  if (selected.learned.samples > 0) {
    explanation.push(
      `已学习同类样本=${selected.learned.samples}，后验质量=${selected.learned.posteriorQuality.toFixed(3)}，成本倍率=${selected.learned.costRatio.toFixed(2)}`,
    );
  } else {
    explanation.push("尚无同类验收样本，使用亲和度调整先验");
  }
  if (selected.paretoDominated) explanation.push("候选被帕累托支配但为指定选择");
  if (forcedEntry) explanation.push(`固定映射=${forcedId}`);
  if (preferred && selected.model.id === preferred) explanation.push(`Manager 指定偏好=${preferred}`);
  if (fallback) explanation.push(`失败时仅降级一次到 ${fallback.model.provider}/${fallback.model.model}`);
  if (fallback?.learned.samples) {
    explanation.push(
      `备选模型同类样本=${fallback.learned.samples}，后验质量=${fallback.learned.posteriorQuality.toFixed(3)}`,
    );
  }

  return {
    taskId: task.id,
    selected: selected.model,
    fallback: fallback?.model,
    score: selected.utility,
    predictedCostUsd: selected.predictedCostUsd,
    predictedFailureProbability: selected.failure,
    explanation,
  };
}

/**
 * Route every planned item, including the Manager option. Safety constraints
 * are hard gates; learned Worker utilities only operate inside those boundaries.
 */
export function routePlannedTask(
  task: DelegatedTask,
  config: HengFlowConfig,
  ledger: UsageLedger,
  availableWorkers: Set<WorkerId> | readonly ModelRef[],
  options: PlanRoutingOptions = { returnPolicy: "manager_synthesis" },
  rng?: SeededRandom,
): PlanRouteDecision {
  const directExecutionCostUsd = estimateCost(
    config.manager,
    task.estimatedInputTokens,
    task.estimatedOutputTokens,
  );
  const planningCostShareUsd = options.planningCostShareUsd ?? 0;
  const directCostUsd = planningCostShareUsd + directExecutionCostUsd;
  const manager = (reason: string): PlanRouteDecision => ({
    taskId: task.id,
    route: "manager",
    model: config.manager,
    directCostUsd,
    predictedCostUsd: directCostUsd,
    orchestrationCostUsd: planningCostShareUsd,
    expectedReworkCostUsd: 0,
    explanation: [reason, `Manager 全路径预计成本=$${directCostUsd.toFixed(5)}`],
  });

  if (task.risk === "high") return manager("高风险任务由 Manager 保留");
  if (task.requiresWrite) return manager("任务需要修改文件或外部状态，当前只读 Worker 不可执行");
  if (task.kind === "synthesis") return manager("最终综合与责任判断由 Manager 保留");
  const workerPool = availableModels(config, availableWorkers);
  if (workerPool.length === 0) return manager("没有已认证 Worker，回退 Manager");

  const verificationInput = Math.min(1_600, Math.max(250, task.estimatedOutputTokens));
  const verificationOutput = Math.min(350, Math.max(120, task.estimatedOutputTokens * 0.2));
  const verificationCost = options.returnPolicy === "manager_synthesis"
    ? estimateCost(config.manager, verificationInput, verificationOutput)
    : 0;

  const workerRoute = routeTask(task, config, ledger, availableWorkers, {
    rng,
    valueUsd: directExecutionCostUsd,
    reworkCostUsd: directExecutionCostUsd,
    verifyCostUsd: verificationCost,
  });
  const expectedReworkCostUsd = workerRoute.predictedFailureProbability * directExecutionCostUsd;
  const orchestrationCostUsd = planningCostShareUsd + verificationCost;
  const delegatedCostUsd = orchestrationCostUsd + workerRoute.predictedCostUsd + expectedReworkCostUsd;
  const delegatedFutureCostUsd = verificationCost + workerRoute.predictedCostUsd + expectedReworkCostUsd;
  const improvement = directExecutionCostUsd > 0
    ? (directExecutionCostUsd - delegatedFutureCostUsd) / directExecutionCostUsd
    : -1;

  const failureLimit = options.returnPolicy === "passthrough" ? config.routing.passthroughFailureLimit : 0.42;
  if (workerRoute.predictedFailureProbability > failureLimit) {
    return manager(`Worker 预计失败率 ${(workerRoute.predictedFailureProbability * 100).toFixed(1)}% 超过安全门槛`);
  }
  if (improvement < config.routing.splitImprovementMargin) {
    return manager(
      `委派预计改善 ${(improvement * 100).toFixed(1)}%，低于 ${(config.routing.splitImprovementMargin * 100).toFixed(0)}% 门槛`,
    );
  }

  return {
    taskId: task.id,
    route: workerRoute.selected.id as WorkerId,
    model: workerRoute.selected,
    workerRoute,
    directCostUsd,
    predictedCostUsd: delegatedCostUsd,
    orchestrationCostUsd,
    expectedReworkCostUsd,
    explanation: [
      `委派预计改善 ${(improvement * 100).toFixed(1)}%（策略=${options.returnPolicy}）`,
      `全路径=$${delegatedCostUsd.toFixed(5)}，编排=$${orchestrationCostUsd.toFixed(5)}，期望返工=$${expectedReworkCostUsd.toFixed(5)}`,
      ...workerRoute.explanation,
    ],
  };
}
