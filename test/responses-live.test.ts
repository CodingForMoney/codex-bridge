import assert from "node:assert/strict";
import test from "node:test";
import type { BridgeConfig } from "../src/config/config.js";
import { startBridgeServer } from "../src/server/app.js";

const RUN_LIVE = process.env.CODEX_BRIDGE_RUN_LIVE_TESTS === "1";

test("live Codex models expose public reasoning summaries through the Bridge", {
  skip: !RUN_LIVE,
  timeout: 120_000
}, async () => {
  const config: BridgeConfig = {
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
  const running = await startBridgeServer({ config });
  try {
    const prompt = "Compare two safe rollout strategies, identify one failure mode for each, and recommend one.";
    for (const model of ["gpt-5.6-sol", "gpt-5.6-luna"]) {
      const response = await fetch(`${running.url}/v1/responses`, {
        method: "POST",
        headers: {
          authorization: "Bearer live-conformance-key",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model,
          input: model === "gpt-5.6-sol"
            ? prompt
            : [{
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: prompt }]
              }],
          stream: true,
          store: false,
          reasoning: { effort: "high", summary: "auto" }
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
