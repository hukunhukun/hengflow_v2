import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_CONFIG, saveModelSelection } from "../config.js";

const worker = {
  ...DEFAULT_CONFIG.workers.deepseek,
  id: "deepseek/deepseek-v4-flash",
  thinking: "high" as const,
};

test("persists explicit Manager and Worker selection without dropping other settings", () => {
  const dir = mkdtempSync(join(tmpdir(), "hengflow-config-"));
  try {
    const path = join(dir, "config.json");
    const existing = { routing: { maxConcurrency: 7 }, custom: "preserved" };
    writeFileSync(path, `${JSON.stringify(existing)}\n`);
    const manager = { ...DEFAULT_CONFIG.manager, thinking: "high" as const };
    saveModelSelection(manager, { [worker.id]: worker }, dir);

    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.modelsConfigured, true);
    assert.equal(saved.manager.id, "manager");
    assert.equal(saved.manager.thinking, "high");
    assert.equal(saved.workers[worker.id].thinking, "high");
    assert.equal(saved.routing.maxConcurrency, 7);
    assert.equal(saved.custom, "preserved");
    assert.equal(statSync(path).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
