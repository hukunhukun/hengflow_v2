#!/usr/bin/env node
import { join, resolve } from "node:path";
import { main, ModelRuntime } from "./runtime/agent.js";
import { authStatus, importApiKeys } from "./auth.js";
import { getAgentDir, loadConfig } from "./config.js";
import { configureNetworkProxy } from "./network.js";
import type { BenchPriceTable, BenchVariant } from "./bench/schema.js";
import { priceKey } from "./bench/schema.js";

const VERSION = "0.7.1";

// Node 22-25 marks the built-in SQLite module experimental even though the API
// is available. Suppress only that one warning so every CLI startup stays clean.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = warning instanceof Error ? warning.message : String(warning);
  if (message.includes("SQLite is an experimental feature")) return;
  (emitWarning as (...values: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

function help(): string {
  return `HENGFLOW 衡流  ${VERSION}
Cost-aware, self-improving multi-model agent runtime

Usage:
  hengflow-v2 [options] [message]          Start HengFlow with the configured Manager
  hengflow-v2 auth status                 Show configured login metadata
  hengflow-v2 auth import --from <file>   One-time API-key migration
  hengflow-v2 usage [--refresh]           Show quota, tokens and shadow cost
  hengflow-v2 dashboard                   Show cumulative cost and learned policy

Inside the TUI:
  /login             Login with OAuth or an API key
  /logout            Remove a credential
  /usage [refresh]   Show HengFlow usage
  /dashboard         Show visual cost and learning panel
  /tasks             Show the current Todo, route and progress panel
  /hf-status         Show Manager, Workers and routing policy

The Manager comes from ~/.hengflow/agent/config.json or .hengflow/config.json.
Workers are discovered dynamically from all authenticated models.`;
}

function removeManagerOverrides(args: string[]): string[] {
  const blocked = new Set(["--provider", "--model", "--thinking", "--models"]);
  const output: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (blocked.has(arg)) {
      index++;
      continue;
    }
    if ([...blocked].some((flag) => arg.startsWith(`${flag}=`))) continue;
    output.push(arg);
  }
  return output;
}

async function runBenchCommand(args: string[]): Promise<void> {
  const sub = args[1];
  if (sub !== "run" && sub !== "report") {
    console.log(`用法：
  hengflow-v2 bench run --bench mbpp [--data path.jsonl] [--limit 5] [--variants learned,single:<provider/model>,fixed_mapping,learned_frozen] [--repeats 1] [--out bench/runs] [--ledger isolated|session|frozen] [--frozen-ledger path] [--seed 1] [--timeout 600000]
  hengflow-v2 bench report --dir bench/runs`);
    return;
  }
  const flag = (name: string, fallback = ""): string => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
  };
  const config = loadConfig();
  if (sub === "report") {
    const { loadExistingRecords } = await import("./bench/runner.js");
    const { summarizeBenchRuns, wilsonInterval } = await import("./bench/schema.js");
    const records = loadExistingRecords(flag("dir", "bench/runs"));
    if (records.length === 0) {
      console.log("没有可汇总的 result.json；先运行 bench run。");
      return;
    }
    const summary = summarizeBenchRuns(records);
    console.log("\nvariant                     runs  resolved  rate    [wilson 95%]     meanCost   cost/resolved  success/$");
    for (const row of summary) {
      const interval = wilsonInterval(row.resolvedRuns, row.runs);
      console.log(
        `${row.variant.padEnd(26)} ${String(row.runs).padStart(4)}  ${String(row.resolvedRuns).padStart(8)}  ${row.resolvedRate.toFixed(2)}  [${interval.low.toFixed(2)}, ${interval.high.toFixed(2)}]  $${row.meanCostUsd.toFixed(4).padStart(9)}  $${(Number.isFinite(row.costPerResolvedUsd) ? row.costPerResolvedUsd.toFixed(4) : "∞").padStart(11)}  ${row.successesPerDollar.toFixed(2).padStart(9)}`,
      );
    }
    const unpriced = new Set<string>();
    const config = loadConfig();
    const table: BenchPriceTable = {};
    for (const model of config.pool) {
      table[priceKey(model.provider, model.model)] = {
        inputUsdPerMillion: model.inputUsdPerMillion,
        cacheReadUsdPerMillion: model.cachedInputUsdPerMillion,
        outputUsdPerMillion: model.outputUsdPerMillion,
      };
    }
    for (const record of records) {
      for (const call of record.calls) {
        if (!table[priceKey(call.provider, call.model)]) unpriced.add(priceKey(call.provider, call.model));
      }
    }
    if (unpriced.size > 0) {
      console.log(`\n⚠ 以下模型不在价格表中，其成本被记为 $0（结果被低估）：${[...unpriced].join(", ")}`);
      console.log("  请在 /models 中为它们配置每百万 Token 价格后重跑，或检查网关是否回报了别名模型名。");
    }
    return;
  }

  // bench run
  const benchId = flag("bench", "mbpp") as "mbpp" | "humanevalplus" | "mbppplus";
  if (!(["mbpp", "humanevalplus", "mbppplus"].includes(benchId))) throw new Error(`未知 bench：${benchId}`);
  const variantsRaw = (flag("variants", "learned") ?? "").split(",").map((v) => v.trim()).filter(Boolean);
  if (variantsRaw.length === 0) throw new Error("--variants 不能为空");
  const { pythonAvailable } = await import("./bench/mbpp.js");
  const pythonBin = flag("python", "python3");
  if (!pythonAvailable(pythonBin)) throw new Error(`未找到 ${pythonBin}；MBPP 判定需要本地 Python（≥3.9）`);
  if (!config.modelsConfigured || config.pool.length < 2) {
    throw new Error("请先在 TUI 中执行 /models 配置 ≥2 个模型（含价格），再运行 bench");
  }
  const pool = config.pool;
  const variants = variantsRaw.map((raw): BenchVariant => {
    if (raw.startsWith("single:")) {
      const model = raw.slice("single:".length);
      if (!pool.some((entry) => `${entry.provider}/${entry.model}` === model)) {
        throw new Error(`single 变体模型不在池中：${model}`);
      }
      return { kind: "single", model };
    }
    if (raw === "learned" || raw === "learned_frozen" || raw === "fixed_mapping") return { kind: raw };
    throw new Error(`未知变体：${raw}`);
  });
  const ledgerMode = (flag("ledger", "isolated") ?? "isolated") as "isolated" | "session" | "frozen";
  if (ledgerMode === "frozen" && !flag("frozen-ledger")) {
    throw new Error("--ledger frozen 需要 --frozen-ledger <usage.sqlite>（训练期账本快照）");
  }
  // fixed_mapping 默认：便宜模型接 simple/research，强模型接 coding/long-context
  const cheapest = [...pool].sort(
    (left, right) => (left.inputUsdPerMillion + left.outputUsdPerMillion)
      - (right.inputUsdPerMillion + right.outputUsdPerMillion),
  )[0];
  const strongest = [...pool].sort((left, right) => right.quality - left.quality)[0];
  const id = (model: typeof cheapest) => `${model.provider}/${model.model}`;

  const { runBench } = await import("./bench/runner.js");
  const records = await runBench({
    benchId,
    dataPath: flag("data") || undefined,
    limit: Number(flag("limit", "5")),
    offset: Number(flag("offset", "0")),
    variants,
    repeats: Number(flag("repeats", "1")),
    outRoot: flag("out", "bench/runs"),
    ledgerMode,
    frozenLedgerPath: flag("frozen-ledger") || undefined,
    userPool: pool,
    seedBase: Number(flag("seed", "1")),
    runTimeoutMs: Number(flag("timeout", String(10 * 60 * 1000))),
    pythonBin,
    fixedMapping: {
      simple: id(cheapest), research: id(cheapest),
      coding: id(strongest), "long-context": id(strongest),
    },
  });
  const { summarizeBenchRuns } = await import("./bench/schema.js");
  const summary = summarizeBenchRuns(records);
  console.log("\n完成。汇总：");
  for (const row of summary) {
    console.log(
      `${row.variant}: resolved ${row.resolvedRuns}/${row.runs}，meanCost=$${row.meanCostUsd.toFixed(4)}，cost/resolved=${Number.isFinite(row.costPerResolvedUsd) ? `$${row.costPerResolvedUsd.toFixed(4)}` : "∞"}`,
    );
  }
}

