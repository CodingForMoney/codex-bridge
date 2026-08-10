import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import type { BridgeConfig } from "../src/config/config.js";
import { BridgeError } from "../src/errors.js";
import { convertResponsesRequest } from "../src/protocol/responses-request.js";
import { collectCodexResponsesResponse } from "../src/protocol/responses-response.js";
import type { CodexResponsesRequest } from "../src/protocol/types.js";
import { startBridgeServer, type CodexClientLike } from "../src/server/app.js";
import { codexSse, writeCodexAuth } from "./helpers.js";

test("normalizes the supported Responses request subset for the Codex backend", () => {
  const converted = convertResponsesRequest({
    model: "gpt-5.6-sol",
    instructions: "Be precise.",
    input: "hello",
    stream: false,
    store: false,
    max_output_tokens: 500,
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"],
    text: {
      verbosity: "low",
      format: { type: "json_schema", name: "answer", schema: { type: "object" } }
    },
    tools: [
      { type: "function", name: "first", parameters: { type: "object" } },
      { type: "function", name: "second", parameters: { type: "object" }, strict: true }
    ],
    tool_choice: { type: "function", name: "second" },
    parallel_tool_calls: false
  });

  assert.equal(converted.clientStream, false);
  assert.equal(converted.responses.store, false);
  assert.equal(converted.responses.stream, true);
  assert.equal(converted.responses.reasoning.effort, "high");
  assert.deepEqual(converted.responses.include, ["reasoning.encrypted_content"]);
  assert.deepEqual(converted.responses.tools?.map((tool) => tool.name), ["second"]);
  assert.equal(converted.responses.tool_choice, "required");
  assert.equal(converted.responses.parallel_tool_calls, false);
  assert.equal("max_output_tokens" in converted.responses, false);
});

test("rejects Responses features that require unsupported backend behavior", () => {
  const cases: Array<{ request: Record<string, unknown>; message: RegExp }> = [
    { request: { store: true }, message: /store must be false/ },
    { request: { background: true }, message: /background mode/ },
    { request: { previous_response_id: "resp_previous" }, message: /previous_response_id/ },
    { request: { conversation: "conv_1" }, message: /conversation/ },
    { request: { reasoning: { context: "all_turns" } }, message: /reasoning\.context/ },
    { request: { tools: [{ type: "web_search" }] }, message: /tool type web_search/ },
    { request: { include: ["web_search_call.action.sources"] }, message: /include value/ },
    {
      request: { input: [{ type: "message", role: "user", content: [{ type: "input_file", file_id: "file_1" }] }] },
      message: /content type input_file/
    }
  ];

  for (const entry of cases) {
    assert.throws(
      () => convertResponsesRequest({
        model: "gpt-5.6-sol",
        input: "hello",
        ...entry.request
      }),
      (error: unknown) =>
        error instanceof BridgeError &&
        error.code === "PROTOCOL_REQUEST_UNSUPPORTED" &&
        entry.message.test(error.message)
    );
  }
});

