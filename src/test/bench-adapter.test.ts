import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildMbppPrompt, extractPythonCode, judgeMbpp, pythonAvailable, type MbppTask } from "../bench/mbpp.js";
import { prepareRunDir } from "../bench/runner.js";
import type { ModelRef } from "../types.js";

const gpt: ModelRef = {
  id: "openai-codex/gpt-5.6-sol", provider: "openai-codex", model: "gpt-5.6-sol",
  thinking: "high", quality: 0.96,
  inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30,
};
const deepseek: ModelRef = {
  id: "deepseek/deepseek-v4-flash", provider: "deepseek", model: "deepseek-v4-flash",
  thinking: "max", quality: 0.79,
  inputUsdPerMillion: 0.14, cachedInputUsdPerMillion: 0.0028, outputUsdPerMillion: 0.28,
};
const glm: ModelRef = {
  id: "zai-coding-cn/glm-5.3", provider: "zai-coding-cn", model: "glm-5.3",
  thinking: "max", quality: 0.87,
  inputUsdPerMillion: 1.4, cachedInputUsdPerMillion: 0.26, outputUsdPerMillion: 4.4,
};

const task: MbppTask = {
  taskId: "mbpp-1",
  prompt: "Write a function to find the minimum cost path...",
  testImports: [],
  testSetupCode: "R = 3\nC = 3",
  testList: ["assert add(1, 2) == 3", "assert add(-1, 1) == 0"],
};

test("extracts the last python code block and falls back to raw text", () => {
  const answer = "Intro\n```python\nbroken(\n```\nFinal:\n```python\ndef add(a, b):\n    return a + b\n```";
  assert.equal(extractPythonCode(answer)?.trim(), "def add(a, b):\n    return a + b");
  assert.equal(extractPythonCode("def add(a, b):\n    return a + b"), "def add(a, b):\n    return a + b");
  assert.equal(extractPythonCode("no code at all"), "no code at all");
});

test("mbpp prompt asks for one fenced python block", () => {
  const prompt = buildMbppPrompt(task);
  assert.ok(prompt.includes(task.prompt));
  assert.ok(prompt.includes("```python"));
});

test("judge accepts a correct solution and rejects a wrong one (needs python3)", () => {
  if (!pythonAvailable()) return;
  const setupTask: MbppTask = { ...task, testList: ["assert R + C == 6"] };
  const good = judgeMbpp("```python\ndef add(a, b):\n    return a + b\n```", task);
  assert.equal(good.resolved, true);
  // Setup code must run before the asserts for them to see R/C.
  const needsSetup = judgeMbpp("```python\ndef add(a, b):\n    return a + b\n```", setupTask);
  assert.equal(needsSetup.resolved, true);
  const bad = judgeMbpp("```python\ndef add(a, b):\n    return a - b\n```", task);
  assert.equal(bad.resolved, false);
  const syntaxError = judgeMbpp("```python\ndef broken(:\n```", task);
  assert.equal(syntaxError.resolved, false);
});

test("prepareRunDir writes an isolated bench config with frozen prices", () => {
  const previousAgent = process.env.HENGFLOW_AGENT_DIR;
  const outRoot = mkdtempSync(join(tmpdir(), "hengflow-bench-"));
  const realAgent = mkdtempSync(join(tmpdir(), "hengflow-bench-agent-"));
  process.env.HENGFLOW_AGENT_DIR = realAgent;
  try {
    const options = {
      benchId: "mbpp" as const,
      limit: 1,
      variants: [{ kind: "learned" } as const],
      repeats: 1,
      outRoot,
      ledgerMode: "isolated" as const,
      userPool: [gpt, deepseek, glm],
    };
    const single = prepareRunDir(options, task, { kind: "single", model: "deepseek/deepseek-v4-flash" }, 1);
    const parsedSingle = JSON.parse(readFileSync(join(single.agentDir, "config.json"), "utf8"));
    assert.equal(parsedSingle.modelsConfigured, true);
    assert.equal(parsedSingle.pool.length, 3);
    assert.equal(parsedSingle.bench.variant, "single");
    assert.equal(parsedSingle.bench.singleModel, "deepseek/deepseek-v4-flash");
    assert.equal(parsedSingle.bench.taskId, "mbpp-1");
    assert.ok(existsSync(join(single.runDir, "data")));

    const frozen = prepareRunDir(
      { ...options, ledgerMode: "frozen" as const },
      task,
      { kind: "learned_frozen" },
      2,
    );
    const parsedFrozen = JSON.parse(readFileSync(join(frozen.agentDir, "config.json"), "utf8"));
    assert.equal(parsedFrozen.bench.variant, "learned_frozen");
    assert.equal(parsedFrozen.bench.freezeLearning, true);
    assert.equal(parsedFrozen.bench.seed, frozen.seed);

    // Session mode shares one ledger dir across runs.
    const sessionA = prepareRunDir({ ...options, ledgerMode: "session" as const }, task, { kind: "learned" }, 1);
    const sessionB = prepareRunDir({ ...options, ledgerMode: "session" as const }, task, { kind: "learned" }, 2);
    assert.equal(sessionA.dataDir, sessionB.dataDir);
  } finally {
    if (previousAgent === undefined) delete process.env.HENGFLOW_AGENT_DIR;
    else process.env.HENGFLOW_AGENT_DIR = previousAgent;
    rmSync(outRoot, { recursive: true, force: true });
    rmSync(realAgent, { recursive: true, force: true });
  }
});
