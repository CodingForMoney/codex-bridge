import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config/config.js";

test("defaults to two transient retries and accepts explicit retry limits", () => {
  assert.equal(loadConfig({}, "test-key").maxRetries, 2);
  for (const maxRetries of [0, 1, 5]) {
    assert.equal(loadConfig({ CODEX_BRIDGE_MAX_RETRIES: String(maxRetries) }, "test-key").maxRetries, maxRetries);
  }
});

test("rejects invalid transient retry limits", () => {
  for (const value of ["-1", "6", "1.5", "unlimited"]) {
    assert.throws(() => loadConfig({ CODEX_BRIDGE_MAX_RETRIES: value }, "test-key"), /CODEX_BRIDGE_MAX_RETRIES must be an integer from 0 to 5/);
  }
});
