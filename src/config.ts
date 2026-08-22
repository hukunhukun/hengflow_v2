import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelRef, TaskKind } from "./types.js";

/** Benchmark-run overrides consumed by the extension for variant behavior. */
export interface BenchRunConfig {
  variant: "single" | "fixed_mapping" | "learned" | "learned_frozen";
  /** `provider/model` for the single variant. */
  singleModel?: string;
  /** kind → worker id (`provider/model`) for fixed_mapping. */
  fixedMapping?: Partial<Record<TaskKind, string>>;
  /** Skip all learning writes (learned_frozen). */
  freezeLearning?: boolean;
  /** Fixed RNG seed base for reproducible routing. */
  seed?: number;
  benchId?: string;
  taskId?: string;
}

export interface HengFlowConfig {
  modelsConfigured: boolean;
  /** v4 canonical: learned-manager pool; first entry is the anchor. */
  pool: ModelRef[];
  /** Derived from pool[0] for backward compatibility. */
  manager: ModelRef;
  /** Derived: pool minus the anchor, keyed by `provider/model`. */
  workers: Record<string, ModelRef>;
  routing: {
    maxConcurrency: number;
    splitImprovementMargin: number;
    qualityWeight: number;
    costWeight: number;
    latencyWeight: number;
    failureWeight: number;
    quotaWeight: number;
    maxTasks: number;
    managerControlInputTokens: number;
    managerPlanningOutputTokens: number;
    passthroughFailureLimit: number;
    workerTimeoutMs: number;
    explorationWeight: number;
    explorationMinSamples: number;
    explorationBudgetUsd: number;
    /** Benchmark fixed-mapping policy; absent in normal operation. */
    forcedWorkerByKind?: Partial<Record<TaskKind, string>>;
  };
  /** Present only during benchmark runs. */
  bench?: BenchRunConfig;
  usage: {
    cacheTtlMs: number;
  };
  budget: {
    /** Session-scoped hard cap in USD; 0 disables session budgeting. */
    sessionUsdLimit: number;
    /** Optional per-provider rolling-day caps in USD, e.g. { "deepseek": 5 }. */
    providerLimitsUsd: Record<string, number>;
    /** Lambda sensitivity: multiplier reaches 1+kappa when debt hits 10% of the window limit. */
    lambdaKappa: number;
    /** When true, routing hard-rejects options that cannot fit the remaining window budget. */
    hardFeasibility: boolean;
    /** Defer non-critical Worker launches while lambda exceeds this multiplier; 0 disables. */
    admissionLambdaThreshold: number;
    /** Bounded single deferral window for admission control. */
    admissionMaxWaitMs: number;
  };
}

const DEFAULT_MANAGER: ModelRef = {
  id: "manager",
  provider: "openai-codex",
  model: "gpt-5.6-sol",
  thinking: "medium",
  quality: 0.96,
  inputUsdPerMillion: 5,
  cachedInputUsdPerMillion: 0.5,
  outputUsdPerMillion: 30,
};

const DEFAULT_WORKERS: Record<string, ModelRef> = {
  deepseek: {
    id: "deepseek",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    thinking: "max",
    quality: 0.79,
    inputUsdPerMillion: 0.14,
    cachedInputUsdPerMillion: 0.0028,
    outputUsdPerMillion: 0.28,
    contextWindow: 128_000,
    affinity: ["simple"],
  },
  glm: {
    id: "glm",
    provider: "zai-coding-cn",
    model: "glm-5.2",
    thinking: "max",
    quality: 0.87,
    inputUsdPerMillion: 1.4,
    cachedInputUsdPerMillion: 0.26,
    outputUsdPerMillion: 4.4,
    contextWindow: 200_000,
    affinity: ["research", "coding", "long-context"],
  },
};

function canonicalPoolId(model: ModelRef): string {
  return model.id && model.id !== "manager" ? model.id : `${model.provider}/${model.model}`;
}

export const DEFAULT_CONFIG: HengFlowConfig = {
  modelsConfigured: false,
  pool: [DEFAULT_MANAGER, ...Object.values(DEFAULT_WORKERS).map((worker) => ({ ...worker, id: canonicalPoolId(worker) }))],
  manager: DEFAULT_MANAGER,
  workers: { ...DEFAULT_WORKERS },
  routing: {
    maxConcurrency: 3,
    splitImprovementMargin: 0.15,
    qualityWeight: 8,
    costWeight: 12,
    latencyWeight: 0.15,
    failureWeight: 3,
    quotaWeight: 2.5,
    maxTasks: 8,
    managerControlInputTokens: 6_000,
    managerPlanningOutputTokens: 300,
    passthroughFailureLimit: 0.28,
    workerTimeoutMs: 10 * 60 * 1000,
    explorationWeight: 1.5,
    explorationMinSamples: 4,
    explorationBudgetUsd: 0.02,
  },
  usage: {
    cacheTtlMs: 5 * 60 * 1000,
  },
  budget: {
    sessionUsdLimit: 0,
    providerLimitsUsd: {},
    lambdaKappa: 2,
    hardFeasibility: true,
    admissionLambdaThreshold: 2.5,
    admissionMaxWaitMs: 30_000,
  },
};

