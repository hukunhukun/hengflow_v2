import assert from "node:assert/strict";
import test from "node:test";
import { hashSeed, SeededRandom } from "../rng.js";

test("same seed produces identical sequences", () => {
  const left = new SeededRandom(42);
  const right = new SeededRandom(42);
  for (let index = 0; index < 100; index++) assert.equal(left.next(), right.next());
});

test("different seeds diverge and uniforms stay in [0,1)", () => {
  const rng = new SeededRandom(7);
  for (let index = 0; index < 1000; index++) {
    const value = rng.next();
    assert.ok(value >= 0 && value < 1);
  }
  assert.notEqual(new SeededRandom(1).next(), new SeededRandom(2).next());
});

test("beta draws stay in (0,1) and converge to the analytic mean", () => {
  const rng = new SeededRandom(123);
  let sum = 0;
  const draws = 4000;
  for (let index = 0; index < draws; index++) {
    const value = rng.beta(5, 3);
    assert.ok(value > 0 && value < 1);
    sum += value;
  }
  const mean = sum / draws;
  assert.ok(Math.abs(mean - 5 / 8) < 0.05, `beta mean drifted: ${mean}`);
});

test("beta handles extreme and degenerate parameters", () => {
  const rng = new SeededRandom(9);
  const extreme = rng.beta(1000, 0.05);
  assert.ok(extreme > 0.5);
  assert.equal(rng.beta(0, 3), 0.5);
  assert.equal(rng.beta(-1, 2), 0.5);
});

test("gamma draws are positive for small and large shapes", () => {
  const rng = new SeededRandom(2024);
  for (const shape of [0.1, 0.5, 1, 2.5, 50]) {
    for (let index = 0; index < 50; index++) {
      const value = rng.gamma(shape);
      assert.ok(value > 0, `gamma(${shape}) produced ${value}`);
    }
  }
});

test("hashSeed is stable and seed-dependent", () => {
  assert.equal(hashSeed("a", "b"), hashSeed("a", "b"));
  assert.notEqual(hashSeed("a", "b"), hashSeed("b", "a"));
});
