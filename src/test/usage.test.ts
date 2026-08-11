import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UsageLedger } from "../ledger.js";
import { displayWidth } from "../ui-layout.js";
import { latestQuotaReports, parseCodexHeaders, renderUsagePanel } from "../usage.js";

test("parses Codex primary and secondary quota headers", () => {
  const report = parseCodexHeaders({
    "x-codex-primary-used-percent": "37",
    "x-codex-primary-window-minutes": "300",
    "x-codex-primary-reset-at": "1800000000",
    "x-codex-secondary-used-percent": "12.5",
    "x-codex-secondary-window-minutes": "10080",
  }, 1000);
  assert.ok(report);
  assert.equal(report.limits.length, 2);
  assert.equal(report.limits[0].label, "5h");
  assert.equal(report.limits[0].remaining, 63);
  assert.equal(report.limits[1].label, "168h");
});

test("ignores unrelated provider headers", () => {
  assert.equal(parseCodexHeaders({ "content-type": "application/json" }), undefined);
});

test("footer quota collection always includes the configured Manager provider", () => {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-quota-collection-"));
  const ledger = new UsageLedger(join(dir, "usage.sqlite"));
  try {
    ledger.recordQuota({ provider: "custom-manager", fetchedAt: Date.now(), source: "response-headers", limits: [] });
    ledger.recordQuota({ provider: "custom-worker", fetchedAt: Date.now(), source: "local-ledger", limits: [] });
    const reports = latestQuotaReports(ledger, "custom-manager", ["custom-worker"]);
    assert.deepEqual(reports.map((report) => report.provider), ["custom-manager", "custom-worker"]);
  } finally {
    ledger.close();
  }
});

test("renders quota windows as a responsive structured usage panel", () => {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-usage-panel-"));
  const ledger = new UsageLedger(join(dir, "usage.sqlite"));
  try {
    const reports = [
      {
        provider: "deepseek", fetchedAt: Date.now(), source: "official-api" as const,
        limits: [{ id: "ds", label: "Balance CNY", remaining: 406.27, unit: "money" as const, currency: "CNY" }],
      },
      {
        provider: "zai-coding-cn", fetchedAt: Date.now(), source: "provider-private-api" as const,
        limits: [
          { id: "5h", label: "5h Token", remaining: 94, limit: 100, unit: "tokens" as const },
          { id: "1w", label: "1w Token", remaining: 89, limit: 100, unit: "tokens" as const },
          { id: "1mo", label: "1mo Request", remaining: 990, limit: 1000, unit: "requests" as const },
        ],
      },
    ];
    const lines = renderUsagePanel(reports, ledger, 100);
    const panel = lines.join("\n");
    assert.match(panel, /HENGFLOW · USAGE/);
    assert.match(panel, /WORKER · DeepSeek/);
    assert.match(panel, /Balance CNY\s+Balance ¥406/);
    assert.match(panel, /5h Token\s+░*█?.*Used 6\/100 · Left 94\/100/);
    assert.match(panel, /1w Token\s+█.*Used 11\/100 · Left 89\/100/);
    assert.doesNotMatch(panel, /1mo Request/);
    assert.equal(lines.filter((line) => /(?:5h|1w) Token/.test(line)).length, 2);
    assert.doesNotMatch(panel, /[\u4e00-\u9fff]/);
    assert.ok(lines.every((line) => displayWidth(line) <= 100));
  } finally {
    ledger.close();
  }
});
