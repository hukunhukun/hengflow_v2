import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDataDir } from "./config.js";
import type {
  CostBreakdown,
  CostBreakdownRow,
  DelegatedTask,
  LearnedProfile,
  ModelRef,
  QuotaReport,
  RouteDecision,
  TaskOutcome,
  TokenUsage,
  WorkerResult,
} from "./types.js";
import { usageShadowCost, workerShadowCost } from "./cost.js";

export interface ModelStats {
  provider: string;
  model: string;
  calls: number;
  successRate: number;
  averageLatencyMs: number;
  averageInputTokens: number;
  averageOutputTokens: number;
  averageShadowCostUsd: number;
}

export interface LearnedStat {
  provider: string;
  model: string;
  taskKind: string;
  complexityBucket: string;
  samples: number;
  posteriorQuality: number;
  failureProbability: number;
  costRatio: number;
  latencyMs: number;
}

const PRIOR_STRENGTH = 10;
const FAILURE_PRIOR_TOTAL = 5;
const FAILURE_PRIOR_FAILURES = 1;
const EWMA_ALPHA = 0.2;

export function complexityBucket(complexity: number): string {
  if (complexity < 0.35) return "low";
  if (complexity < 0.7) return "medium";
  return "high";
}

function outcomeBaseReward(status: TaskOutcome["status"]): number {
  switch (status) {
    case "accepted": return 1;
    case "accepted_edit": return 0.75;
    case "reworked": return 0.35;
    case "rejected":
    case "failed": return 0;
  }
}

export class UsageLedger {
  readonly db: DatabaseSync;

