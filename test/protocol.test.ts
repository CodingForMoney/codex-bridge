import assert from "node:assert/strict";
import test from "node:test";
import { convertAnthropicRequest } from "../src/protocol/anthropic-request.js";
import { collectCodexResponse } from "../src/protocol/anthropic-response.js";
import { streamCodexAsAnthropic } from "../src/protocol/anthropic-stream.js";
import { decodeReasoningEnvelope, encodeReasoningEnvelope } from "../src/protocol/reasoning-envelope.js";
import { codexSse } from "./helpers.js";

test("converts Anthropic messages, tools, results, and encrypted reasoning", () => {
  const envelope = encodeReasoningEnvelope("reason_1", "encrypted-value");
  const converted = convertAnthropicRequest({
    model: "gpt-5.6-sol",
    system: [{ type: "text", text: "system rule" }],
    reasoning_effort: "ultracode",
    tools: [{ name: "read_file", description: "Read", input_schema: { type: "object" } }],
    messages: [
      { role: "user", content: "inspect" },
      {
        role: "assistant",
        content: [
          { type: "redacted_thinking", data: envelope },
          { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } }
        ]
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "file" }] }
    ]
  });

  assert.equal(converted.responses.model, "gpt-5.6-sol");
  assert.equal(converted.responses.instructions, "system rule");
  assert.equal(converted.responses.reasoning.effort, "xhigh");
  assert.equal(converted.responses.store, false);
  assert.deepEqual(converted.responses.include, ["reasoning.encrypted_content"]);
  assert.equal(converted.responses.input.some((item) => item.type === "reasoning"), true);
  assert.equal(converted.responses.input.some((item) => item.type === "function_call"), true);
  assert.equal(converted.responses.input.some((item) => item.type === "function_call_output"), true);
});

test("enforces a named Anthropic tool choice using the Codex string contract", () => {
  const converted = convertAnthropicRequest({
    model: "gpt-5.6-luna",
    messages: [{ role: "user", content: "run one tool" }],
    tools: [
      { name: "first", input_schema: { type: "object" } },
      { name: "second", input_schema: { type: "object" } }
    ],
    tool_choice: { type: "tool", name: "second", disable_parallel_tool_use: true }
  });
  assert.equal(converted.responses.tool_choice, "required");
  assert.deepEqual(converted.responses.tools?.map((tool) => tool.name), ["second"]);
  assert.equal(converted.responses.parallel_tool_calls, false);
});

test("collects text, tool calls, reasoning, and usage into Anthropic format", async () => {
  const response = codexSse([
    { type: "response.created", response: { id: "resp_1" } },
    {
      type: "response.output_item.done",
      item: { type: "reasoning", id: "reason_1", encrypted_content: "opaque" }
    },
    {
      type: "response.output_item.done",
      item: { type: "message", id: "message_1", content: [{ type: "output_text", text: "done" }] }
    },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "run", arguments: '{"x":1}' }
    },
    {
      type: "response.completed",
      response: { id: "resp_1", usage: { input_tokens: 8, output_tokens: 5, input_tokens_details: { cached_tokens: 2 } } }
    }
  ]);
  const message = await collectCodexResponse(response.body, "gpt-test");
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.usage.cache_read_input_tokens, 2);
  assert.equal(message.content[0]?.type, "redacted_thinking");
  const envelope = decodeReasoningEnvelope(String(message.content[0]?.data));
  assert.deepEqual(envelope, { id: "reason_1", encryptedContent: "opaque" });
  assert.deepEqual(message.content[2], { type: "tool_use", id: "call_1", name: "run", input: { x: 1 } });
});

test("streams text once and emits Anthropic terminal events", async () => {
  const response = codexSse([
    { type: "response.created", response: { id: "resp_2" } },
    { type: "response.output_text.delta", item_id: "message_1", delta: "hel" },
    { type: "response.output_text.delta", item_id: "message_1", delta: "lo" },
    { type: "response.output_text.done", item_id: "message_1", text: "hello" },
    {
      type: "response.output_item.done",
      item: { type: "message", id: "message_1", content: [{ type: "output_text", text: "hello" }] }
    },
    { type: "response.completed", response: { id: "resp_2", usage: { input_tokens: 3, output_tokens: 1 } } }
  ]);
  let output = "";
  for await (const frame of streamCodexAsAnthropic(response.body, "gpt-test")) {
    output += frame;
  }
  assert.equal((output.match(/"text":"hel"/g) ?? []).length, 1);
  assert.equal((output.match(/"text":"lo"/g) ?? []).length, 1);
  assert.equal(output.includes('"text":"hello"'), false);
  assert.match(output, /event: message_stop/);
});

test("does not fabricate success when a Codex stream ends early", async () => {
  const response = codexSse([{ type: "response.created", response: { id: "resp_3" } }]);
  let output = "";
  for await (const frame of streamCodexAsAnthropic(response.body, "gpt-test")) {
    output += frame;
  }
  assert.match(output, /event: error/);
  assert.equal(output.includes("message_stop"), false);
});

test("streams tool arguments with Anthropic tool_use events", async () => {
  const response = codexSse([
    { type: "response.created", response: { id: "resp_tool" } },
    {
      type: "response.output_item.added",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "" }
    },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '{"path":' },
    { type: "response.function_call_arguments.delta", item_id: "fc_1", delta: '"a.ts"}' },
    {
      type: "response.output_item.done",
      item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: '{"path":"a.ts"}' }
    },
    { type: "response.completed", response: { id: "resp_tool", usage: { input_tokens: 2, output_tokens: 2 } } }
  ]);
  let output = "";
  for await (const frame of streamCodexAsAnthropic(response.body, "gpt-test")) {
    output += frame;
  }
  assert.match(output, /"type":"tool_use","id":"call_1","name":"read_file"/);
  assert.match(output, /"partial_json":"{\\"path\\":"/);
  assert.match(output, /"stop_reason":"tool_use"/);
});
