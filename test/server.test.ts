import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import type { BridgeConfig } from "../src/config/config.js";
import { startBridgeServer, type CodexClientLike } from "../src/server/app.js";
import type { ResponsesRequest } from "../src/protocol/types.js";
import { codexSse, completeTextEvents, writeCodexAuth } from "./helpers.js";

test("serves authenticated Anthropic-compatible endpoints without writing Codex auth", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-server-"));
  await writeCodexAuth(home);
  const authPath = path.join(home, "auth.json");
  const before = await stat(authPath);
  const requests: ResponsesRequest[] = [];
  const client: CodexClientLike = {
    async createResponse(request) {
      requests.push(request);
      return codexSse(completeTextEvents("bridge response"));
    },
    async listModels() {
      return [{ id: "gpt-test", displayName: "GPT Test" }];
    }
  };
  const config: BridgeConfig = {
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-secret",
    codexHome: home,
    codexBaseUrl: "https://example.invalid",
    codexClientVersion: "0.139.0",
    defaultEffort: "medium",
    bodyLimitBytes: 1024 * 1024,
    logLevel: "silent"
  };
  const running = await startBridgeServer({
    config,
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    codexClient: client
  });
  try {
    const health = await fetch(`${running.url}/health`);
    assert.equal(health.status, 200);

    const unauthorized = await fetch(`${running.url}/v1/models`);
    assert.equal(unauthorized.status, 401);

    const headers = { "x-api-key": "local-secret", "content-type": "application/json" };
    const models = await fetch(`${running.url}/v1/models`, { headers });
    assert.equal(models.status, 200);
    assert.equal((await models.json() as { data: unknown[] }).data.length, 1);

    const count = await fetch(`${running.url}/v1/messages/count_tokens`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-test", messages: [{ role: "user", content: "hello" }] })
    });
    assert.equal(count.status, 200);
    assert.equal(typeof (await count.json() as { input_tokens: number }).input_tokens, "number");

    const messages = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-test", max_tokens: 100, messages: [{ role: "user", content: "hello" }] })
    });
    const message = await messages.json() as { content: Array<{ text?: string }> };
    assert.equal(message.content[0]?.text, "bridge response");
    assert.equal(requests[0]?.store, false);
    assert.deepEqual(requests[0]?.include, ["reasoning.encrypted_content"]);

    const status = await fetch(`${running.url}/auth/status`, { headers });
    assert.equal((await status.json() as { state: string }).state, "ready");
  } finally {
    await running.close();
  }
  const after = await stat(authPath);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.size, before.size);
});