/** Fold legacy manager/workers and v4 pool entries into one deduped pool. */
function normalizePool(base: ModelRef[], value: Partial<HengFlowConfig>): ModelRef[] {
  const source = value.pool && value.pool.length
    ? value.pool
    : value.manager || value.workers
      ? [value.manager ?? base[0], ...Object.values(value.workers ?? {})]
      : base;
  const seen = new Set<string>();
  const pool: ModelRef[] = [];
  for (const entry of source) {
    if (!entry?.provider || !entry.model) continue;
    const key = `${entry.provider}/${entry.model}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pool.push({ ...entry, id: canonicalPoolId(entry) });
  }
  return pool;
}

function mergeConfig(base: HengFlowConfig, value: Partial<HengFlowConfig>): HengFlowConfig {
  const pool = normalizePool(base.pool, value);
  let manager = pool[0] ?? base.manager;
  // Bench single variant: the measured model serves as the launch manager.
  const singleId = value.bench?.variant === "single" ? value.bench.singleModel : undefined;
  if (singleId) {
    const single = pool.find((model) => `${model.provider}/${model.model}` === singleId);
    if (single) manager = single;
  }
  const workers = Object.fromEntries(pool.slice(1).map((model) => [model.id, model]));
  return {
    ...base,
    ...value,
    manager,
    workers,
    pool,
    routing: { ...base.routing, ...(value.routing ?? {}) },
    usage: { ...base.usage, ...(value.usage ?? {}) },
    budget: { ...base.budget, ...(value.budget ?? {}) },
    bench: value.bench ?? base.bench,
  };
}

/** HengFlow owns its runtime data; no separately installed host CLI is required. */
export function getAgentDir(): string {
  return process.env.HENGFLOW_AGENT_DIR || join(homedir(), ".hengflow", "agent");
}

export function getDataDir(): string {
  return process.env.HENGFLOW_DATA_DIR || process.env.HENGFLOW_V2_DATA_DIR || join(getAgentDir(), "data");
}

export function loadConfig(cwd = process.cwd()): HengFlowConfig {
  let config = structuredClone(DEFAULT_CONFIG);
  const paths = [join(getAgentDir(), "config.json"), join(resolve(cwd), ".hengflow", "config.json")];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<HengFlowConfig>;
    config = mergeConfig(config, parsed);
  }
  return config;
}

/** Persist the v4 learned-manager pool (first entry = anchor). Requires >= 2 distinct models. */
export function savePoolSelection(pool: ModelRef[], agentDir = getAgentDir()): string {
  if (pool.length < 2) {
    throw new Error("HengFlow v4 需要至少 2 个模型组成池（首位为锚点）");
  }
  const seen = new Set<string>();
  const normalized = pool.map((entry) => {
    if (!entry?.provider || !entry.model) throw new Error("池中存在不完整的模型条目");
    const key = `${entry.provider}/${entry.model}`;
    if (seen.has(key)) throw new Error(`池中存在重复模型 ${key}`);
    seen.add(key);
    if (
      !(entry.inputUsdPerMillion >= 0) || !(entry.outputUsdPerMillion >= 0)
      || !(entry.cachedInputUsdPerMillion >= 0)
    ) {
      throw new Error(`${key} 缺少有效价格（每百万 Token 美元）`);
    }
    return { ...entry, id: canonicalPoolId(entry) };
  });
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "config.json");
  const existing = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    : {};
  const next = { ...existing, modelsConfigured: true, pool: normalized };
  const temp = `${path}.hengflow-tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return path;
}

export function saveModelSelection(
  manager: ModelRef,
  workers: Record<string, ModelRef>,
  agentDir = getAgentDir(),
): string {
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "config.json");
  const existing = existsSync(path)
    ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
    : {};
  const selectedWorkers = Object.fromEntries(
    Object.entries(workers).map(([id, worker]) => [id, { ...worker, id }]),
  );
  const next = { ...existing, modelsConfigured: true, manager: { ...manager, id: "manager" }, workers: selectedWorkers };
  const temp = `${path}.hengflow-tmp`;
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  chmodSync(path, 0o600);
  return path;
}
