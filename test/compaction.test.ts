import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import type { BridgeConfig } from "../src/config/config.js";
import { convertResponsesCompactRequest, convertResponsesRequest } from "../src/protocol/responses-request.js";
import type { CodexCompactRequest, CodexResponsesRequest } from "../src/protocol/types.js";
import { startBridgeServer, type CodexClientLike } from "../src/server/app.js";
import { codexSse, writeCodexAuth } from "./helpers.js";

test("normalizes compact history and preserves opaque compaction items", () => {
  const compaction = {
    type: "compaction",
    id: "cmp_existing",
    encrypted_content: "opaque-compact-state",
    future_field: { retained: true }
  };
  const converted = convertResponsesCompactRequest({
    model: "gpt-5.6-sol",
    instructions: "Preserve the working state.",
    input: [
      { role: "user", content: "Build the feature." },
      { type: "reasoning", id: "reason_1", encrypted_content: "opaque-reasoning" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
      compaction
    ],
    tools: [{ type: "function", name: "read_file", parameters: { type: "object" } }],
    parallel_tool_calls: true,
    reasoning: { effort: "high", summary: "auto" },
    prompt_cache_key: "thread-1"
  });

  assert.equal(converted.requestedModel, "gpt-5.6-sol");
  assert.equal(converted.compact.parallel_tool_calls, true);
  assert.deepEqual(converted.compact.input.at(-1), compaction);

  const continuation = convertResponsesRequest({
    model: "gpt-5.6-sol",
    input: [compaction, { role: "user", content: "Continue." }]
  });
  assert.deepEqual(continuation.responses.input[0], compaction);
});

test("rejects malformed compact requests and unsupported compact controls", () => {
  assert.throws(
    () => convertResponsesCompactRequest({
      model: "gpt-5.6-sol",
      input: [{ type: "compaction", id: "cmp_missing_content" }]
    }),
    /require encrypted_content/
  );
  assert.throws(
    () => convertResponsesCompactRequest({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      previous_response_id: "resp_server_state"
    }),
    /send complete input history/
  );
  assert.throws(
    () => convertResponsesCompactRequest({
      model: "gpt-5.6-sol",
      input: [{ role: "user", content: "hello" }],
      stream: true
    }),
    /compact stream is not supported/
  );
});

test("compacts a complete history and continues through Responses without rewriting opaque output", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-compact-e2e-"));
  await writeCodexAuth(home);
  const responseRequests: CodexResponsesRequest[] = [];
  const compactRequests: CodexCompactRequest[] = [];
  const opaqueCompaction = {
    type: "compaction",
    id: "cmp_opaque",
    encrypted_content: "encrypted-state-must-not-change",
    future_field: { version: 2 }
  };
  const compactedTerminal = {
    id: "resp_compacted",
    object: "response",
    status: "completed",
    model: "gpt-5.6-sol",
    created_at: 1_765_000_000,
    output: [opaqueCompaction],
    usage: {
      input_tokens: 120,
      input_tokens_details: { cached_tokens: 40, future_counter: 7 },
      output_tokens: 20,
      total_tokens: 140
    },
    future_top_level: "preserved"
  };
  const client: CodexClientLike = {
    async createResponse(request) {
      responseRequests.push(request);
      const second = responseRequests.length === 2;
      const output = second
        ? [{ type: "function_call", id: "fc_2", call_id: "call_2", name: "finish", arguments: "{}" }]
        : [{
            type: "message",
            id: "msg_1",
            role: "assistant",
            content: [{ type: "output_text", text: "Initial answer", annotations: [] }]
          }];
      return codexSse([
        {
          type: "response.completed",
          response: {
            id: second ? "resp_after_compact" : "resp_before_compact",
            object: "response",
            status: "completed",
            model: request.model,
            output,
            usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
          }
        }
      ]);
    },
    async compactResponse(request) {
      compactRequests.push(request);
      return codexSse([{
        type: "response.completed",
        response: compactedTerminal
      }]);
    }
  };
  const running = await startBridgeServer({
    config: testConfig(home),
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    codexClient: client
  });
  const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };

  try {
    const health = await fetch(`${running.url}/health`);
    const capabilities = (await health.json() as {
      capabilities: Record<string, boolean>;
    }).capabilities;
    assert.equal(capabilities.responses, true);
    assert.equal(capabilities.responses_compact, true);

    const wrongMethod = await fetch(`${running.url}/v1/responses/compact`, {
      headers: { authorization: "Bearer local-secret" }
    });
    assert.equal(wrongMethod.status, 405);
    assert.equal(
      (await wrongMethod.json() as { error: { code: string } }).error.code,
      "BRIDGE_METHOD_NOT_ALLOWED"
    );

    const initial = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "Build the feature." })
    });
    assert.equal(initial.status, 200);
    assert.equal((await initial.json() as { id: string }).id, "resp_before_compact");

    const history = [
      { role: "user", content: "Build the feature." },
      { type: "reasoning", id: "reason_1", encrypted_content: "opaque-reasoning" },
      { type: "function_call", call_id: "call_1", name: "read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "file contents" }
    ];
    const compact = await fetch(`${running.url}/v1/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: history })
    });
    assert.equal(compact.status, 200);
    const compacted = await compact.json() as {
      object: string;
      status: string;
      output: Array<Record<string, unknown>>;
      future_top_level: string;
    };
    assert.equal(compacted.object, "response.compaction");
    assert.equal(compacted.status, "completed");
    assert.equal(compacted.future_top_level, "preserved");
    assert.deepEqual(compacted.output[0], {
      type: "message",
      role: "user",
      content: "Build the feature."
    });
    assert.deepEqual(compacted.output[1], opaqueCompaction);
    assert.deepEqual(compactRequests[0]?.input, history);

    const continued = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [...compacted.output, { role: "user", content: "Continue and call finish." }],
        tools: [{ type: "function", name: "finish", parameters: { type: "object" } }]
      })
    });
    const continuedBody = await continued.json() as {
      id: string;
      output: Array<Record<string, unknown>>;
    };
    assert.equal(continued.status, 200);
    assert.equal(continuedBody.id, "resp_after_compact");
    assert.equal(continuedBody.output[0]?.type, "function_call");
    assert.deepEqual(responseRequests[1]?.input[1], opaqueCompaction);

    const unsupported = await fetch(`${running.url}/v1/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.5", input: history })
    });
    assert.equal(unsupported.status, 400);
    assert.equal(
      (await unsupported.json() as { error: { code: string } }).error.code,
      "CODEX_MODEL_UNAVAILABLE"
    );
    assert.equal(compactRequests.length, 1);

    const secret = "encrypted-content-must-not-appear";
    const malformed = await fetch(`${running.url}/v1/responses/compact`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-sol",
        input: [{ type: "compaction", id: "", encrypted_content: secret }]
      })
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes(secret), false);
  } finally {
    await running.close();
  }
});

