import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig, savePoolSelection } from "../config.js";
import type { ModelRef } from "../types.js";

const gpt: ModelRef = {
  id: "openai-codex/gpt-5.6-sol", provider: "openai-codex", model: "gpt-5.6-sol",
  thinking: "high", quality: 0.96,
  inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30,
};
const glm: ModelRef = {
  id: "zai-coding-cn/glm-5.3", provider: "zai-coding-cn", model: "glm-5.3",
  thinking: "max", quality: 0.87,
  inputUsdPerMillion: 1.4, cachedInputUsdPerMillion: 0.26, outputUsdPerMillion: 4.4,
};
const deepseek: ModelRef = {
  id: "deepseek/deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash",
  thinking: "max", quality: 0.79,
  inputUsdPerMillion: 0.14, cachedInputUsdPerMillion: 0.0028, outputUsdPerMillion: 0.28,
};

function withTempAgentDir<T>(fn: (dir: string) => T): T {
  const previous = process.env.HENGFLOW_AGENT_DIR;
  const dir = mkdtempSync(join(tmpdir(), "hengflow-pool-"));
  process.env.HENGFLOW_AGENT_DIR = dir;
  try {
    return fn(dir);
  } finally {
    if (previous === undefined) delete process.env.HENGFLOW_AGENT_DIR;
    else process.env.HENGFLOW_AGENT_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("legacy manager+workers configs fold into a v4 pool with the manager as anchor", () => {
  withTempAgentDir(() => {
    const legacy = {
      modelsConfigured: true,
      manager: { ...gpt, id: "manager" },
      workers: { glm, deepseek },
      routing: { maxConcurrency: 7 },
    };
    const path = join(process.env.HENGFLOW_AGENT_DIR!, "config.json");
    writeFileSync(path, `${JSON.stringify(legacy)}\n`);

    const config = loadConfig();
    assert.equal(config.pool.length, 3);
    assert.equal(config.pool[0].provider, gpt.provider);
    assert.equal(config.pool[0].model, gpt.model);
    assert.equal(config.manager.model, gpt.model);
    assert.equal(Object.keys(config.workers).length, 2);
    assert.equal(config.routing.maxConcurrency, 7);
    // Deduped by provider/model with canonical ids.
    for (const model of config.pool) assert.match(model.id, /^[^/]+\/[^/]+$/);
  });
});

test("savePoolSelection persists the canonical pool and round-trips through loadConfig", () => {
  withTempAgentDir(() => {
    savePoolSelection([gpt, deepseek, glm]);
    const saved = JSON.parse(readFileSync(join(process.env.HENGFLOW_AGENT_DIR!, "config.json"), "utf8"));
    assert.equal(saved.modelsConfigured, true);
    assert.equal(saved.pool.length, 3);

    const config = loadConfig();
    assert.deepEqual(
      config.pool.map((model) => `${model.provider}/${model.model}`),
      ["openai-codex/gpt-5.6-sol", "deepseek/deepseek-v4-flash", "zai-coding-cn/glm-5.3"],
    );
    assert.equal(config.manager.model, gpt.model);
    assert.equal(Object.values(config.workers).length, 2);
  });
});

test("savePoolSelection preserves unrelated settings and enforces validation", () => {
  withTempAgentDir(() => {
    const path = join(process.env.HENGFLOW_AGENT_DIR!, "config.json");
    writeFileSync(path, `${JSON.stringify({ routing: { maxTasks: 5 }, custom: "keep" })}\n`);
    savePoolSelection([gpt, glm]);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(saved.routing.maxTasks, 5);
    assert.equal(saved.custom, "keep");

    assert.throws(() => savePoolSelection([gpt]), /至少 2 个模型/);
    assert.throws(() => savePoolSelection([gpt, { ...gpt, id: "dup" }]), /重复模型/);
    assert.throws(() => savePoolSelection([gpt, { ...glm, inputUsdPerMillion: Number.NaN }]), /价格/);
  });
});

test("v4 pool configs win over legacy fields when both are present", () => {
  withTempAgentDir(() => {
    const mixed = {
      modelsConfigured: true,
      pool: [deepseek, glm],
      manager: { ...gpt, id: "manager" },
      workers: {},
    };
    writeFileSync(join(process.env.HENGFLOW_AGENT_DIR!, "config.json"), `${JSON.stringify(mixed)}\n`);
    const config = loadConfig();
    assert.equal(config.pool.length, 2);
    assert.equal(config.manager.model, deepseek.model);
    assert.equal(config.pool[0].model, deepseek.model);
  });
});
