import type { HengFlowConfig } from "./config.js";
import type { ModelRef, TaskKind } from "./types.js";

export interface RuntimeModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  contextWindow: number;
  cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface AvailableModelRegistry {
  getAvailable(): readonly RuntimeModel[];
}

const ALL_KINDS: TaskKind[] = ["simple", "research", "coding", "long-context"];

function inferredAffinity(provider: string, model: string, contextWindow: number): TaskKind[] {
  const value = `${provider}/${model}`.toLowerCase();
  if (/haiku|flash|mini|small|deepseek/.test(value)) return ["simple", "research"];
  if (/claude|sonnet|opus|glm|coder|kimi|qwen|gpt/.test(value) || contextWindow >= 160_000) {
    return ["research", "coding", "long-context"];
  }
  return ALL_KINDS;
}

function inferredQuality(provider: string, model: string): number {
  const value = `${provider}/${model}`.toLowerCase();
  if (/opus|gpt-5|sonnet|glm-5|kimi-k2/.test(value)) return 0.88;
  if (/haiku|flash|mini|small/.test(value)) return 0.78;
  return 0.82;
}

export function modelRefFromRuntime(model: RuntimeModel): ModelRef {
  const cost = model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    model: model.id,
    label: model.name || model.id,
    thinking: model.reasoning ? "max" : "off",
    quality: inferredQuality(model.provider, model.id),
    inputUsdPerMillion: cost.input ?? 0,
    cachedInputUsdPerMillion: cost.cacheRead ?? cost.input ?? 0,
    outputUsdPerMillion: cost.output ?? 0,
    contextWindow: model.contextWindow,
    affinity: inferredAffinity(model.provider, model.id, model.contextWindow),
  };
}

/** Resolve only explicitly selected, currently authenticated Worker models. */
export function discoverWorkers(
  registry: AvailableModelRegistry,
  config: HengFlowConfig,
  scoped?: readonly { model: RuntimeModel; thinkingLevel?: string }[],
): ModelRef[] {
  if (!config.modelsConfigured) return [];
  const runtimeModels = scoped?.length ? scoped.map((entry) => entry.model) : registry.getAvailable();
  const available = new Map(runtimeModels.map((model) => [`${model.provider}/${model.id}`, model] as const));
  return Object.entries(config.workers).flatMap(([id, configured]) => {
    if (configured.provider === config.manager.provider && configured.model === config.manager.model) return [];
    const runtime = available.get(`${configured.provider}/${configured.model}`);
    return runtime ? [{ ...modelRefFromRuntime(runtime), ...configured, id }] : [];
  });
}

export function workerDisplayName(model: Pick<ModelRef, "label" | "model">): string {
  return model.label?.trim() || model.model;
}
