import type { HengFlowConfig } from "./config.js";
import type { BudgetWindowState, UsageLedger } from "./ledger.js";
import type { ModelRef } from "./types.js";

/**
 * Time-serial budget pacing for the router.
 *
 * Each registered scope (session, provider:<p>) owns a window with a USD limit.
 * Spend is always derived from model_calls (single source of truth); only the
 * non-derivable accumulators (debt Q_t, shadow-price multiplier) persist.
 *
 * Debt follows the virtual-queue update:
 *   Q_{t+1} = max(0, Q_t + spend_delta - rho_t * dt),  rho_t = B_remaining / T_remaining
 *
 * The cost term of the routing score is scaled by
 *   lambda_t = 1 + kappa * min(1, Q_t / (0.1 * limit))
 * so an over-pace window makes dollars more expensive instead of silently
 * rejecting work. Hard feasibility (cost <= remaining budget) is a separate
 * explicit check used for the degrade chain:
 *   cheaper worker -> manager direct -> node blocked with user notification.
 */
export interface BudgetScopeSpec {
  scope: string;
  limitUsd: number;
  durationMs: number;
  provider?: string;
}

export interface FeasibilityResult {
  feasible: boolean;
  reason?: string;
  scopes: Array<{ scope: string; spentUsd: number; remainingUsd: number }>;
}

export interface BudgetSnapshotRow {
  scope: string;
  limitUsd: number;
  spentUsd: number;
  debtUsd: number;
  lambdaMultiplier: number;
  timeToResetMs: number;
}

const DEBT_FULL_EFFECT_RATIO = 0.1;
const SESSION_WINDOW_MS = 6 * 60 * 60 * 1000;
const PROVIDER_WINDOW_MS = 24 * 60 * 60 * 1000;
const ADMISSION_POLL_MS = 5_000;

export class BudgetController {
  private readonly specs = new Map<string, BudgetScopeSpec>();

  constructor(
    public readonly ledger: UsageLedger,
    private readonly config: HengFlowConfig,
  ) {}

  registerSession(limitUsd: number): void {
    this.specs.set("session", { scope: "session", limitUsd, durationMs: SESSION_WINDOW_MS });
    this.window("session");
  }

  registerProvider(provider: string, limitUsd: number): void {
    this.specs.set(`provider:${provider}`, {
      scope: `provider:${provider}`,
      limitUsd,
      durationMs: PROVIDER_WINDOW_MS,
      provider,
    });
    this.window(`provider:${provider}`);
  }

  /** Provider scopes relevant to a model (empty when no per-provider limit is set). */
  providerScopeFor(model: ModelRef): string | undefined {
    const scope = `provider:${model.provider}`;
    return this.specs.has(scope) ? scope : undefined;
  }

  /** All scopes a routed call charges against: session plus the model's provider window. */
  scopesFor(model: ModelRef): string[] {
    const scopes = this.specs.has("session") ? ["session"] : [];
    const providerScope = this.providerScopeFor(model);
    if (providerScope) scopes.push(providerScope);
    return scopes;
  }

  /** Load-or-init a window, rolling it over when the reset boundary passed. */
  window(scope: string, now = Date.now()): BudgetWindowState {
    const spec = this.specs.get(scope);
    if (!spec) throw new Error(`Unknown budget scope: ${scope}`);
    const existing = this.ledger.getBudgetWindow(scope);
    if (!existing || now >= existing.resetAt || existing.limitUsd !== spec.limitUsd) {
      const state: BudgetWindowState = {
        scope,
        limitUsd: spec.limitUsd,
        windowStart: now,
        resetAt: now + spec.durationMs,
        debtUsd: 0,
        lambdaMultiplier: 1,
        lastAdvancedAt: now,
        lastSpentUsd: 0,
      };
      this.ledger.upsertBudgetWindow(state);
      return state;
    }
    return existing;
  }

