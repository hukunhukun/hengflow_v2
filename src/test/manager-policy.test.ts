import assert from "node:assert/strict";
import test from "node:test";
import { routingGate, shouldBlockTool } from "../manager-policy.js";

test("manager policy blocks tools until a plan exists", () => {
  assert.equal(shouldBlockTool("execute_plan", false), undefined);
  assert.match(shouldBlockTool("read", false) ?? "", /execute_plan/);
  assert.equal(shouldBlockTool("read", true), undefined);
  assert.match(routingGate(true), /required="true"/);
});
