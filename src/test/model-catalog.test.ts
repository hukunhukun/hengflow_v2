import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_CONFIG, type HengFlowConfig } from "../config.js";
import { discoverWorkers } from "../model-catalog.js";

const models = [
  { provider: DEFAULT_CONFIG.manager.provider, id: DEFAULT_CONFIG.manager.model, name: "Manager", reasoning: true, contextWindow: 272000, cost: { input: 5, output: 30 } },
  { provider: "anthropic", id: "claude-sonnet", name: "Claude", reasoning: true, contextWindow: 200000, cost: { input: 3, output: 15, cacheRead: 0.3 } },
  { provider: "moonshot", id: "kimi-k2", name: "Kimi", reasoning: true, contextWindow: 256000, cost: { input: 0.6, output: 3 } },
];

test("does not auto-discover Workers before explicit model setup", () => {
  assert.deepEqual(discoverWorkers({ getAvailable: () => models }, DEFAULT_CONFIG), []);
});

test("returns only explicitly selected and authenticated Workers", () => {
  const config: HengFlowConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    modelsConfigured: true,
    workers: {
      claude: {
        id: "claude",
        provider: "anthropic",
        model: "claude-sonnet",
        thinking: "high",
        quality: 0.91,
        inputUsdPerMillion: 3,
        cachedInputUsdPerMillion: 0.3,
        outputUsdPerMillion: 15,
      },
    },
  };
  const workers = discoverWorkers({ getAvailable: () => models }, config);
  assert.deepEqual(workers.map((worker) => worker.id), ["claude"]);
  assert.equal(workers[0].thinking, "high");
  assert.equal(workers[0].quality, 0.91);
});

test("omits selected Workers that are unavailable or duplicate the Manager", () => {
  const config: HengFlowConfig = {
    ...structuredClone(DEFAULT_CONFIG),
    modelsConfigured: true,
    workers: {
      managerDuplicate: { ...DEFAULT_CONFIG.manager, id: "managerDuplicate" },
      missing: {
        id: "missing",
        provider: "missing",
        model: "missing-model",
        thinking: "off",
        quality: 0.5,
        inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
      },
    },
  };
  assert.deepEqual(discoverWorkers({ getAvailable: () => models }, config), []);
});
