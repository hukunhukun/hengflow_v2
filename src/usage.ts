import type { ModelRuntime } from "./runtime/agent.js";
import type { UsageLedger } from "./ledger.js";
import type { QuotaLimit, QuotaReport } from "./types.js";
import { displayWidth, truncateDisplay } from "./ui-layout.js";

export interface AuthResolver {
  getAuth(provider: string): Promise<{ auth: { apiKey?: string; headers?: Record<string, string | null>; baseUrl?: string }; source?: string } | undefined>;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseReset(value: unknown): number | undefined {
  const parsed = numberValue(value);
  if (parsed === undefined) return undefined;
  return parsed > 1_000_000_000_000 ? parsed : parsed * 1000;
}

function jwtAccountId(token: string): string | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64url").toString("utf8"));
    return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
  } catch {
    return undefined;
  }
}

export function parseCodexHeaders(headers: Record<string, string>, now = Date.now()): QuotaReport | undefined {
  const limits: QuotaLimit[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const used = numberValue(headers[`x-codex-${key}-used-percent`]);
    if (used === undefined) continue;
    const resetAt = parseReset(headers[`x-codex-${key}-reset-at`]);
    const minutes = numberValue(headers[`x-codex-${key}-window-minutes`]);
    limits.push({
      id: `openai-codex:${key}`,
      label: minutes ? `${Math.round(minutes / 60)}h` : key,
      used,
      remaining: Math.max(0, 100 - used),
      limit: 100,
      unit: "percent",
      resetAt,
    });
  }
  if (limits.length === 0) return undefined;
  return { provider: "openai-codex", fetchedAt: now, source: "response-headers", limits };
}

