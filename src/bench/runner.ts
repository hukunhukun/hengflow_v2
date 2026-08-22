/**
 * Headless benchmark runner.
 *
 * Each (task × variant × repeat) run gets an isolated agent dir (config with
 * frozen prices + symlinked credentials), an isolated data dir (ledger), and a
 * spawned `hengflow-v2 -p <prompt>` process. Judging is external (MBPP: local
 * python). Costs are recomputed from the isolated ledger's model_calls against
 * the frozen pool price table, never from provider bills.
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type BenchRunConfig } from "../config.js";
import { UsageLedger } from "../ledger.js";
import type { DelegatedTask, ModelRef, TaskKind } from "../types.js";
import {
  benchTotalCostUsd,
  priceKey,
  variantLabel,
  type BenchCallUsage,
  type BenchPriceTable,
  type BenchResultRecord,
  type BenchVariant,
} from "./schema.js";
import { buildMbppPrompt, judgeMbpp, loadMbppTasks, MBPP_DEFAULT_SOURCE, type MbppTask } from "./mbpp.js";
import {
  buildEvalPlusPrompt,
  filterSelfConsistent,
  judgeEvalPlus,
  loadEvalPlusTasks,
} from "./evalplus.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface BenchRunOptions {
  benchId: "mbpp" | "humanevalplus" | "mbppplus";
  dataPath?: string;
  limit: number;
  offset?: number;
  variants: BenchVariant[];
  repeats: number;
  outRoot: string;
  /** isolated: fresh ledger per run; session: one shared ledger (training); frozen:<path>: copy a trained ledger and freeze learning. */
  ledgerMode: "isolated" | "session" | "frozen";
  frozenLedgerPath?: string;
  userPool: ModelRef[];
  seedBase?: number;
  runTimeoutMs?: number;
  pythonBin?: string;
  /** Fixed mapping for the fixed_mapping variant. */
  fixedMapping?: Partial<Record<TaskKind, string>>;
  /** Drop dataset tasks whose canonical fails its own tests (default true). */
  selfConsistencyFilter?: boolean;
}

function buildPriceTable(pool: ModelRef[]): BenchPriceTable {
  const table: BenchPriceTable = {};
  for (const model of pool) {
    if (!(model.inputUsdPerMillion > 0) && !(model.outputUsdPerMillion > 0)) {
      throw new Error(
        `${priceKey(model.provider, model.model)} 未配置价格；bench 公平对比需要每百万 Token 美元单价`,
      );
    }
    table[priceKey(model.provider, model.model)] = {
      inputUsdPerMillion: model.inputUsdPerMillion,
      cacheReadUsdPerMillion: model.cachedInputUsdPerMillion,
      outputUsdPerMillion: model.outputUsdPerMillion,
    };
  }
  return table;
}

const BUCKET_COMPLEXITY: Record<string, number> = { low: 0.2, medium: 0.5, high: 0.8 };

/**
 * Training-only: fold the external judge result back into the shared ledger
 * as ground truth (confidence 1.0). Worker cells update from launch routing
 * rows; the manager turn outcome is corrected to the judged status. This is
 * the single learning writer during bench training — in-process signals are
 * suppressed for bench runs.
 */