  /** Advance the virtual queue and recompute the shadow-price multiplier. */
  advance(scope: string, now = Date.now()): BudgetWindowState {
    const spec = this.specs.get(scope);
    if (!spec || spec.limitUsd <= 0) {
      return {
        scope, limitUsd: spec?.limitUsd ?? 0, windowStart: now, resetAt: now,
        debtUsd: 0, lambdaMultiplier: 1, lastAdvancedAt: now, lastSpentUsd: 0,
      };
    }
    const state = this.window(scope, now);
    const spent = this.ledger.getSpendSince(state.windowStart, spec.provider);
    const budgetRemaining = Math.max(0, spec.limitUsd - spent);
    const timeRemainingMs = Math.max(1, state.resetAt - now);
    const rhoPerMs = budgetRemaining / timeRemainingMs;
    const spendDelta = spent - state.lastSpentUsd;
    const debt = Math.min(
      spec.limitUsd,
      Math.max(0, state.debtUsd + spendDelta - rhoPerMs * (now - state.lastAdvancedAt)),
    );
    const lambda = 1 + this.config.budget.lambdaKappa
      * Math.min(1, debt / (DEBT_FULL_EFFECT_RATIO * spec.limitUsd));
    const next: BudgetWindowState = {
      ...state,
      debtUsd: debt,
      lambdaMultiplier: lambda,
      lastAdvancedAt: now,
      lastSpentUsd: spent,
    };
    this.ledger.upsertBudgetWindow(next);
    return next;
  }

  advanceTracked(now = Date.now()): void {
    for (const spec of this.specs.values()) {
      if (spec.limitUsd > 0) this.advance(spec.scope, now);
    }
  }

  /** Combined cost multiplier for a model: session lambda x provider lambda. */
  multiplierForModel(model: ModelRef, now = Date.now()): number {
    let multiplier = 1;
    for (const scope of this.scopesFor(model)) {
      multiplier *= this.advance(scope, now).lambdaMultiplier;
    }
    return multiplier;
  }

  /** Hard feasibility: does costUsd fit in every tracked window with a limit? */
  checkFeasibility(costUsd: number, scopes: string[], now = Date.now()): FeasibilityResult {
    const details: FeasibilityResult["scopes"] = [];
    for (const scope of scopes) {
      const spec = this.specs.get(scope);
      if (!spec || spec.limitUsd <= 0) continue;
      const state = this.window(scope, now);
      const spent = this.ledger.getSpendSince(state.windowStart, spec.provider);
      const remaining = Math.max(0, spec.limitUsd - spent);
      details.push({ scope, spentUsd: spent, remainingUsd: remaining });
      if (!this.config.budget.hardFeasibility) continue;
      if (costUsd > remaining) {
        return {
          feasible: false,
          reason: `${scope} 预算不可行：剩余 $${remaining.toFixed(4)} < 需求 $${costUsd.toFixed(4)}`,
          scopes: details,
        };
      }
    }
    return { feasible: true, scopes: details };
  }

  /** Bounded single deferral: wait while lambda is above the admission threshold. */
  async waitForAdmission(scopes: string[], signal?: AbortSignal, now = Date.now()): Promise<void> {
    const threshold = this.config.budget.admissionLambdaThreshold;
    const maxWaitMs = this.config.budget.admissionMaxWaitMs;
    if (threshold <= 0 || maxWaitMs <= 0) return;
    const deadline = now + maxWaitMs;
    while (Date.now() < deadline && !signal?.aborted) {
      let worst = 1;
      for (const scope of scopes) {
        const spec = this.specs.get(scope);
        if (!spec || spec.limitUsd <= 0) continue;
        worst = Math.max(worst, this.advance(scope, Date.now()).lambdaMultiplier);
      }
      if (worst < threshold) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, ADMISSION_POLL_MS);
        timer.unref?.();
      });
    }
  }

  snapshot(now = Date.now()): BudgetSnapshotRow[] {
    const rows: BudgetSnapshotRow[] = [];
    for (const spec of this.specs.values()) {
      if (spec.limitUsd <= 0) continue;
      const state = this.advance(spec.scope, now);
      rows.push({
        scope: spec.scope,
        limitUsd: spec.limitUsd,
        spentUsd: state.lastSpentUsd,
        debtUsd: state.debtUsd,
        lambdaMultiplier: state.lambdaMultiplier,
        timeToResetMs: Math.max(0, state.resetAt - now),
      });
    }
    return rows;
  }
}
