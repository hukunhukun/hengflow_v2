import assert from "node:assert/strict";
import test from "node:test";
import { resolveHttpProxy } from "../network.js";

test("does not configure a proxy by default", () => {
  assert.equal(resolveHttpProxy({}), undefined);
});

test("prefers an explicit proxy environment over the runtime setting", () => {
  assert.equal(
    resolveHttpProxy({ HTTPS_PROXY: "http://127.0.0.1:9000" }, "http://127.0.0.1:8000"),
    "http://127.0.0.1:9000",
  );
});

test("uses the runtime proxy setting when configured", () => {
  assert.equal(resolveHttpProxy({}, "http://127.0.0.1:8000"), "http://127.0.0.1:8000");
});
