/**
 * Benchmark foundation: fixed price tables, per-call cost recomputation,
 * variant definitions, and result/summary records.
 *
 * Bench accounting is deliberately independent from the live ledger shadow
 * costs: every run recomputes cost from raw token usage against a frozen
 * price table so cross-variant and cross-model comparisons stay fair.
 */

export interface BenchPriceEntry {
  inputUsdPerMillion: number;
  /** Falls back to inputUsdPerMillion when absent. */
  cacheReadUsdPerMillion?: number;
  outputUsdPerMillion: number;
}

/** Keyed by `${provider}/${model}`. */
export type BenchPriceTable = Record<string, BenchPriceEntry>;

export type BenchVariant =
  | { kind: "single"; model: string }
  | { kind: "fixed_mapping" }
  | { kind: "learned" }
  | { kind: "learned_frozen" };

export interface BenchCallUsage {
  role: "manager" | "worker";
  provider: string;
  model: string;
  inputTokens: number;
  cacheReadTokens: number;
  /** Recorded but excluded from main cost (no implicit cache-write pricing). */
  cacheWriteTokens: number;
  outputTokens: number;
}

export interface BenchResultRecord {
  runId: string;
  benchId: string;
  taskId: string;
  variant: BenchVariant;
  repeat: number;
  seed?: number;
  startedAt: string;
  endedAt: string;
  resolved: boolean;
  durationMs: number;
  totalCostUsd: number;
  cacheWriteTokens: number;
  calls: BenchCallUsage[];
}

export function variantLabel(variant: BenchVariant): string {
  return variant.kind === "single" ? `single:${variant.model}` : variant.kind;
}

/** Canonical price-table key. */
export function priceKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/** Recompute one call's cost from the frozen price table (USD). */
export function benchCallCostUsd(call: BenchCallUsage, table: BenchPriceTable): number {
  const price = table[priceKey(call.provider, call.model)];
  if (!price) return 0;
  const cacheRead = Math.max(0, Math.min(call.cacheReadTokens, call.inputTokens));
  const uncachedInput = Math.max(0, call.inputTokens - cacheRead);
  return (
    uncachedInput * price.inputUsdPerMillion
    + cacheRead * (price.cacheReadUsdPerMillion ?? price.inputUsdPerMillion)
    + call.outputTokens * price.outputUsdPerMillion
  ) / 1_000_000;
}

export interface BenchCostSummary {
  totalUsd: number;
  cacheWriteTokens: number;
  unpriced: string[];
}

export function benchTotalCostUsd(calls: readonly BenchCallUsage[], table: BenchPriceTable): BenchCostSummary {
  let totalUsd = 0;
  let cacheWriteTokens = 0;
  const unpriced = new Set<string>();
  for (const call of calls) {
    const key = priceKey(call.provider, call.model);
    if (!table[key]) unpriced.add(key);
    totalUsd += benchCallCostUsd(call, table);
    cacheWriteTokens += call.cacheWriteTokens;
  }
  return { totalUsd, cacheWriteTokens, unpriced: [...unpriced].sort() };
}

export interface BenchVariantSummary {
  variant: string;
  runs: number;
  resolvedRuns: number;
  resolvedRate: number;
  meanCostUsd: number;
  totalCostUsd: number;
  /** totalCost / resolvedRuns; Infinity when nothing resolved. */
  costPerResolvedUsd: number;
  /** resolvedRuns per dollar; 0 when total cost is zero. */
  successesPerDollar: number;
}

export function summarizeBenchRuns(runs: readonly BenchResultRecord[]): BenchVariantSummary[] {
  const groups = new Map<string, BenchResultRecord[]>();
  for (const run of runs) {
    const label = variantLabel(run.variant);
    const bucket = groups.get(label) ?? [];
    bucket.push(run);
    groups.set(label, bucket);
  }
  return [...groups.entries()].map(([variant, bucket]) => {
    const resolvedRuns = bucket.filter((run) => run.resolved).length;
    const totalCostUsd = bucket.reduce((sum, run) => sum + run.totalCostUsd, 0);
    return {
      variant,
      runs: bucket.length,
      resolvedRuns,
      resolvedRate: bucket.length ? resolvedRuns / bucket.length : 0,
      meanCostUsd: bucket.length ? totalCostUsd / bucket.length : 0,
      totalCostUsd,
      costPerResolvedUsd: resolvedRuns > 0 ? totalCostUsd / resolvedRuns : Number.POSITIVE_INFINITY,
      successesPerDollar: totalCostUsd > 0 ? resolvedRuns / totalCostUsd : 0,
    };
  }).sort((left, right) => left.variant.localeCompare(right.variant));
}

/** Wilson score interval for a binomial proportion (for small-sample reports). */
export function wilsonInterval(successes: number, total: number, z = 1.96): { low: number; high: number } {
  if (total <= 0) return { low: 0, high: 0 };
  const phat = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = (phat + z2 / (2 * total)) / denominator;
  const spread = z * Math.sqrt((phat * (1 - phat) + z2 / (4 * total)) / total) / denominator;
  return { low: Math.max(0, center - spread), high: Math.min(1, center + spread) };
}
