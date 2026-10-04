import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import { BridgeError } from "../src/errors.js";
import { CodexClient } from "../src/upstream/codex-client.js";
import type { CodexCompactRequest, CodexResponsesRequest } from "../src/protocol/types.js";
import { jwt, writeCodexAuth } from "./helpers.js";

const request: CodexResponsesRequest = {
  model: "gpt-6.1-sol",
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

const compactRequest: CodexCompactRequest = {
  model: "gpt-6.1-sol",
  input: [{ role: "user", content: "compact me" }],
  parallel_tool_calls: false
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

test("sends responses using first-party Codex headers", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-headers-"));
  const token = await writeCodexAuth(home, { accountId: "account-model" });
  let observed = new Headers();
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    observed = new Headers(init?.headers);
    return new Response("ok");
  }) as typeof fetch;
  const client = new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    fetchImpl
  });
  assert.equal((await client.createResponse(request)).status, 200);
  assert.equal(observed.get("authorization"), `Bearer ${token}`);
  assert.equal(observed.get("chatgpt-account-id"), "account-model");
  assert.equal(observed.get("originator"), "codex_cli_rs");
});

test("sends compact requests through the Codex Responses compaction trigger", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-compact-upstream-"));
  await writeCodexAuth(home, { accountId: "account-compact" });
  let observedUrl = "";
  let observedBody = "";
  let observed = new Headers();
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(url);
    observedBody = String(init?.body ?? "");
    observed = new Headers(init?.headers);
    return new Response("event stream", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const client = new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    baseUrl: "https://example.invalid/backend-api/codex",
    fetchImpl
  });

  const response = await client.compactResponse(compactRequest);
  assert.equal(response.status, 200);
  assert.equal(observedUrl, "https://example.invalid/backend-api/codex/responses");
  assert.equal(observed.get("accept"), "text/event-stream");
  assert.equal(observed.get("content-type"), "application/json");
  assert.deepEqual(JSON.parse(observedBody), {
    model: "gpt-6.1-sol",
    instructions: "",
    input: [
      { role: "user", content: "compact me" },
      { type: "compaction_trigger" }
    ],
    tool_choice: "auto",
    parallel_tool_calls: false,
    reasoning: { effort: "medium", summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: "codex-bridge-compaction"
  });
});

test("reloads changed credentials after a compact request receives 401", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-compact-reload-"));
  const token1 = await writeCodexAuth(home, { accountId: "account-compact" });
  const token2 = jwt({
    exp: Math.floor(Date.now() / 1000) + 7200,
    "https://api.openai.com/auth": { chatgpt_account_id: "account-compact" },
    generation: 2
  });
  const authorizations: string[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
    if (authorizations.length === 1) {
      await writeCodexAuth(home, { accessToken: token2 });
      return new Response("unauthorized", { status: 401 });
    }
    return new Response(JSON.stringify({ object: "response.compaction", output: [] }));
  }) as typeof fetch;
  const client = new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    fetchImpl
  });

  assert.equal((await client.compactResponse(compactRequest)).status, 200);
  assert.deepEqual(authorizations, [`Bearer ${token1}`, `Bearer ${token2}`]);
});

test("classifies compact endpoint, model, and context limit failures", async (context) => {
  const cases = [
    {
      name: "endpoint unavailable",
      status: 404,
      body: { error: { message: "No route" } },
      code: "CODEX_COMPACTION_UNAVAILABLE"
    },
    {
      name: "model unsupported",
      status: 400,
      body: { error: { code: "model_not_supported", message: "Model does not support compaction" } },
      code: "CODEX_MODEL_COMPACTION_UNAVAILABLE"
    },
    {
      name: "context too large",
      status: 400,
      body: { error: { code: "context_length_exceeded", message: "Input exceeds the compact limit" } },
      code: "CODEX_COMPACTION_INPUT_TOO_LARGE"
    }
  ] as const;

  for (const item of cases) {
    await context.test(item.name, async () => {
      const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-compact-error-"));
      await writeCodexAuth(home);
      const client = new CodexClient({
        credentialReader: new CodexCredentialReader({ codexHome: home }),
        fetchImpl: (async () => new Response(JSON.stringify(item.body), {
          status: item.status,
          headers: { "content-type": "application/json" }
        })) as typeof fetch
      });
      await assert.rejects(
        () => client.compactResponse(compactRequest),
        (error: unknown) => error instanceof BridgeError && error.code === item.code
      );
    });
  }
});

test("recovers from transient network failures before returning a response", async (context) => {
  for (const code of ["ECONNRESET", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]) {
    await context.test(code, async (t) => {
      let calls = 0;
      const client = await retryClient(t, async () => {
        if (++calls < 3) throw networkFailure(code);
        return new Response("recovered");
      });
      assert.equal(await (await client.createResponse(request)).text(), "recovered");
      assert.equal(calls, 3);
    });
  }
});

