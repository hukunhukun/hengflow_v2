import type { HengFlowConfig } from "./config.js";
import type { BudgetController } from "./budget-controller.js";
import { estimateCost } from "./cost.js";
import type { UsageLedger } from "./ledger.js";
import type {
  DelegatedTask,
  DelegationProposal,
  ModelRef,
  PlanRouteDecision,
  PlanRoutingOptions,
  RouteDecision,
  WorkerId,
} from "./types.js";

export interface ExplorationState {
  spentUsd: number;
  selections: number;
}

export interface SplitDecision {
  accepted: boolean;
  directCostUsd: number;
  splitCostUsd: number;
  improvement: number;
  reasons: string[];
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

function historicalExecutionFailure(ledger: UsageLedger, model: ModelRef, fallback: number): number {
  const stats = ledger.getModelStats().find((item) => item.provider === model.provider && item.model === model.model);
  if (!stats || stats.calls < 3) return fallback;
  return Math.min(0.9, Math.max(0.01, 1 - stats.successRate));
}

export function routeTask(
  task: DelegatedTask,
  config: HengFlowConfig,
  ledger: UsageLedger,
  availableWorkers: Set<WorkerId> | readonly ModelRef[],
  exploration?: ExplorationState,
  budget?: BudgetController,
): RouteDecision {
  const candidates = availableModels(config, availableWorkers);
  if (candidates.length === 0) throw new Error("没有已认证且可用的 Worker 模型；请先登录任意受支持的模型提供方");

  const preferred = task.preferredWorker && task.preferredWorker !== "auto" ? task.preferredWorker : undefined;
  const explorationAllowed = Boolean(
    exploration && task.risk === "low" && !task.requiresWrite && !preferred
      && exploration.spentUsd < config.routing.explorationBudgetUsd,
  );
  // Hard-feasibility pre-filter: drop candidates whose provider window cannot
  // fit this call, as long as at least one feasible candidate remains. When
  // every candidate is infeasible, keep them all so routePlannedTask can
  // degrade the whole delegation to the Manager.
  let scoredCandidates = candidates;
  if (budget && config.budget.hardFeasibility) {
    const feasible = candidates.filter((model) =>
      budget.checkFeasibility(estimateCost(model, task.estimatedInputTokens, task.estimatedOutputTokens)
        * ledger.getLearnedProfile(task, model, 0.1).costRatio, budget.scopesFor(model)).feasible);
    if (feasible.length > 0) scoredCandidates = feasible;
  }
  const scored = scoredCandidates.map((model) => {
    const id = model.id as WorkerId;
    const staticPredictedCostUsd = estimateCost(model, task.estimatedInputTokens, task.estimatedOutputTokens);
    const staticFail = baseFailure(model, task);
    const executionFailure = historicalExecutionFailure(ledger, model, staticFail);
    const learned = ledger.getLearnedProfile(task, model, executionFailure);
    const predictedCostUsd = staticPredictedCostUsd * learned.costRatio;
    const failure = learned.failureProbability;
    const quotaPressure = ledger.getQuotaPressure(model.provider);
    // Shadow price: over-pace budget windows make this candidate's dollars
    // proportionally more expensive instead of a fixed costWeight.
    const lambdaMultiplier = budget ? budget.multiplierForModel(model) : 1;
    const latencyPenalty = learned.samples > 0
      ? Math.min(2, learned.latencyMs / 60_000)
      : task.estimatedInputTokens / 1_000_000;
    const qualityLoss = Math.max(
      0,
      1 - learned.posteriorQuality + task.complexity * Math.max(0.03, (1 - model.quality) * 0.35),
    );
    const preferenceBonus = preferred === id ? -1.5 : 0;
    const affinityBonus = model.affinity?.includes(task.kind)
      ? (task.kind === "simple" ? -1.2 : -0.6)
      : 0;
    const economyBonus = task.kind === "simple" && task.complexity < 0.45
      ? -Math.min(1, 0.1 / Math.max(0.001, staticPredictedCostUsd)) * 0.2 : 0;
    const potential = Math.max(0, config.routing.explorationMinSamples - learned.samples);
    const cheapestColdModel = [...candidates].sort((left, right) =>
      estimateCost(left, task.estimatedInputTokens, task.estimatedOutputTokens)
      - estimateCost(right, task.estimatedInputTokens, task.estimatedOutputTokens))[0];
    const explorationBonus = explorationAllowed && id === cheapestColdModel?.id
      && staticPredictedCostUsd <= config.routing.explorationBudgetUsd - (exploration?.spentUsd ?? 0)
      ? config.routing.explorationWeight * potential / Math.max(1, config.routing.explorationMinSamples)
      : 0;
    const exploitationScore =
      config.routing.qualityWeight * qualityLoss +
      config.routing.costWeight * lambdaMultiplier * predictedCostUsd +
      config.routing.failureWeight * failure +
      config.routing.quotaWeight * quotaPressure +
      config.routing.latencyWeight * latencyPenalty +
      preferenceBonus + affinityBonus + economyBonus;
    const score = exploitationScore - explorationBonus;
    return { model, predictedCostUsd, failure, quotaPressure, score, exploitationScore, explorationBonus, potential, learned };
  }).sort((left, right) => left.score - right.score);

  const selected = scored[0];
  const fallback = scored[1];
  const exploitSelected = [...scored].sort((left, right) => left.exploitationScore - right.exploitationScore)[0];
  const explored = selected.model.id !== exploitSelected.model.id && selected.explorationBonus > 0;
  if (explored && exploration) {
    exploration.spentUsd += selected.predictedCostUsd;
    exploration.selections++;
  }
  const explanation = [
    `任务类型=${task.kind}，复杂度=${task.complexity.toFixed(2)}`,
    `预计影子成本=$${selected.predictedCostUsd.toFixed(5)}`,
    `预计失败率=${(selected.failure * 100).toFixed(1)}%`,
    `当前额度压力=${(selected.quotaPressure * 100).toFixed(1)}%`,
  ];
  if (selected.learned.samples > 0) {
    explanation.push(
      `已学习同类样本=${selected.learned.samples}，后验质量=${selected.learned.posteriorQuality.toFixed(3)}，成本倍率=${selected.learned.costRatio.toFixed(2)}`,
    );
  } else {
    explanation.push("尚无同类验收样本，使用冷启动先验");
  }
  if (budget) {
    const lambda = budget.multiplierForModel(selected.model);
    if (lambda > 1.01) explanation.push(`预算影子价格×${lambda.toFixed(2)}（超速窗口内美元变贵）`);
  }
  if (explored) {
    explanation.push(
      `有限探索=on，样本缺口=${selected.potential}，预算累计=$${exploration!.spentUsd.toFixed(5)}`,
    );
  }
  if (preferred) explanation.push(`Manager 指定偏好=${preferred}`);
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
    score: selected.score,
    predictedCostUsd: selected.predictedCostUsd,
    predictedFailureProbability: selected.failure,
    explanation,
  };
}

