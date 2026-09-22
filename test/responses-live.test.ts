import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig } from "../src/config/config.js";
import { startBridgeServer } from "../src/server/app.js";

const RUN_LIVE = process.env.CODEX_BRIDGE_RUN_LIVE_TESTS === "1";
const LIVE_CONFIG: BridgeConfig = {
  host: "127.0.0.1",
  port: 0,
  apiKey: "live-conformance-key",
  ...(process.env.CODEX_HOME?.trim() ? { codexHome: process.env.CODEX_HOME.trim() } : {}),
  codexBaseUrl: "https://chatgpt.com/backend-api/codex",
  codexClientVersion: "0.139.0",
  defaultEffort: "high",
  bodyLimitBytes: 1024 * 1024,
  logLevel: "silent"
};

test("live Codex models expose public reasoning summaries through the Bridge", {
  skip: !RUN_LIVE,
  timeout: 120_000
}, async () => {
  const running = await startBridgeServer({ config: LIVE_CONFIG });
  try {
    const prompt = "Compare two safe rollout strategies, identify one failure mode for each, and recommend one.";
    for (const model of ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]) {
      const response = await fetch(`${running.url}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer live-conformance-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: model !== "gpt-6-luna"
            ? prompt
            : [{
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: prompt }]
              }],
          stream: true,
          store: false,
          reasoning: { effort: model === "gpt-6-astra" ? "max" : "high", summary: "auto" }
        })
      });
      const body = await response.text();
      assert.equal(response.status, 200, `${model}: ${body.slice(0, 500)}`);
      const events = parseSseEvents(body);
      assert.ok(
        events.some((event) => event.type === "response.reasoning_summary_text.delta"),
        `${model} returned no public reasoning-summary delta.`
      );
      const completed = events.find((event) => event.type === "response.completed");
      const output = (completed?.response as {
        output?: Array<Record<string, unknown>>;
      } | undefined)?.output ?? [];
      const reasoning = output.find((item) => item.type === "reasoning");
      assert.ok(
        Array.isArray(reasoning?.summary) && reasoning.summary.length > 0,
        `${model} terminal reasoning item returned no public summary.`
      );
      assert.equal(typeof reasoning?.encrypted_content, "string");
    }
  } finally {
    await running.close();
  }
});

test("new Codex models support Messages and compacted Responses continuation", {
  skip: !RUN_LIVE,
  timeout: 180_000
}, async () => {
  const running = await startBridgeServer({ config: LIVE_CONFIG });
  const headers = {
    authorization: "Bearer live-conformance-key",
    "content-type": "application/json"
  };
  try {
    for (const model of ["gpt-6-sol", "gpt-6-luna"]) {
      const codeword = `${model.replaceAll("-", "_").toUpperCase()}_OK`;
      const message = await fetch(`${running.url}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          max_tokens: 64,
          messages: [{ role: "user", content: `Reply with exactly ${codeword}.` }]
        })
      });
      const messageBody = await message.text();
      assert.equal(message.status, 200, `${model} Messages: ${messageBody.slice(0, 500)}`);
      assert.ok(messageBody.includes(codeword), `${model} Messages response omitted the codeword.`);

      const compact = await fetch(`${running.url}/v1/responses/compact`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: [
            { role: "user", content: `Remember the codeword ${codeword}.` },
            { role: "assistant", content: `I will remember ${codeword}.` }
          ]
        })
      });
      const compactBody = await compact.text();
      assert.equal(compact.status, 200, `${model} compact: ${compactBody.slice(0, 500)}`);
      const compacted = JSON.parse(compactBody) as { output: Array<Record<string, unknown>> };
      assert.ok(compacted.output.some((item) =>
        item.type === "compaction" && typeof item.encrypted_content === "string"
      ));

      const next = await fetch(`${running.url}/v1/responses`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model,
          input: [...compacted.output, { role: "user", content: "What codeword did I ask you to remember? Reply with only the codeword." }]
        })
      });
      const nextBody = await next.text();
      assert.equal(next.status, 200, `${model} continuation: ${nextBody.slice(0, 500)}`);
      assert.ok(nextBody.includes(codeword), `${model} continuation lost the codeword.`);
    }
  } finally {
    await running.close();
  }
});

function parseSseEvents(body: string): Array<Record<string, unknown>> {
  return body
    .split("\n\n")
    .map((frame) => frame
      .split("\n")
      .find((line) => line.startsWith("data: "))
      ?.slice("data: ".length))
    .filter((data): data is string => Boolean(data && data !== "[DONE]"))
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}