function applyJudgeGroundTruth(
  dataDir: string,
  pool: ModelRef[],
  window: { startedAtMs: number; resolved: boolean; durationMs: number; calls: BenchCallUsage[] },
): void {
  const ledger = new UsageLedger(join(dataDir, "usage.sqlite"));
  try {
    const modelRef = (provider: string, model: string): ModelRef =>
      pool.find((entry) => entry.provider === provider && entry.model === model)
      ?? { id: `${provider}/${model}`, provider, model, thinking: "off", quality: 0.8, inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0 };

    const turns = ledger.db.prepare(
      "SELECT turn_id, manager_provider, manager_model FROM turn_outcomes WHERE created_at >= ? ORDER BY created_at DESC LIMIT 1",
    ).all(window.startedAtMs) as Array<{ turn_id: string; manager_provider: string; manager_model: string }>;
    const turn = turns[0];
    if (turn) {
      // Correct the turn status to the judged truth.
      ledger.db.prepare("UPDATE turn_outcomes SET final_status = ? WHERE turn_id = ?")
        .run(window.resolved ? "accepted" : "failed", turn.turn_id);
      ledger.recordManagerTurnOutcome(
        turn.manager_provider,
        turn.manager_model,
        window.resolved,
        window.resolved ? 1 : 0,
        window.durationMs,
      );
    }

    const launches = ledger.db.prepare(
      "SELECT task_id, selected_provider, selected_model, predicted_cost_usd, task_kind, complexity_bucket FROM route_decisions WHERE phase = 'launch' AND task_kind IS NOT NULL AND created_at >= ?",
    ).all(window.startedAtMs) as Array<{
      task_id: string; selected_provider: string; selected_model: string;
      predicted_cost_usd: number; task_kind: TaskKind; complexity_bucket: keyof typeof BUCKET_COMPLEXITY;
    }>;
    for (const row of launches) {
      const selected = modelRef(row.selected_provider, row.selected_model);
      const usage = window.calls
        .filter((call) => call.role === "worker" && call.provider === row.selected_provider && call.model === row.selected_model)
        .reduce((sum, call) => ({
          input: sum.input + call.inputTokens,
          output: sum.output + call.outputTokens,
          cacheRead: sum.cacheRead + call.cacheReadTokens,
          cacheWrite: sum.cacheWrite + call.cacheWriteTokens,
          totalTokens: sum.totalTokens + call.inputTokens + call.outputTokens,
          reportedCostUsd: 0,
        }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reportedCostUsd: 0 });
      const task: DelegatedTask = {
        id: row.task_id,
        objective: "bench",
        kind: row.task_kind,
        risk: "low",
        complexity: BUCKET_COMPLEXITY[row.complexity_bucket] ?? 0.5,
        estimatedInputTokens: Math.max(1, usage.input),
        estimatedOutputTokens: Math.max(1, usage.output),
      };
      ledger.recordOutcome(
        `judge-${row.task_id}-${window.startedAtMs}`,
        {
          task,
          route: {
            taskId: row.task_id, selected, score: 0,
            predictedCostUsd: Math.max(row.predicted_cost_usd, 1e-9),
            predictedFailureProbability: 0.1, explanation: [],
          },
          output: "",
          exitCode: window.resolved ? 0 : 1,
          durationMs: window.durationMs,
          usage,
          stopReason: "stop",
          retried: false,
          attempts: [],
        },
        {
          taskId: row.task_id,
          status: window.resolved ? "accepted" : "rejected",
          quality: window.resolved ? 0.95 : 0.1,
          confidence: 1,
          reason: `外部判定：${window.resolved ? "通过" : "未通过"}`,
        },
        selected,
        1,
      );
    }
  } finally {
    ledger.close();
  }
}

