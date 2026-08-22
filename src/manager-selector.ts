import { estimateCost } from "./cost.js";
import type { SeededRandom } from "./rng.js";
import type { ModelRef } from "./types.js";

/**
 * Level-1 bandit: per-turn Manager selection over the configured pool.
 *
 * Thompson sampling over Beta posteriors (success-rate per model, bootstrapped
 * from the shared ledger), gated by a write-eligibility check, stabilized by a
 * champion-challenger hysteresis with an explicit prefix-cache switch cost.
 * The pool anchor is always eligible and acts as the safety floor.
 */

export interface ManagerProfile {
  model: ModelRef;
  /** Observed calls attributed to this model as manager (any kind). */
  samples: number;
  /** Semantically successful calls among samples. */
  successes: number;
}

export interface ManagerSelectionInput {
  /** Authenticated pool; first entry is the anchor (safety floor). */
  pool: ModelRef[];
  /** Keyed by `${provider}/${model}`; missing entries use cold priors. */
  profiles?: ReadonlyMap<string, ManagerProfile>;
  /** Turn-level risk classification: write/high-risk turns restrict eligibility. */
  requiresWrite?: boolean;
  /** Inherited session tokens; drives the prefix-cache switch cost. */
  sessionHistoryTokens?: number;
  /** Incumbent manager id (`provider/model`) from the previous turn. */
  championId?: string;
  /** Deterministic RNG; bench runs fix the seed. */
  rng: SeededRandom;
  /** Samples required before a non-anchor model may take write turns. */
  minWriteSamples?: number;
  /** Bootstrap allowance: total exploratory write turns for a 0-sample challenger. */
  maxExploratoryWriteTurns?: number;
  /** Bookkeeping state for the exploratory allowance (mutated by the selector). */
  explorationLedger?: Map<string, { turns: number; failures: number }>;
  planningInputTokensFloor?: number;
  planningOutputTokens?: number;
  /** Extra hysteresis margin (USD) a challenger must beat. */
  hysteresisUsd?: number;
}

export interface ManagerCandidateDraw {
  id: string;
  theta: number;
  utilityUsd: number;
  planningCostUsd: number;
  switchCostUsd: number;
  samples: number;
  eligible: boolean;
}

export interface ManagerSelection {
  selected: ModelRef;
  selectedId: string;
  anchorId: string;
  isAnchor: boolean;
  switched: boolean;
  /** Sampled utility of the selected model (already includes switch cost). */
  sampledUtilityUsd: number;
  planningCostUsd: number;
  failureProbability: number;
  nextChampionId: string;
  /** True when this pick consumed an exploratory write allowance. */
  exploratory: boolean;
  reason: string;
  draws: ManagerCandidateDraw[];
}

export const MANAGER_PRIOR_STRENGTH = 2;
export const MAX_EXPLORATORY_WRITE_TURNS = 2;

export function managerKey(model: Pick<ModelRef, "provider" | "model">): string {
  return `${model.provider}/${model.model}`;
}

function posteriorBeta(profile: ManagerProfile | undefined, model: ModelRef): { alpha: number; beta: number } {
  const priorQuality = Math.min(0.99, Math.max(0.01, model.quality));
  const samples = Math.min(profile?.samples ?? 0, 10_000);
  const successes = Math.min(profile?.successes ?? 0, samples);
  return {
    alpha: MANAGER_PRIOR_STRENGTH * priorQuality + successes,
    beta: MANAGER_PRIOR_STRENGTH * (1 - priorQuality) + (samples - successes),
  };
}

function posteriorFailure(profile: ManagerProfile | undefined, model: ModelRef): number {
  const { alpha, beta } = posteriorBeta(profile, model);
  return Math.min(0.95, Math.max(0.005, beta / (alpha + beta)));
}