test("retries selected HTTP failures and preserves the last failure when exhausted", async (context) => {
  for (const status of [408, 429, 500, 502, 503, 504]) {
    await context.test(String(status), async (t) => {
      let calls = 0;
      const client = await retryClient(t, async () => {
        calls += 1;
        return new Response(JSON.stringify({ error: { message: `upstream unavailable attempt ${calls}` } }), { status });
      });
      await assert.rejects(() => client.createResponse(request), (error: unknown) =>
        error instanceof BridgeError && error.statusCode === status &&
        error.message === "upstream unavailable attempt 3" && error.retryable);
      assert.equal(calls, 3);
    });
  }
});

test("does not retry invalid requests, permission errors, or permanent connection failures", async (context) => {
  for (const status of [400, 401, 403, 404, 501]) {
    await context.test(`HTTP ${status}`, async (t) => {
      let calls = 0;
      const client = await retryClient(t, async () => {
        calls += 1;
        return new Response("rejected", { status });
      });
      await assert.rejects(() => client.createResponse(request), (error: unknown) =>
        error instanceof BridgeError && error.statusCode === status && !error.retryable);
      assert.equal(calls, 1);
    });
  }
  for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    await context.test(code, async (t) => {
      let calls = 0;
      const client = await retryClient(t, async () => {
        calls += 1;
        throw networkFailure(code);
      });
      await assert.rejects(() => client.createResponse(request), (error: unknown) =>
        error instanceof BridgeError && error.code === "CODEX_UPSTREAM_UNREACHABLE" && !error.retryable);
      assert.equal(calls, 1);
    });
  }
});

test("allows disabling network retries", async (t) => {
  let calls = 0;
  const client = await retryClient(t, async () => {
    calls += 1;
    throw networkFailure("ECONNRESET");
  }, { maxRetries: 0 });
  await assert.rejects(() => client.createResponse(request), { code: "CODEX_UPSTREAM_UNREACHABLE" });
  assert.equal(calls, 1);
});

test("retries compaction requests using the same network policy", async (t) => {
  let calls = 0;
  const client = await retryClient(t, async () => {
    if (++calls === 1) throw networkFailure("EAI_AGAIN");
    return new Response("compacted");
  });
  assert.equal(await (await client.compactResponse(compactRequest)).text(), "compacted");
  assert.equal(calls, 2);
});

test("stops a retry backoff immediately when the caller cancels", { timeout: 2_000 }, async (t) => {
  const controller = new AbortController();
  let failed!: () => void;
  const firstFailure = new Promise<void>((resolve) => { failed = resolve; });
  let calls = 0;
  const client = await retryClient(t, async () => {
    calls += 1;
    failed();
    throw networkFailure("ECONNRESET");
  }, { retryDelayMs: 10_000 });
  const result = assert.rejects(() => client.createResponse(request, controller.signal), { name: "AbortError" });
  await firstFailure;
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await result;
  assert.equal(calls, 1);
});

test("cancellation wins when it races with a connection failure", async (t) => {
  const controller = new AbortController();
  let calls = 0;
  const client = await retryClient(t, async () => {
    calls += 1;
    controller.abort();
    throw networkFailure("ECONNRESET");
  });
  await assert.rejects(() => client.createResponse(request, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("honors Retry-After while allowing cancellation during the wait", { timeout: 2_000 }, async (t) => {
  const controller = new AbortController();
  let returned!: () => void;
  const firstResponse = new Promise<void>((resolve) => { returned = resolve; });
  let calls = 0;
  const client = await retryClient(t, async () => {
    calls += 1;
    returned();
    return new Response("busy", { status: 429, headers: { "retry-after": "60" } });
  });
  const result = assert.rejects(() => client.createResponse(request, controller.signal), { name: "AbortError" });
  await firstResponse;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls, 1);
  controller.abort();
  await result;
});

test("does not dispatch an already-cancelled request", async (t) => {
  let calls = 0;
  const client = await retryClient(t, async () => {
    calls += 1;
    return new Response("unexpected");
  });
  await assert.rejects(() => client.createResponse(request, AbortSignal.abort()), { name: "AbortError" });
  assert.equal(calls, 0);
});

function networkFailure(code: string): TypeError {
  return new TypeError("fetch failed", { cause: Object.assign(new Error("connection failed"), { code, syscall: "connect" }) });
}

async function retryClient(
  t: TestContext,
  fetchImpl: typeof fetch,
  options: { maxRetries?: number; retryDelayMs?: number } = {}
): Promise<CodexClient> {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-retry-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await writeCodexAuth(home);
  return new CodexClient({
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    fetchImpl,
    retryDelayMs: 0,
    ...options
  });
}
