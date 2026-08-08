import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BridgeApiKeyStore } from "../src/config/api-key-store.js";
import { BridgeError } from "../src/errors.js";

test("creates and reuses a protected API key under the bridge home", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-key-"));
  const bridgeHome = path.join(parent, ".cb");
  const firstStore = new BridgeApiKeyStore({ bridgeHome, now: () => new Date("2026-08-08T00:00:00Z") });
  const first = await firstStore.getOrCreate();
  const second = await new BridgeApiKeyStore({ bridgeHome }).getOrCreate();

  assert.match(first, /^cb_[A-Za-z0-9_-]{43}$/);
  assert.equal(second, first);
  const stored = JSON.parse(await readFile(path.join(bridgeHome, "config.json"), "utf8")) as Record<string, unknown>;
  assert.deepEqual(stored, { version: 1, apiKey: first, createdAt: "2026-08-08T00:00:00.000Z" });
  if (process.platform !== "win32") {
    assert.equal((await stat(bridgeHome)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(bridgeHome, "config.json"))).mode & 0o777, 0o600);
  }
});

test("refresh replaces the key and subsequent reads observe it", async () => {
  const bridgeHome = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-refresh-"));
  const store = new BridgeApiKeyStore({ bridgeHome });
  const first = await store.getOrCreate();
  const refreshed = await store.refresh();

  assert.notEqual(refreshed, first);
  assert.equal(await store.read(), refreshed);
});

test("concurrent first use converges on one stored key", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-concurrent-"));
  const bridgeHome = path.join(parent, ".cb");
  const stores = Array.from({ length: 8 }, () => new BridgeApiKeyStore({ bridgeHome }));
  const keys = await Promise.all(stores.map((store) => store.getOrCreate()));
  assert.equal(new Set(keys).size, 1);
  assert.equal(await stores[0]!.read(), keys[0]);
});

test("malformed configuration is rejected and can be explicitly refreshed", async () => {
  const bridgeHome = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-invalid-key-"));
  await writeFile(path.join(bridgeHome, "config.json"), '{"apiKey":"bad"}\n', "utf8");
  const store = new BridgeApiKeyStore({ bridgeHome });

  await assert.rejects(
    () => store.getOrCreate(),
    (error: unknown) => error instanceof BridgeError && error.code === "BRIDGE_API_KEY_INVALID"
  );
  const refreshed = await store.refresh();
  assert.equal(await store.read(), refreshed);
});