  constructor(path = join(getDataDir(), "usage.sqlite")) {
    mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        role TEXT NOT NULL,
        task_id TEXT,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_tokens INTEGER,
        reported_cost_usd REAL NOT NULL DEFAULT 0,
        shadow_cost_usd REAL NOT NULL DEFAULT 0,
        stop_reason TEXT,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS route_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        task_id TEXT NOT NULL,
        selected_provider TEXT NOT NULL,
        selected_model TEXT NOT NULL,
        fallback_provider TEXT,
        fallback_model TEXT,
        score REAL NOT NULL,
        predicted_cost_usd REAL NOT NULL,
        predicted_failure REAL NOT NULL,
        explanation_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quota_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        fetched_at INTEGER NOT NULL,
        source TEXT NOT NULL,
        report_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at INTEGER NOT NULL,
        delegation_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        complexity_bucket TEXT NOT NULL,
        status TEXT NOT NULL,
        reward REAL NOT NULL,
        quality REAL NOT NULL,
        confidence REAL NOT NULL,
        shadow_cost_usd REAL NOT NULL,
        predicted_cost_usd REAL NOT NULL,
        duration_ms INTEGER NOT NULL,
        reason TEXT,
        UNIQUE(delegation_id, task_id)
      );
      CREATE TABLE IF NOT EXISTS model_task_stats (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_kind TEXT NOT NULL,
        complexity_bucket TEXT NOT NULL,
        samples INTEGER NOT NULL,
        reward_sum REAL NOT NULL,
        semantic_successes INTEGER NOT NULL,
        ewma_cost_ratio REAL NOT NULL,
        ewma_latency_ms REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY(provider, model, task_kind, complexity_bucket)
      );
      CREATE INDEX IF NOT EXISTS idx_calls_model ON model_calls(provider, model, created_at);
      CREATE INDEX IF NOT EXISTS idx_quota_provider ON quota_snapshots(provider, fetched_at);
      CREATE INDEX IF NOT EXISTS idx_outcomes_model ON task_outcomes(provider, model, task_kind, complexity_bucket);
    `);
  }

  recordManagerCall(
    provider: string,
    model: string,
    usage: TokenUsage,
    shadowCostUsd: number,
    stopReason?: string,
    durationMs = 0,
  ): void {
    this.insertCall({
      role: "manager",
      provider,
      model,
      success: stopReason !== "error" && stopReason !== "aborted",
      durationMs,
      usage,
      shadowCostUsd,
      stopReason,
    });
  }

  recordWorkerCall(result: WorkerResult, shadowCostUsd = workerShadowCost(result)): void {
    if (result.attempts?.length) {
      for (const attempt of result.attempts) {
        this.insertCall({
          role: "worker",
          taskId: result.task.id,
          provider: attempt.model.provider,
          model: attempt.model.model,
          success: attempt.exitCode === 0 && attempt.stopReason !== "error" && attempt.stopReason !== "aborted",
          durationMs: attempt.durationMs,
          usage: attempt.usage,
          shadowCostUsd: usageShadowCost(attempt.model, attempt.usage),
          stopReason: attempt.stopReason,
          error: attempt.error,
        });
      }
      return;
    }
    this.insertCall({
      role: "worker",
      taskId: result.task.id,
      provider: result.route.selected.provider,
      model: result.model || result.route.selected.model,
      success: result.exitCode === 0 && result.stopReason !== "error" && result.stopReason !== "aborted",
      durationMs: result.durationMs,
      usage: result.usage,
      shadowCostUsd,
      stopReason: result.stopReason,
      error: result.error,
    });
  }

  private insertCall(value: {
    role: string;
    taskId?: string;
    provider: string;
    model: string;
    success: boolean;
    durationMs: number;
    usage: TokenUsage;
    shadowCostUsd: number;
    stopReason?: string;
    error?: string;
  }): void {
    this.db
      .prepare(`INSERT INTO model_calls (
        created_at, role, task_id, provider, model, success, duration_ms,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
        reasoning_tokens, reported_cost_usd, shadow_cost_usd, stop_reason, error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        Date.now(), value.role, value.taskId ?? null, value.provider, value.model,
        value.success ? 1 : 0, value.durationMs, value.usage.input, value.usage.output,
        value.usage.cacheRead, value.usage.cacheWrite, value.usage.reasoning ?? null,
        value.usage.reportedCostUsd, value.shadowCostUsd, value.stopReason ?? null, value.error ?? null,
      );
  }

  recordDecision(decision: RouteDecision): void {
    this.db.prepare(`INSERT INTO route_decisions (
      created_at, task_id, selected_provider, selected_model, fallback_provider,
      fallback_model, score, predicted_cost_usd, predicted_failure, explanation_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        Date.now(), decision.taskId, decision.selected.provider, decision.selected.model,
        decision.fallback?.provider ?? null, decision.fallback?.model ?? null,
        decision.score, decision.predictedCostUsd, decision.predictedFailureProbability,
        JSON.stringify(decision.explanation),
      );
  }

  recordOutcome(
    delegationId: string,
    result: WorkerResult,
    outcome: TaskOutcome,
    model: ModelRef,
  ): LearnedProfile {
    const task = result.task;
    const bucket = complexityBucket(task.complexity);
    const quality = Math.min(1, Math.max(0, outcome.quality));
    const confidence = Math.min(1, Math.max(0, outcome.confidence));
    const observedReward = 0.65 * outcomeBaseReward(outcome.status) + 0.35 * quality;
    const reward = confidence * observedReward + (1 - confidence) * model.quality;
    const shadowCost = workerShadowCost(result);
    const predictedCost = Math.max(result.route.predictedCostUsd, 1e-9);
    const costRatio = Math.min(4, Math.max(0.25, shadowCost / predictedCost));
    const semanticSuccess = outcome.status === "accepted" || outcome.status === "accepted_edit" ? 1 : 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO task_outcomes (
        created_at, delegation_id, task_id, provider, model, task_kind, complexity_bucket,
        status, reward, quality, confidence, shadow_cost_usd, predicted_cost_usd, duration_ms, reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          Date.now(), delegationId, task.id, model.provider, model.model, task.kind, bucket,
          outcome.status, reward, quality, confidence, shadowCost, predictedCost, result.durationMs,
          outcome.reason ?? null,
        );
      this.db.prepare(`INSERT INTO model_task_stats (
        provider, model, task_kind, complexity_bucket, samples, reward_sum,
        semantic_successes, ewma_cost_ratio, ewma_latency_ms, updated_at
      ) VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      ON CONFLICT(provider, model, task_kind, complexity_bucket) DO UPDATE SET
        samples = samples + 1,
        reward_sum = reward_sum + excluded.reward_sum,
        semantic_successes = semantic_successes + excluded.semantic_successes,
        ewma_cost_ratio = (1 - ${EWMA_ALPHA}) * ewma_cost_ratio + ${EWMA_ALPHA} * excluded.ewma_cost_ratio,
        ewma_latency_ms = (1 - ${EWMA_ALPHA}) * ewma_latency_ms + ${EWMA_ALPHA} * excluded.ewma_latency_ms,
        updated_at = excluded.updated_at`)
        .run(
          model.provider, model.model, task.kind, bucket, reward, semanticSuccess,
          costRatio, result.durationMs, Date.now(),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getLearnedProfile(task, model, result.route.predictedFailureProbability);
  }

  getLearnedProfile(task: DelegatedTask, model: ModelRef, baseFailure: number): LearnedProfile {
    const bucket = complexityBucket(task.complexity);
    const row = this.db.prepare(`SELECT samples, reward_sum, semantic_successes,
      ewma_cost_ratio, ewma_latency_ms FROM model_task_stats
      WHERE provider = ? AND model = ? AND task_kind = ? AND complexity_bucket = ?`)
      .get(model.provider, model.model, task.kind, bucket) as Record<string, number> | undefined;
    if (!row) {
      return { samples: 0, posteriorQuality: model.quality, failureProbability: baseFailure, costRatio: 1, latencyMs: 0 };
    }
    const samples = Number(row.samples);
    const posteriorQuality = (PRIOR_STRENGTH * model.quality + Number(row.reward_sum)) / (PRIOR_STRENGTH + samples);
    const semanticFailures = samples - Number(row.semantic_successes);
    const posteriorFailure = (FAILURE_PRIOR_FAILURES + semanticFailures) / (FAILURE_PRIOR_TOTAL + samples);
    return {
      samples,
      posteriorQuality,
      failureProbability: 0.5 * baseFailure + 0.5 * posteriorFailure,
      costRatio: Number(row.ewma_cost_ratio),
      latencyMs: Number(row.ewma_latency_ms),
    };
  }

  getLearnedStats(models: ModelRef[]): LearnedStat[] {
    const priors = new Map(models.map((model) => [`${model.provider}/${model.model}`, model.quality]));
    return this.db.prepare(`SELECT provider, model, task_kind, complexity_bucket, samples,
      reward_sum, semantic_successes, ewma_cost_ratio, ewma_latency_ms
      FROM model_task_stats ORDER BY samples DESC, provider, model`).all().map((raw) => {
      const row = raw as Record<string, string | number>;
      const samples = Number(row.samples);
      const prior = priors.get(`${row.provider}/${row.model}`) ?? 0.5;
      const failures = samples - Number(row.semantic_successes);
      return {
        provider: String(row.provider), model: String(row.model), taskKind: String(row.task_kind),
        complexityBucket: String(row.complexity_bucket), samples,
        posteriorQuality: (PRIOR_STRENGTH * prior + Number(row.reward_sum)) / (PRIOR_STRENGTH + samples),
        failureProbability: (FAILURE_PRIOR_FAILURES + failures) / (FAILURE_PRIOR_TOTAL + samples),
        costRatio: Number(row.ewma_cost_ratio), latencyMs: Number(row.ewma_latency_ms),
      };
    });
  }

  getLastCallId(): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM model_calls").get() as { id: number };
    return Number(row.id);
  }

  getCostBreakdown(afterCallId = 0): CostBreakdown {
    const rows = this.db.prepare(`SELECT role, provider, model, COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
      COALESCE(SUM(reported_cost_usd), 0) AS reported_cost_usd,
      COALESCE(SUM(shadow_cost_usd), 0) AS shadow_cost_usd
      FROM model_calls WHERE id > ? GROUP BY role, provider, model
      ORDER BY role, shadow_cost_usd DESC`).all(afterCallId).map((raw) => {
        const row = raw as Record<string, string | number>;
        return {
          role: String(row.role) as CostBreakdownRow["role"], provider: String(row.provider), model: String(row.model),
          calls: Number(row.calls), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
          cacheReadTokens: Number(row.cache_read_tokens),
          reportedCostUsd: Number(row.reported_cost_usd), shadowCostUsd: Number(row.shadow_cost_usd),
        };
      });
    return {
      rows,
      calls: rows.reduce((sum, row) => sum + row.calls, 0),
      inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
      outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
      reportedCostUsd: rows.reduce((sum, row) => sum + row.reportedCostUsd, 0),
      shadowCostUsd: rows.reduce((sum, row) => sum + row.shadowCostUsd, 0),
    };
  }

  recordQuota(report: QuotaReport): void {
    this.db.prepare("INSERT INTO quota_snapshots(provider, fetched_at, source, report_json) VALUES (?, ?, ?, ?)")
      .run(report.provider, report.fetchedAt, report.source, JSON.stringify(report));
  }

  getLatestQuota(provider: string): QuotaReport | undefined {
    const row = this.db.prepare(
      "SELECT report_json FROM quota_snapshots WHERE provider = ? ORDER BY fetched_at DESC LIMIT 1",
    ).get(provider) as { report_json: string } | undefined;
    return row ? JSON.parse(row.report_json) as QuotaReport : undefined;
  }

  getQuotaPressure(provider: string): number {
    const report = this.getLatestQuota(provider);
    if (!report || report.limits.length === 0) return 0;
    const pressures = report.limits.map((limit) => {
      if (limit.unit === "percent" && limit.used !== undefined) return Math.min(1, Math.max(0, limit.used / 100));
      if (limit.limit && limit.used !== undefined) return Math.min(1, Math.max(0, limit.used / limit.limit));
      if (limit.limit && limit.remaining !== undefined) return Math.min(1, Math.max(0, 1 - limit.remaining / limit.limit));
      return 0;
    });
    return Math.max(...pressures, 0);
  }

  getModelStats(): ModelStats[] {
    return this.db.prepare(`
      SELECT provider, model, COUNT(*) AS calls,
        AVG(success) AS success_rate,
        AVG(duration_ms) AS avg_latency_ms,
        AVG(input_tokens) AS avg_input_tokens,
        AVG(output_tokens) AS avg_output_tokens,
        AVG(shadow_cost_usd) AS avg_shadow_cost_usd
      FROM model_calls
      GROUP BY provider, model
      ORDER BY calls DESC
    `).all().map((row) => {
      const value = row as Record<string, string | number>;
      return {
        provider: String(value.provider),
        model: String(value.model),
        calls: Number(value.calls),
        successRate: Number(value.success_rate),
        averageLatencyMs: Number(value.avg_latency_ms),
        averageInputTokens: Number(value.avg_input_tokens),
        averageOutputTokens: Number(value.avg_output_tokens),
        averageShadowCostUsd: Number(value.avg_shadow_cost_usd),
      };
    });
  }

  getSummary(): { calls: number; input: number; output: number; shadowCostUsd: number; reportedCostUsd: number } {
    const row = this.db.prepare(`SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input,
      COALESCE(SUM(output_tokens), 0) AS output, COALESCE(SUM(shadow_cost_usd), 0) AS shadow,
      COALESCE(SUM(reported_cost_usd), 0) AS reported FROM model_calls`).get() as Record<string, number>;
    return {
      calls: Number(row.calls), input: Number(row.input), output: Number(row.output),
      shadowCostUsd: Number(row.shadow), reportedCostUsd: Number(row.reported),
    };
  }

  close(): void {
    this.db.close();
  }
}