async function run(): Promise<void> {
  process.title = "hengflow-v2";
  process.env.HENGFLOW_V2 = "1";
  // HengFlow pins its embedded pi engine exactly; upstream release notices are
  // noise for end users and engine upgrades are deliberate dependency bumps.
  process.env.PI_SKIP_VERSION_CHECK = "1";
  const args = process.argv.slice(2);
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    console.log(help());
    return;
  }
  if (args[0] === "--version" || args[0] === "-v") {
    console.log(VERSION);
    return;
  }
  if (args[0] === "auth" && args[1] === "status") {
    console.log(await authStatus());
    return;
  }
  if (args[0] === "auth" && args[1] === "import") {
    const fromIndex = args.indexOf("--from");
    if (fromIndex < 0 || !args[fromIndex + 1]) throw new Error("用法：hengflow-v2 auth import --from <api_keys.json>");
    console.log(await importApiKeys(resolve(args[fromIndex + 1])));
    return;
  }
  await configureNetworkProxy();
  if (args[0] === "bench") {
    await runBenchCommand(args);
    return;
  }
  const config = loadConfig();
  if (args[0] === "dashboard") {
    const [{ UsageLedger }, { renderDashboard }] = await Promise.all([
      import("./ledger.js"),
      import("./dashboard.js"),
    ]);
    const ledger = new UsageLedger();
    try {
      console.log(renderDashboard(ledger, config).join("\n"));
    } finally {
      ledger.close();
    }
    return;
  }
  if (args[0] === "usage") {
    const [{ UsageLedger }, { fetchAllUsage, formatUsageReports }] = await Promise.all([
      import("./ledger.js"),
      import("./usage.js"),
    ]);
    const runtime = await ModelRuntime.create({ allowModelNetwork: false });
    const ledger = new UsageLedger();
    try {
      const reports = await fetchAllUsage(runtime, ledger, config.usage.cacheTtlMs, args.includes("--refresh"));
      console.log(formatUsageReports(reports, ledger));
    } finally {
      ledger.close();
    }
    return;
  }

  // The embedded engine reads its private runtime directory through this compatibility variable.
  const agentDir = getAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const startupRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const authenticatedModels = await startupRuntime.getAvailable();
  const managerAvailable = config.modelsConfigured && authenticatedModels.some(
    (model) => model.provider === config.manager.provider && model.id === config.manager.model,
  );
  const [{ createHengFlowExtension }, { UsageLedger }, { renderCostPanel }, { getProcessTaskBoard, renderTaskBoard }] = await Promise.all([
    import("./extension.js"),
    import("./ledger.js"),
    import("./dashboard.js"),
    import("./task-board.js"),
  ]);
  const piArgs = removeManagerOverrides(args);
  const printMode = piArgs.includes("--print") || piArgs.includes("-p");
  const panelLedger = printMode ? new UsageLedger() : undefined;
  const callBaseline = panelLedger?.getLastCallId() ?? 0;
  if (managerAvailable) {
    piArgs.unshift(
      "--model", `${config.manager.provider}/${config.manager.model}`,
      "--thinking", config.manager.thinking,
      "--models", `${config.manager.provider}/${config.manager.model}:${config.manager.thinking}`,
    );
  }
  try {
    await main(piArgs, {
      extensionFactories: [{ name: "hengflow-v2", factory: createHengFlowExtension(config) }],
    });
    if (panelLedger) {
      const board = getProcessTaskBoard();
      if (board) process.stderr.write(`\n${renderTaskBoard(board).join("\n")}\n`);
      const panel = renderCostPanel(panelLedger.getCostBreakdown(callBaseline));
      process.stderr.write(`\n${panel.join("\n")}\n`);
    }
  } finally {
    panelLedger?.close();
  }
}

run().catch((error) => {
  console.error(`hengflow-v2: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