export async function fetchCodexUsage(authResolver: AuthResolver, signal?: AbortSignal): Promise<QuotaReport> {
  const fetchedAt = Date.now();
  try {
    const result = await authResolver.getAuth("openai-codex");
    const token = result?.auth.apiKey;
    if (!token) throw new Error("OpenAI Codex OAuth is not signed in");
    const baseUrl = (result?.auth.baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, "User-Agent": "hengflow/0.1" };
    const accountId = jwtAccountId(token);
    if (accountId) headers["ChatGPT-Account-Id"] = accountId;
    const response = await fetch(`${baseUrl}/wham/usage`, { headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = recordValue(await response.json());
    const rateLimit = recordValue(payload?.rate_limit);
    const limits: QuotaLimit[] = [];
    for (const key of ["primary", "secondary"] as const) {
      const window = recordValue(rateLimit?.[`${key}_window`]);
      if (!window) continue;
      const used = numberValue(window.used_percent);
      const seconds = numberValue(window.limit_window_seconds);
      limits.push({
        id: `openai-codex:${key}`,
        label: seconds ? (seconds >= 86400 ? `${Math.round(seconds / 86400)}d` : `${Math.round(seconds / 3600)}h`) : key,
        used,
        remaining: used === undefined ? undefined : Math.max(0, 100 - used),
        limit: 100,
        unit: "percent",
        resetAt: parseReset(window.reset_at) ?? (numberValue(window.reset_after_seconds) ? fetchedAt + Number(window.reset_after_seconds) * 1000 : undefined),
      });
    }
    return {
      provider: "openai-codex", fetchedAt, source: "provider-private-api", limits,
      note: typeof payload?.plan_type === "string" ? `plan=${payload.plan_type}` : undefined,
    };
  } catch (error) {
    return { provider: "openai-codex", fetchedAt, source: "provider-private-api", limits: [], error: String(error) };
  }
}

export async function fetchDeepSeekUsage(authResolver: AuthResolver, signal?: AbortSignal): Promise<QuotaReport> {
  const fetchedAt = Date.now();
  try {
    const result = await authResolver.getAuth("deepseek");
    const key = result?.auth.apiKey;
    if (!key) throw new Error("DeepSeek is not signed in");
    const response = await fetch("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = recordValue(await response.json());
    const balanceInfos = Array.isArray(payload?.balance_infos) ? payload.balance_infos : [];
    const limits = balanceInfos.flatMap((raw, index) => {
      const item = recordValue(raw);
      if (!item) return [];
      const balance = numberValue(item?.total_balance);
      if (balance === undefined) return [];
      return [{
        id: `deepseek:balance:${index}`,
        label: `Balance ${String(item?.currency ?? "USD")}`,
        remaining: balance,
        unit: "money" as const,
        currency: String(item?.currency ?? "USD"),
      }];
    });
    return { provider: "deepseek", fetchedAt, source: "official-api", limits };
  } catch (error) {
    return { provider: "deepseek", fetchedAt, source: "official-api", limits: [], error: String(error) };
  }
}

function zaiWindowLabel(unit?: number, count = 1): string {
  if (unit === 3) return `${count}h`;
  if (unit === 4) return `${count}d`;
  if (unit === 5) return `${count}mo`;
  if (unit === 6) return "1w";
  return "quota";
}

export async function fetchGlmUsage(authResolver: AuthResolver, signal?: AbortSignal): Promise<QuotaReport> {
  const fetchedAt = Date.now();
  try {
    const result = await authResolver.getAuth("zai-coding-cn");
    const key = result?.auth.apiKey;
    if (!key) throw new Error("GLM Coding Plan is not signed in");
    const baseUrl = new URL(result?.auth.baseUrl || "https://open.bigmodel.cn").origin;
    const response = await fetch(`${baseUrl}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: key, "Content-Type": "application/json", "User-Agent": "hengflow/0.1" }, signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = recordValue(await response.json());
    if (payload?.success !== true) throw new Error(String(payload?.msg || payload?.code || "invalid response"));
    const data = recordValue(payload.data);
    const rawLimits = Array.isArray(data?.limits) ? data.limits : [];
    const limits: QuotaLimit[] = [];
    for (const raw of rawLimits) {
      const item = recordValue(raw);
      if (!item) continue;
      const type = item?.type;
      if (type !== "TOKENS_LIMIT" && type !== "TIME_LIMIT") continue;
      const used = numberValue(item.currentValue);
      const limit = numberValue(item.usage);
      const remaining = numberValue(item.remaining);
      const percentage = numberValue(item.percentage);
      const label = zaiWindowLabel(numberValue(item.unit), numberValue(item.number) ?? 1);
      limits.push({
        id: `zai-coding-cn:${type === "TOKENS_LIMIT" ? "tokens" : "requests"}:${label}`,
        label: `${label} ${type === "TOKENS_LIMIT" ? "Token" : "Request"}`,
        used: used ?? percentage,
        remaining: remaining ?? (percentage === undefined ? undefined : Math.max(0, 100 - percentage)),
        limit: limit ?? (percentage === undefined ? undefined : 100),
        unit: type === "TOKENS_LIMIT" ? "tokens" : "requests",
        resetAt: parseReset(item.nextResetTime),
      });
    }
    return { provider: "zai-coding-cn", fetchedAt, source: "provider-private-api", limits };
  } catch (error) {
    return { provider: "zai-coding-cn", fetchedAt, source: "provider-private-api", limits: [], error: String(error) };
  }
}

export function latestQuotaReports(
  ledger: UsageLedger,
  managerProvider: string,
  workerProviders: readonly string[],
): QuotaReport[] {
  return [...new Set([managerProvider, ...workerProviders])].map((provider) =>
    ledger.getLatestQuota(provider) ?? {
      provider,
      fetchedAt: Date.now(),
      source: "local-ledger" as const,
      limits: [],
      note: "No provider quota adapter; local usage remains available",
    });
}

export async function fetchAllUsage(
  authResolver: AuthResolver | ModelRuntime,
  ledger: UsageLedger,
  cacheTtlMs: number,
  force = false,
  signal?: AbortSignal,
): Promise<QuotaReport[]> {
  const providers = ["openai-codex", "deepseek", "zai-coding-cn"];
  const cached = providers.map((provider) => ledger.getLatestQuota(provider));
  if (!force && cached.every((report) => report && Date.now() - report.fetchedAt < cacheTtlMs)) {
    return cached as QuotaReport[];
  }
  const reports = await Promise.all([
    fetchCodexUsage(authResolver, signal),
    fetchDeepSeekUsage(authResolver, signal),
    fetchGlmUsage(authResolver, signal),
  ]);
  for (const report of reports) ledger.recordQuota(report);
  return reports;
}

function compactNumber(value: number): string {
  if (value < 1000) return Math.round(value).toString();
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}m`;
}

function currency(value: number, code?: string): string {
  const symbol = code === "CNY" ? "¥" : code === "USD" || !code ? "$" : `${code} `;
  return `${symbol}${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}`;
}

function usedRatio(limit: QuotaLimit): number | undefined {
  const total = limit.unit === "percent" ? 100 : limit.limit;
  if (!total || total <= 0) return undefined;
  const used = limit.used ?? (limit.remaining === undefined ? undefined : Math.max(0, total - limit.remaining));
  return used === undefined ? undefined : Math.max(0, Math.min(1, used / total));
}

function quotaBar(ratio: number | undefined, width = 10): string {
  if (ratio === undefined) return "";
  const filled = Math.round(ratio * width);
  return ` ${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

function quotaValue(limit: QuotaLimit): string {
  if (limit.remaining === undefined) return "Unknown";
  if (limit.unit === "money") return `Balance ${currency(limit.remaining, limit.currency)}`;
  const total = limit.unit === "percent" ? 100 : limit.limit;
  if (!total || total <= 0) return `Left ${compactNumber(limit.remaining)}`;
  const used = limit.used ?? Math.max(0, total - limit.remaining);
  const usedValue = limit.unit === "percent" ? `${used.toFixed(1)}%` : `${compactNumber(used)}/${compactNumber(total)}`;
  const leftValue = limit.unit === "percent" ? `${limit.remaining.toFixed(1)}%` : `${compactNumber(limit.remaining)}/${compactNumber(total)}`;
  return `Used ${usedValue} · Left ${leftValue}`;
}

function resetText(resetAt?: number): string {
  if (!resetAt) return "";
  const date = new Date(resetAt);
  const stamp = new Intl.DateTimeFormat("en-US", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  return ` · Reset ${stamp}`;
}

function providerTitle(provider: string): string {
  if (provider === "openai-codex") return "MANAGER · OpenAI Codex";
  if (provider === "deepseek") return "WORKER · DeepSeek";
  if (provider === "zai-coding-cn") return "WORKER · GLM Coding Plan";
  return provider;
}

/** Keep Coding Plan output focused on its two actionable quota windows. */
export function displayedQuotaLimits(report: QuotaReport): readonly QuotaLimit[] {
  if (report.provider !== "zai-coding-cn") return report.limits;
  return ["5h", "1w"].flatMap((window) =>
    report.limits.find((limit) => limit.label === window || limit.label.startsWith(`${window} `)) ?? [],
  ).slice(0, 2);
}

/** Responsive structured panel shared by the TUI widget and the non-interactive CLI. */
export function renderUsagePanel(reports: QuotaReport[], ledger: UsageLedger, width = 100): string[] {
  const panelWidth = Math.max(36, width);
  const innerWidth = panelWidth - 2;
  const border = (left: string, label: string, right: string): string => {
    const text = truncateDisplay(` ${label} `, Math.max(1, innerWidth - 2));
    return `${left}${text}${"─".repeat(Math.max(0, panelWidth - displayWidth(left) - displayWidth(text) - displayWidth(right)))}${right}`;
  };
  const line = (text = ""): string => {
    const value = truncateDisplay(text, Math.max(1, innerWidth - 2));
    return `│ ${value}${" ".repeat(Math.max(0, innerWidth - displayWidth(value) - 1))}│`;
  };
  const lines = [border("╭─", "HENGFLOW · USAGE", "╮"), border("├─", "PROVIDER QUOTA", "┤")];

  for (const report of reports) {
    lines.push(line(`${providerTitle(report.provider)}  [${report.source}]`));
    if (report.error) {
      lines.push(line(`  × Quota unavailable · ${report.error}`));
      continue;
    }
    const limits = displayedQuotaLimits(report);
    if (limits.length === 0) lines.push(line("  · No quota windows available"));
    for (const limit of limits) {
      lines.push(line(`  ${limit.label.padEnd(14)} ${quotaBar(usedRatio(limit))} ${quotaValue(limit)}${resetText(limit.resetAt)}`));
    }
    if (report.note) lines.push(line(`  ${report.note}`));
  }

  const summary = ledger.getSummary();
  const stats = ledger.getModelStats();
  const glmInternalCost = stats
    .filter((stat) => stat.provider === "zai-coding-cn" || stat.model.toLowerCase().includes("glm"))
    .reduce((sum, stat) => sum + stat.calls * stat.averageShadowCostUsd, 0);
  lines.push(
    border("├─", "LOCAL USAGE", "┤"),
    line(`Total ${summary.calls} calls · ↑${compactNumber(summary.input)} ↓${compactNumber(summary.output)} · tracked $${Math.max(0, summary.shadowCostUsd - glmInternalCost).toFixed(4)} · provider $${summary.reportedCostUsd.toFixed(4)}`),
  );
  for (const stat of stats) {
    const economics = stat.provider === "zai-coding-cn" || stat.model.toLowerCase().includes("glm")
      ? "Coding Plan quota"
      : `$${stat.averageShadowCostUsd.toFixed(5)} avg`;
    lines.push(line(
      `${stat.model.padEnd(22)} ×${String(stat.calls).padStart(3)} · Success ${(stat.successRate * 100).toFixed(0)}% · ` +
      `Avg ↑${compactNumber(stat.averageInputTokens)} ↓${compactNumber(stat.averageOutputTokens)} · ${economics}`,
    ));
  }
  lines.push(
    border("├─", "PLAN ACCOUNTING", "┤"),
    line("GLM Coding Plan usage is displayed for the 5h / week quota windows."),
    `╰${"─".repeat(Math.max(0, panelWidth - 2))}╯`,
  );
  return lines;
}

export function formatUsageReports(reports: QuotaReport[], ledger: UsageLedger): string {
  return renderUsagePanel(reports, ledger).join("\n");
}
