import assert from "node:assert/strict";
import test from "node:test";
import { blockedByFailedDependency, readyTaskIds, validateTaskGraph } from "../graph.js";
import type { PlannedTask, TaskStatus } from "../types.js";

const base = {
  kind: "research" as const, risk: "low" as const, complexity: 0.4,
  estimatedInputTokens: 1000, estimatedOutputTokens: 200,
};
const tasks: PlannedTask[] = [
  { ...base, id: "root", objective: "root" },
  { ...base, id: "left", objective: "left", dependsOn: ["root"] },
  { ...base, id: "right", objective: "right", dependsOn: ["root"] },
  { ...base, id: "join", objective: "join", dependsOn: ["left", "right"] },
];

test("validates and activates a dependency graph wave by wave", () => {
  const graph = validateTaskGraph(tasks);
  assert.equal(graph.valid, true);
  assert.deepEqual(graph.order, ["root", "left", "right", "join"]);
  const statuses = new Map<string, TaskStatus>(tasks.map((task) => [task.id, "pending"]));
  assert.deepEqual(readyTaskIds(tasks, statuses), ["root"]);
  statuses.set("root", "completed");
  assert.deepEqual(readyTaskIds(tasks, statuses), ["left", "right"]);
  statuses.set("left", "completed");
  statuses.set("right", "failed");
  assert.equal(blockedByFailedDependency(tasks[3], statuses), true);
});

test("rejects unknown dependencies and cycles", () => {
  assert.equal(validateTaskGraph([{ ...base, id: "a", objective: "a", dependsOn: ["missing"] }]).valid, false);
  assert.match(validateTaskGraph([
    { ...base, id: "a", objective: "a", dependsOn: ["b"] },
    { ...base, id: "b", objective: "b", dependsOn: ["a"] },
  ]).errors.join(" "), /环/);
});
