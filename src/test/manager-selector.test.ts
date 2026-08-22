import assert from "node:assert/strict";
import test from "node:test";
import { managerKey, selectManager, type ManagerProfile } from "../manager-selector.js";
import { SeededRandom } from "../rng.js";
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

function profiles(entries: Array<[ModelRef, number, number]>): Map<string, ManagerProfile> {
  return new Map(entries.map(([model, samples, successes]) =>
    [managerKey(model), { model, samples, successes }]));
}

test("write turns with only cold challengers fall back to the anchor", () => {
  // With the bootstrap allowance disabled (max 0 exploratory turns) cold
  // challengers stay locked out and the anchor serves write turns.
  const selection = selectManager({
    pool: [gpt, deepseek],
    profiles: profiles([[gpt, 0, 0], [deepseek, 0, 0]]),
    requiresWrite: true,
    maxExploratoryWriteTurns: 0,
    rng: new SeededRandom(1),
  });
  assert.equal(selection.selectedId, managerKey(gpt));
  assert.equal(selection.isAnchor, true);
  assert.equal(selection.draws.find((draw) => draw.id === managerKey(deepseek))?.eligible, false);
});

test("bootstrap allowance lets a 0-sample challenger take bounded exploratory write turns", () => {
  const ledger = new Map<string, { turns: number; failures: number }>();
  // First exploratory turn is allowed.
  const first = selectManager({
    pool: [gpt, deepseek], profiles: profiles([[gpt, 0, 0], [deepseek, 0, 0]]),
    requiresWrite: true, rng: new SeededRandom(1), explorationLedger: ledger,
  });
  assert.equal(first.exploratory, true);
  assert.ok(ledger.get(managerKey(deepseek))!.turns <= 2);
  // After exhausting the allowance the challenger is locked out again.
  ledger.set(managerKey(deepseek), { turns: 2, failures: 0 });
  const exhausted = selectManager({
    pool: [gpt, deepseek], profiles: profiles([[gpt, 0, 0], [deepseek, 0, 0]]),
    requiresWrite: true, rng: new SeededRandom(1), explorationLedger: ledger,
  });
  assert.equal(exhausted.selectedId, managerKey(gpt));
  // A single failure also revokes the allowance immediately.
  ledger.set(managerKey(deepseek), { turns: 1, failures: 1 });
  const revoked = selectManager({
    pool: [gpt, deepseek], profiles: profiles([[gpt, 0, 0], [deepseek, 0, 0]]),
    requiresWrite: true, rng: new SeededRandom(1), explorationLedger: ledger,
  });
  assert.equal(revoked.selectedId, managerKey(gpt));
});

test("a validated challenger displaces a failing anchor on write turns across seeds", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const selection = selectManager({
      pool: [gpt, glm],
      profiles: profiles([[gpt, 50, 5], [glm, 40, 40]]),
      requiresWrite: true,
      rng: new SeededRandom(seed),
    });
    assert.equal(selection.selectedId, managerKey(glm), `seed=${seed}`);
    assert.equal(selection.isAnchor, false);
  }
});

test("large session history keeps the champion despite a cheaper challenger", () => {
  const champion = { ...glm, cachedInputUsdPerMillion: 10 };
  for (const seed of [1, 2, 3, 4, 5]) {
    const selection = selectManager({
      pool: [gpt, champion, deepseek],
      profiles: profiles([[gpt, 0, 0], [champion, 60, 55], [deepseek, 60, 60]]),
      requiresWrite: true,
      sessionHistoryTokens: 200_000,
      championId: managerKey(champion),
      rng: new SeededRandom(seed),
    });
    assert.equal(selection.selectedId, managerKey(champion), `seed=${seed}`);
    assert.equal(selection.switched, false);
  }
});

test("selection is deterministic for identical input and seed", () => {
  const pool = [gpt, glm, deepseek];
  const stats = profiles([[gpt, 10, 9], [glm, 12, 10], [deepseek, 30, 20]]);
  const first = selectManager({ pool, profiles: stats, sessionHistoryTokens: 5_000, rng: new SeededRandom(77) });
  const second = selectManager({ pool, profiles: stats, sessionHistoryTokens: 5_000, rng: new SeededRandom(77) });
  assert.equal(first.selectedId, second.selectedId);
  assert.equal(first.sampledUtilityUsd, second.sampledUtilityUsd);
  assert.deepEqual(first.draws, second.draws);
});

test("fewer than two pool models is rejected", () => {
  assert.throws(() => selectManager({ pool: [gpt], rng: new SeededRandom(1) }));
});

test("champion stickiness survives across consecutive turns", () => {
  const pool = [gpt, glm];
  const stats = profiles([[gpt, 8, 8], [glm, 20, 19]]);
  let champion: string | undefined;
  const picks = new Set<string>();
  for (let turn = 0; turn < 10; turn++) {
    const selection = selectManager({
      pool,
      profiles: stats,
      sessionHistoryTokens: 20_000,
      championId: champion,
      rng: new SeededRandom(1000 + turn),
    });
    picks.add(selection.selectedId);
    champion = selection.nextChampionId;
  }
  // With one clearly stronger model, at most two distinct managers should
  // ever serve; never all-over-the-place flapping.
  assert.ok(picks.size <= 2, `picked=${[...picks].join(",")}`);
});
