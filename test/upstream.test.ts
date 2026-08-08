import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import { BridgeError } from "../src/errors.js";
import { CodexClient } from "../src/upstream/codex-client.js";
import type { ResponsesRequest } from "../src/protocol/types.js";
import { jwt, writeCodexAuth } from "./helpers.js";

const request: ResponsesRequest = {
  model: "gpt-test",
  instructions: "test",
  input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
  tool_choice: "auto",
  parallel_tool_calls: false,
  reasoning: { effort: "medium", summary: "auto" },
  store: false,
  stream: true,
  include: ["reasoning.encrypted_content"],
  prompt_cache_key: "key"
};

test("reloads credentials after 401 and retries only when the token changed", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-reload-"));
  const token1 = await writeCodexAuth(home, { accountId: "account-1" });
  const token2 = jwt({
    exp: Math.floor(Date.now() / 1000) + 7200,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-1" },
    generation: 2
  });
  const authorizations: string[] = [];
  let calls = 0;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    const headers = new Headers(init?.headers);
    authorizations.push(headers.get("authorization") ?? "");
    if (calls === 1) {
      await writeCodexAuth(home, { accessToken: token2 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response("ok", { status: 200 });
  }) as typeof fetch;
  const client = new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    baseUrl: "https://example.invalid",
    fetchImpl
  });

  const response = await client.createResponse(request);
  assert.equal(response.status, 200);
  assert.deepEqual(authorizations, [`Bearer ${token1}`, `Bearer ${token2}`]);
});

test("returns actionable unauthorized error without retrying an unchanged token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-no-retry-"));
  await writeCodexAuth(home);
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response("unauthorized", { status: 401 });
  }) as typeof fetch;
  const client = new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    fetchImpl
  });
  await assert.rejects(
    () => client.createResponse(request),
    (error: unknown) => error instanceof BridgeError && error.code === "CODEX_AUTH_UNAUTHORIZED"
  );
  assert.equal(calls, 1);
});

test("discovers Codex models using first-party headers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-models-"));
  const token = await writeCodexAuth(home, { accountId: "account-model" });
  let observed = new Headers();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    observed = new Headers(init?.headers);
    return Response.json({ models: [{ slug: "gpt-a", display_name: "GPT A" }] });
  }) as typeof fetch;
  const client = new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    fetchImpl
  });
  assert.deepEqual(await client.listModels(), [{ id: "gpt-a", displayName: "GPT A" }]);
  assert.equal(observed.get("authorization"), `Bearer ${token}`);
  assert.equal(observed.get("chatgpt-account-id"), "account-model");
  assert.equal(observed.get("originator"), "codex_cli_rs");
});