test("accepts native Responses text, image, tool, and encrypted reasoning history", () => {
  const converted = convertResponsesRequest({
    model: "gpt-5.6-luna",
    input: [
      {
        type: "message",
        role: "user",
        content: [
          { type: "input_text", text: "inspect" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" }
        ]
      },
      { type: "reasoning", id: "reason_1", encrypted_content: "opaque", summary: [] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" }
    ]
  });

  assert.equal(Array.isArray(converted.responses.input), true);
  assert.equal((converted.responses.input as Array<Record<string, unknown>>).length, 4);
});

test("collects a terminal Codex stream into a native Responses object", async () => {
  const completed = {
    id: "resp_native",
    object: "response",
    status: "completed",
    model: "gpt-5.6-luna",
    output: [{ type: "message", id: "msg_1", role: "assistant", content: [] }],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
  };
  const response = codexSse([
    { type: "response.created", response: { id: "resp_native", status: "in_progress" } },
    { type: "response.completed", response: completed }
  ]);

  assert.deepEqual(await collectCodexResponsesResponse(response.body), completed);
});

test("serves non-streaming and streaming Responses alongside Anthropic Messages", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-responses-"));
  await writeCodexAuth(home);
  const requests: CodexResponsesRequest[] = [];
  let sequence = 0;
  const client: CodexClientLike = {
    async createResponse(request) {
      requests.push(request);
      sequence += 1;
      const completed = nativeCompletedResponse(`resp_${sequence}`, request.model);
      return codexSse([
        { type: "response.created", response: { id: completed.id, status: "in_progress" } },
        { type: "response.completed", response: completed }
      ]);
    }
  };
  const running = await startBridgeServer({
    config: testConfig(home),
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    codexClient: client
  });
  const headers = { authorization: "Bearer local-secret", "content-type": "application/json" };
  try {
    const unauthorized = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" })
    });
    const unauthorizedBody = await unauthorized.json() as Record<string, unknown>;
    assert.equal(unauthorized.status, 401);
    assert.equal(unauthorizedBody.type, undefined);
    assert.equal((unauthorizedBody.error as Record<string, unknown>).code, "BRIDGE_UNAUTHORIZED");

    const nonStreaming = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello" })
    });
    assert.equal(nonStreaming.status, 200);
    assert.equal((await nonStreaming.json() as { id: string }).id, "resp_1");
    assert.equal(requests[0]?.stream, true);
    assert.equal(requests[0]?.store, false);

    const streaming = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "hello", stream: true })
    });
    const streamedText = await streaming.text();
    assert.equal(streaming.status, 200);
    assert.match(streaming.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(streamedText, /event: response\.created/);
    assert.match(streamedText, /event: response\.completed/);
    assert.match(streamedText, /"id":"resp_2"/);

    const messages = await fetch(`${running.url}/v1/messages`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        messages: [{ role: "user", content: "hello" }]
      })
    });
    assert.equal(messages.status, 200);
    assert.equal((await messages.json() as { type: string }).type, "message");

    const unsupported = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", store: true })
    });
    const unsupportedBody = await unsupported.json() as { error: { code: string } };
    assert.equal(unsupported.status, 400);
    assert.equal(unsupportedBody.error.code, "PROTOCOL_REQUEST_UNSUPPORTED");
    assert.equal(requests.length, 3);
  } finally {
    await running.close();
  }
});

test("cancels a native Responses upstream stream when the client disconnects", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-responses-disconnect-"));
  await writeCodexAuth(home);
  let upstreamAborted = false;
  let upstreamCancelled = false;
  const encoder = new TextEncoder();
  const running = await startBridgeServer({
    config: testConfig(home),
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    codexClient: {
      async createResponse(_request, signal) {
        signal?.addEventListener("abort", () => {
          upstreamAborted = true;
        }, { once: true });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(
              'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_disconnect"}}\n\n'
            ));
          },
          cancel() {
            upstreamCancelled = true;
          }
        }), { headers: { "content-type": "text/event-stream" } });
      }
    }
  });
  try {
    const controller = new AbortController();
    const response = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true }),
      signal: controller.signal
    });
    const reader = response.body?.getReader();
    assert.ok(reader);
    assert.equal((await reader.read()).done, false);
    await reader.cancel("test native Responses disconnect");
    controller.abort();

    await waitFor(() => upstreamAborted && upstreamCancelled);
    assert.equal((await fetch(`${running.url}/health`)).status, 200);
  } finally {
    await running.close();
  }
});

test("returns an OpenAI error before starting a stream when the upstream body is missing", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-responses-empty-"));
  await writeCodexAuth(home);
  const running = await startBridgeServer({
    config: testConfig(home),
    credentialReader: new CodexCredentialReader({ codexHome: home }),
    codexClient: {
      async createResponse() {
        return new Response(null, { status: 200 });
      }
    }
  });
  try {
    const response = await fetch(`${running.url}/v1/responses`, {
      method: "POST",
      headers: { authorization: "Bearer local-secret", "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-sol", input: "hello", stream: true })
    });
    const body = await response.json() as { error: { code: string } };
    assert.equal(response.status, 502);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
    assert.equal(body.error.code, "PROTOCOL_RESPONSE_INVALID");
  } finally {
    await running.close();
  }
});

function nativeCompletedResponse(id: string, model: string): Record<string, unknown> {
  return {
    id,
    object: "response",
    status: "completed",
    model,
    output: [{
      type: "message",
      id: `msg_${id}`,
      role: "assistant",
      content: [{ type: "output_text", text: "bridge response", annotations: [] }]
    }],
    usage: { input_tokens: 4, output_tokens: 2, total_tokens: 6 }
  };
}

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
      assert.fail("Timed out waiting for the expected Responses server state.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
