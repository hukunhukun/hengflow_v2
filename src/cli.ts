#!/usr/bin/env node
import { join, resolve } from "node:path";
import { main, ModelRuntime } from "./runtime/agent.js";
import { authStatus, importApiKeys } from "./auth.js";
import { getAgentDir, loadConfig } from "./config.js";
import { configureNetworkProxy } from "./network.js";

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
  await configureNetworkProxy();
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