test("cancels the compact upstream stream when the client disconnects", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-compact-cancel-"));
  await writeCodexAuth(home);
  let upstreamAborted = false;
  let upstreamCancelled = false;
  let markUpstreamStarted: (() => void) | undefined;
  const upstreamStarted = new Promise<void>((resolve) => {
    markUpstreamStarted = resolve;
  });
  const encoder = new TextEncoder();
  const running = await startBridgeServer({
    config: testConfig(home),
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    codexClient: {
      async createResponse() {
        throw new Error("Unexpected Responses request.");
      },
      async compactResponse(_request, signal) {
        markUpstreamStarted?.();
        signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        }, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode('event: response.output_item.added\ndata: {"type":"response.output_item.added"'));
          },
          cancel() {
            upstreamCancelled = true;
          }
        }), { headers: { "content-type": "application/json" } });
      }
    }
  });

  try {
    const controller = new AbortController();
    const responsePromise = fetch(`${running.url}/v1/responses/compact`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        input: [{ role: "user", content: "Compact this." }]
      }),
      signal: controller.signal
    });
    await upstreamStarted;
    controller.abort();
    await assert.rejects(responsePromise, /abort/i);

    await waitFor(() => upstreamAborted && upstreamCancelled);
  } finally {
    await running.close();
  }
});

function testConfig(codexHome: string): BridgeConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    apiKey: "local-secret",
    codexHome,
    codexBaseUrl: "https://example.invalid",
    codexClientVersion: "0.139.0",
    defaultEffort: "medium",
    bodyLimitBytes: 1024 * 1024,
    logLevel: "silent"
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      assert.fail("Timed out waiting for compact request cancellation.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
