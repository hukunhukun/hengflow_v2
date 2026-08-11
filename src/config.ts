import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelRef } from "./types.js";

export interface HengFlowConfig {
  modelsConfigured: boolean;
  manager: ModelRef;
  /** Explicitly selected Worker models keyed by alias or `provider/model`. */
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
  };
  usage: {
    cacheTtlMs: number;
  };
}

export const DEFAULT_CONFIG: HengFlowConfig = {
  modelsConfigured: false,
  manager: {
    id: "manager",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    thinking: "medium",
    quality: 0.96,
    inputUsdPerMillion: 5,
    cachedInputUsdPerMillion: 0.5,
    outputUsdPerMillion: 30,
  },
  workers: {
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
  },
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
};

function mergeConfig(base: HengFlowConfig, value: Partial<HengFlowConfig>): HengFlowConfig {
  const workers: Record<string, ModelRef> = value.modelsConfigured && value.workers
    ? Object.fromEntries(Object.entries(value.workers).map(([id, worker]) => [id, { ...worker, id }]))
    : { ...base.workers };
  if (!value.modelsConfigured) {
    for (const [id, worker] of Object.entries(value.workers ?? {})) {
      const previous = workers[id];
      workers[id] = previous ? { ...previous, ...worker, id } : { ...worker, id };
    }
  }
  return {
    ...base,
    ...value,
    manager: { ...base.manager, ...(value.manager ?? {}) },
    workers,
    routing: { ...base.routing, ...(value.routing ?? {}) },
    usage: { ...base.usage, ...(value.usage ?? {}) },
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
