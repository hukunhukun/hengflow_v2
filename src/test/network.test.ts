import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_HTTP_PROXY, resolveHttpProxy } from "../network.js";

test("uses the local proxy when no environment or setting is configured", () => {
  assert.equal(resolveHttpProxy({}), DEFAULT_HTTP_PROXY);
});

test("prefers explicit proxy environment over settings and the local default", () => {
  assert.equal(
    resolveHttpProxy({ HTTPS_PROXY: "http://127.0.0.1:9000" }, "http://127.0.0.1:8000"),
    "http://127.0.0.1:9000",
  );
});

test("uses the runtime proxy setting before the local default", () => {
  assert.equal(resolveHttpProxy({}, "http://127.0.0.1:8000"), "http://127.0.0.1:8000");
});