export function selectManager(input: ManagerSelectionInput): ManagerSelection {
  const {
    pool,
    profiles,
    requiresWrite = false,
    sessionHistoryTokens = 0,
    championId,
    rng,
    minWriteSamples = 3,
    maxExploratoryWriteTurns = MAX_EXPLORATORY_WRITE_TURNS,
    explorationLedger = new Map<string, { turns: number; failures: number }>(),
    planningInputTokensFloor = 1_000,
    planningOutputTokens = 500,
    hysteresisUsd = 0.002,
  } = input;

  if (pool.length < 2) {
    throw new Error("HengFlow v4 需要至少 2 个已认证模型组成 Manager 池");
  }
  const anchor = pool[0];
  const anchorId = managerKey(anchor);
  const planningInputTokens = Math.max(sessionHistoryTokens, planningInputTokensFloor);
  // Turn value scale: what one successful turn is worth, anchored to the
  // anchor model's own planning cost (self-calibrating, dollar-denominated).
  const valueUsd = estimateCost(anchor, planningInputTokens, planningOutputTokens);
  const profileOf = (model: ModelRef): ManagerProfile | undefined =>
    profiles?.get(managerKey(model));

  // Bootstrap allowance: a challenger with fewer than minWriteSamples may
  // serve at most `maxExploratoryWriteTurns` exploratory write turns, and
  // loses the allowance after its first failed exploratory turn. This breaks
  // the cold-start deadlock (needs samples to write, needs to write for
  // samples) while keeping the safety floor: any failure immediately
  // re-anchors.
  const exploratoryLeft = (id: string): boolean => {
    const used = explorationLedger.get(id);
    if (!used) return maxExploratoryWriteTurns > 0;
    return used.turns < maxExploratoryWriteTurns && used.failures === 0;
  };

  const draws: ManagerCandidateDraw[] = pool.map((model) => {
    const id = managerKey(model);
    const profile = profileOf(model);
    const writeEligible = (profile?.samples ?? 0) >= minWriteSamples
      || (maxExploratoryWriteTurns > 0 && (profile?.samples ?? 0) < minWriteSamples && exploratoryLeft(id));
    const eligible = !requiresWrite || id === anchorId || writeEligible;
    const { alpha, beta } = posteriorBeta(profile, model);
    const theta = rng.beta(alpha, beta);
    const planningCostUsd = estimateCost(model, planningInputTokens, planningOutputTokens);
    const switchCostUsd = championId && id !== championId
      ? (sessionHistoryTokens * (pool.find((m) => managerKey(m) === championId)?.cachedInputUsdPerMillion ?? 0)) / 1_000_000
      : 0;
    const utilityUsd = eligible
      ? theta * valueUsd - planningCostUsd - switchCostUsd
      : Number.NEGATIVE_INFINITY;
    return { id, theta, utilityUsd, planningCostUsd, switchCostUsd, samples: profile?.samples ?? 0, eligible };
  });

  const winner = draws.reduce((best, draw) => (draw.utilityUsd > best.utilityUsd ? draw : best));
  const champion = championId ? draws.find((draw) => draw.id === championId) : undefined;
  // Hysteresis: the challenger must beat the incumbent champion by the
  // explicit margin (switch cost + hysteresis are already inside utility).
  const selectedDraw = champion && champion.eligible && champion.id !== winner.id
    && winner.utilityUsd - champion.utilityUsd < hysteresisUsd
    ? champion
    : winner;
  const selected = pool.find((model) => managerKey(model) === selectedDraw.id)!;
  const switched = Boolean(championId) && selectedDraw.id !== championId;
  const exploratory = requiresWrite && !selectedDraw.id.startsWith(anchorId)
    && (profiles?.get(selectedDraw.id)?.samples ?? 0) < minWriteSamples;
  if (exploratory) {
    const used = explorationLedger.get(selectedDraw.id) ?? { turns: 0, failures: 0 };
    used.turns += 1;
    explorationLedger.set(selectedDraw.id, used);
  }

  const profile = profileOf(selected);
  const reason = [
    `manager=${selected.provider}/${selected.model}${selectedDraw.id === anchorId ? "（锚点）" : ""}`,
    `TS 效用=$${selectedDraw.utilityUsd.toFixed(5)}`,
    `样本=${profile?.samples ?? 0}（成功 ${profile?.successes ?? 0}）`,
    requiresWrite ? `写入轮=是${exploratory ? "（引导探索）" : ""}` : "写入轮=否",
    championId ? `冠军=${championId}${switched ? "→切换" : "→保持"}` : "首轮",
  ].join("; ");

  return {
    selected,
    selectedId: selectedDraw.id,
    anchorId,
    isAnchor: selectedDraw.id === anchorId,
    switched,
    sampledUtilityUsd: selectedDraw.utilityUsd,
    planningCostUsd: selectedDraw.planningCostUsd,
    failureProbability: posteriorFailure(profile, selected),
    nextChampionId: selectedDraw.id,
    exploratory,
    reason,
    draws,
  };
}
