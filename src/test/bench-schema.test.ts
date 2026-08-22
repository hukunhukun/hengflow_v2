import assert from "node:assert/strict";
import test from "node:test";
import {
  benchCallCostUsd,
  benchTotalCostUsd,
  priceKey,
  summarizeBenchRuns,
  variantLabel,
  wilsonInterval,
  type BenchPriceTable,
  type BenchResultRecord,
} from "../bench/schema.js";

const table: BenchPriceTable = {
  "openai-codex/gpt-5.6-sol": { inputUsdPerMillion: 5, cacheReadUsdPerMillion: 0.5, outputUsdPerMillion: 30 },
  "deepseek/deepseek-v4-flash": { inputUsdPerMillion: 0.14, cacheReadUsdPerMillion: 0.0028, outputUsdPerMillion: 0.28 },
  "zai-coding-cn/no-cache-price": { inputUsdPerMillion: 1.4, outputUsdPerMillion: 4.4 },
};

test("cost formula matches the benchmark price contract", () => {
  const cost = benchCallCostUsd({
    role: "manager", provider: "openai-codex", model: "gpt-5.6-sol",
    inputTokens: 1_000_000, cacheReadTokens: 200_000, cacheWriteTokens: 50_000, outputTokens: 100_000,
  }, table);
  // (800k*5 + 200k*0.5 + 100k*30) / 1e6 = 7.1
  assert.ok(Math.abs(cost - 7.1) < 1e-9);
});

test("missing cache price falls back to input price; unknown models cost zero but are flagged", () => {
  const fallback = benchCallCostUsd({
    role: "worker", provider: "zai-coding-cn", model: "no-cache-price",
    inputTokens: 500_000, cacheReadTokens: 100_000, cacheWriteTokens: 0, outputTokens: 0,
  }, table);
  // No cacheRead price → all 500k input billed at 1.4 → 0.7
  assert.ok(Math.abs(fallback - 0.7) < 1e-9);

  const summary = benchTotalCostUsd([
    {
      role: "worker", provider: "unknown", model: "mystery",
      inputTokens: 1_000, cacheReadTokens: 0, cacheWriteTokens: 10, outputTokens: 1_000,
    },
  ], table);
  assert.equal(summary.totalUsd, 0);
  assert.deepEqual(summary.unpriced, [priceKey("unknown", "mystery")]);
  assert.equal(summary.cacheWriteTokens, 10);
});

function run(variant: BenchResultRecord["variant"], resolved: boolean, costUsd: number): BenchResultRecord {
  return {
    runId: `${variantLabel(variant)}-${resolved}-${costUsd}`,
    benchId: "mbpp", taskId: "t1", variant, repeat: 1,
    startedAt: "2025-01-01T00:00:00Z", endedAt: "2025-01-01T00:01:00Z",
    resolved, durationMs: 60_000, totalCostUsd: costUsd, cacheWriteTokens: 0, calls: [],
  };
}

test("variant summaries compute resolved rate and cost efficiency", () => {
  const summary = summarizeBenchRuns([
    run({ kind: "single", model: "gpt-5.6-sol" }, true, 0.4),
    run({ kind: "single", model: "gpt-5.6-sol" }, false, 0.4),
    run({ kind: "learned" }, true, 0.1),
    run({ kind: "learned" }, true, 0.3),
  ]);
  const byVariant = new Map(summary.map((row) => [row.variant, row]));
  const single = byVariant.get("single:gpt-5.6-sol")!;
  assert.equal(single.runs, 2);
  assert.equal(single.resolvedRate, 0.5);
  assert.equal(single.costPerResolvedUsd, 0.8);

  const learned = byVariant.get("learned")!;
  assert.equal(learned.resolvedRate, 1);
  assert.ok(Math.abs(learned.costPerResolvedUsd - 0.2) < 1e-9);
  assert.ok(learned.successesPerDollar > single.successesPerDollar);
});

test("cost per resolved is infinite when nothing resolves; wilson interval behaves at boundaries", () => {
  const summary = summarizeBenchRuns([run({ kind: "fixed_mapping" }, false, 0.25)]);
  assert.equal(summary[0].costPerResolvedUsd, Number.POSITIVE_INFINITY);

  assert.deepEqual(wilsonInterval(0, 0), { low: 0, high: 0 });
  const allBad = wilsonInterval(0, 10);
  assert.equal(allBad.low, 0);
  assert.ok(allBad.high > 0 && allBad.high < 0.5, `upper=${allBad.high}`);
  const allGood = wilsonInterval(10, 10);
  assert.equal(allGood.high, 1);
  assert.ok(allGood.low > 0.5 && allGood.low < 1, `lower=${allGood.low}`);
});