export function prepareRunDir(options: BenchRunOptions, task: { taskId: string }, variant: BenchVariant, repeat: number): {
  runDir: string;
  agentDir: string;
  dataDir: string;
  seed: number;
} {
  const label = variantLabel(variant).replace(/[/\\:]/g, "_");
  const runDir = join(options.outRoot, options.benchId, task.taskId, label, String(repeat));
  const agentDir = join(runDir, "agent");
  mkdirSync(agentDir, { recursive: true });

  // Shared training ledger (session) or per-run isolated data dir.
  let dataDir: string;
  if (options.ledgerMode === "session") {
    dataDir = join(options.outRoot, "ledger");
    mkdirSync(dataDir, { recursive: true });
  } else {
    dataDir = join(runDir, "data");
    mkdirSync(dataDir, { recursive: true });
  }

  const bench: BenchRunConfig = { variant: variant.kind, benchId: options.benchId, taskId: task.taskId };
  if (variant.kind === "single") bench.singleModel = variant.model;
  if (variant.kind === "learned_frozen") bench.freezeLearning = true;
  const routing: Record<string, unknown> = {};
  if (variant.kind === "fixed_mapping") routing.forcedWorkerByKind = options.fixedMapping ?? {};

  const seed = (options.seedBase ?? 1) * 100_003 + repeat;
  if (variant.kind === "learned_frozen") bench.seed = seed;

  writeFileSync(join(agentDir, "config.json"), `${JSON.stringify({
    modelsConfigured: true,
    pool: options.userPool,
    routing,
    bench,
  }, null, 2)}\n`, { mode: 0o600 });

  const sourceAgentDir = getAgentDir();
  for (const file of ["auth.json", "models.json"]) {
    const source = join(sourceAgentDir, file);
    const target = join(agentDir, file);
    if (existsSync(source) && !existsSync(target)) symlinkSync(source, target);
  }
  if (options.ledgerMode === "frozen" && options.frozenLedgerPath) {
    const target = join(dataDir, "usage.sqlite");
    if (!existsSync(target)) {
      copyFileSync(options.frozenLedgerPath, target);
      // Best-effort WAL sidecars in case the source was not cleanly closed.
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${options.frozenLedgerPath}${suffix}`;
        if (existsSync(sidecar)) copyFileSync(sidecar, `${target}${suffix}`);
      }
    }
  }
  return { runDir, agentDir, dataDir, seed };
}

function spawnRun(agentDir: string, dataDir: string, prompt: string, timeoutMs: number): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}> {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [join(REPO_ROOT, "dist", "cli.js"), "-p", prompt], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        HENGFLOW_AGENT_DIR: agentDir,
        HENGFLOW_DATA_DIR: dataDir,
        PI_CODING_AGENT_DIR: agentDir,
        HENGFLOW_V2: "1",
        PI_SKIP_VERSION_CHECK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr: `${stderr}\n${error.message}`, exitCode: -1, timedOut: false });
    });
  });
}

/** Current max model_calls id in a ledger dir (0 when absent). */
function maxCallId(dataDir: string): number {
  const dbPath = join(dataDir, "usage.sqlite");
  if (!existsSync(dbPath)) return 0;
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM model_calls").get() as { id: number };
    return Number(row.id);
  } finally {
    db.close();
  }
}

/** Calls recorded after the given id (session mode passes a run baseline). */
function readCalls(dataDir: string, afterId = 0): BenchCallUsage[] {
  const dbPath = join(dataDir, "usage.sqlite");
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(`SELECT role, provider, model, input_tokens, output_tokens,
      cache_read_tokens, cache_write_tokens FROM model_calls WHERE id > ? ORDER BY id`).all(afterId)
      .map((raw) => {
        const row = raw as Record<string, string | number>;
        return {
          role: String(row.role) === "worker" ? "worker" : "manager",
          provider: String(row.provider),
          model: String(row.model),
          inputTokens: Number(row.input_tokens),
          outputTokens: Number(row.output_tokens),
          cacheReadTokens: Number(row.cache_read_tokens),
          cacheWriteTokens: Number(row.cache_write_tokens),
        } satisfies BenchCallUsage;
      });
  } finally {
    db.close();
  }
}

/** Bench-task contract: one prompt plus an external judge over the model answer. */
export interface BenchTask {
  taskId: string;
  buildPrompt(): string;
  judge(answer: string): { resolved: boolean; log: string };
}

async function loadBenchTasks(options: BenchRunOptions): Promise<BenchTask[]> {
  if (options.benchId === "mbpp") {
    const tasks = await loadMbppTasks(options.dataPath ?? MBPP_DEFAULT_SOURCE, options.limit, options.offset ?? 0);
    return tasks.map((task) => ({
      taskId: task.taskId,
      buildPrompt: () => buildMbppPrompt(task),
      judge: (answer) => judgeMbpp(answer, task, { pythonBin: options.pythonBin }),
    }));
  }
  const family = options.benchId === "humanevalplus" ? "humanevalplus" : "mbppplus";
  const defaultPath = join(REPO_ROOT, "bench", "data", `${family}.jsonl`);
  const tasks = await loadEvalPlusTasks(family, options.dataPath ?? defaultPath, options.limit, options.offset ?? 0);
  const filtered = options.selfConsistencyFilter === false
    ? tasks
    : await filterSelfConsistent(tasks, options.pythonBin);
  if (filtered.length === 0) throw new Error("过滤后没有可用任务（数据集或路径有误？）");
  return filtered.map((task) => ({
    taskId: task.taskId,
    buildPrompt: () => buildEvalPlusPrompt(task),
    judge: (answer) => judgeEvalPlus(answer, task, task.canonicalSolution, { pythonBin: options.pythonBin }),
  }));
}

export async function runBench(options: BenchRunOptions): Promise<BenchResultRecord[]> {
  if (options.userPool.length < 2) throw new Error("bench 需要用户先配置 ≥2 个模型（含价格）");
  const table = buildPriceTable(options.userPool);
  const tasks = await loadBenchTasks(options);
  const records: BenchResultRecord[] = [];
  const total = tasks.length * options.variants.length * options.repeats;
  let done = 0;

  // Interleave order (task → variant → repeat) so provider hiccups don't
  // systematically favor one variant.
  for (let repeat = 1; repeat <= options.repeats; repeat++) {
    for (const variant of options.variants) {
      for (const task of tasks) {
        done += 1;
        const label = variantLabel(variant);
        process.stdout.write(`[${done}/${total}] ${task.taskId} · ${label} · r${repeat} … `);
        const startedAtMs = Date.now();
        const { runDir, agentDir, dataDir, seed } = prepareRunDir(options, task, variant, repeat);
        // Session-ledger mode shares one DB: attribute only calls recorded
        // after this run started.
        const callBaseline = maxCallId(dataDir);
        const run = await spawnRun(agentDir, dataDir, task.buildPrompt(), options.runTimeoutMs ?? 600_000);
        const judged = task.judge(run.stdout);
        const calls = readCalls(dataDir, callBaseline);
        const durationMs = Date.now() - startedAtMs;
        if (options.ledgerMode === "session") {
          applyJudgeGroundTruth(dataDir, options.userPool, {
            startedAtMs, resolved: judged.resolved, durationMs, calls,
          });
        }
        const cost = benchTotalCostUsd(calls, table);
        const record: BenchResultRecord = {
          runId: crypto.randomUUID(),
          benchId: options.benchId,
          taskId: task.taskId,
          variant,
          repeat,
          seed,
          startedAt: new Date(startedAtMs).toISOString(),
          endedAt: new Date().toISOString(),
          resolved: judged.resolved,
          durationMs,
          totalCostUsd: cost.totalUsd,
          cacheWriteTokens: cost.cacheWriteTokens,
          calls,
        };
        writeFileSync(join(runDir, "result.json"), `${JSON.stringify({ ...record, judgeLog: judged.log }, null, 2)}\n`);
        writeFileSync(join(runDir, "stdout.txt"), run.stdout);
        writeFileSync(join(runDir, "stderr.txt"), run.stderr.slice(-20_000));
        records.push(record);
        process.stdout.write(
          `${judged.resolved ? "✓" : "✗"} $${record.totalCostUsd.toFixed(4)} ${calls.length}calls ${record.durationMs}ms${run.timedOut ? " (timeout)" : ""}\n`,
        );
      }
    }
  }
  writeFileSync(
    join(options.outRoot, `summary-${Date.now()}.json`),
    `${JSON.stringify({ benchId: options.benchId, generatedAt: new Date().toISOString(), unpriced: benchTotalCostUsd(records.flatMap((r) => r.calls), table).unpriced, records }, null, 2)}\n`,
  );
  return records;
}

export function loadExistingRecords(outRoot: string): BenchResultRecord[] {
  const records: BenchResultRecord[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else if (entry === "result.json") {
        try {
          records.push(JSON.parse(readFileSync(path, "utf8")) as BenchResultRecord);
        } catch {
          // skip malformed
        }
      }
    }
  };
  walk(outRoot);
  return records;
}