/**
 * Route every planned item, including the Manager option. Safety constraints
 * are hard gates; learned Worker scores only operate inside those boundaries.
 */
export function routePlannedTask(
  task: DelegatedTask,
  config: HengFlowConfig,
  ledger: UsageLedger,
  availableWorkers: Set<WorkerId> | readonly ModelRef[],
  options: PlanRoutingOptions = { returnPolicy: "manager_synthesis" },
  exploration?: ExplorationState,
  budget?: BudgetController,
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
  if (availableModels(config, availableWorkers).length === 0) return manager("没有已认证 Worker，回退 Manager");

  const workerRoute = routeTask(task, config, ledger, availableWorkers, exploration, budget);
  const verificationInput = Math.min(1_600, Math.max(250, task.estimatedOutputTokens));
  const verificationOutput = Math.min(350, Math.max(120, task.estimatedOutputTokens * 0.2));
  const verificationCost = options.returnPolicy === "manager_synthesis"
    ? estimateCost(config.manager, verificationInput, verificationOutput)
    : 0;
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
  if (budget) {
    const feasibility = budget.checkFeasibility(delegatedCostUsd, budget.scopesFor(workerRoute.selected));
    if (!feasibility.feasible) {
      return manager(`预算不可行（${feasibility.reason}）；已降级为 Manager 直接执行`);
    }
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
