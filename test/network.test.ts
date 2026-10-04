import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import type { BridgeConfig } from "../src/config/config.js";
import { startBridgeServer } from "../src/server/app.js";
import { CodexClient } from "../src/upstream/codex-client.js";
import { codexSse, completeTextEvents, writeCodexAuth } from "./helpers.js";

const headers = { authorization: "Bearer network-test-key", "content-type": "application/json" };
const cases = [
  { path: "/v1/messages", body: { model: "gpt-6-luna", max_tokens: 32, messages: [{ role: "user", content: "hi" }] } },
  { path: "/v1/responses", body: { model: "gpt-6-luna", input: "hi" } },
  { path: "/v1/responses/compact", body: { model: "gpt-6-luna", input: [{ role: "user", content: "hi" }] } }
];

test("HTTP clients receive sanitized transport details after retries are exhausted", async (context) => {
  for (const item of cases) {
    await context.test(item.path, async (t) => {
      let calls = 0;
      const running = await bridgeFor(t, (async () => {
        calls += 1;
        throw socketFailure();
      }) as typeof fetch);
      const response = await fetch(`${running.url}${item.path}`, {
        method: "POST", headers, body: JSON.stringify(item.body), signal: AbortSignal.timeout(5_000)
      });
      const body = await response.json() as { error: { code: string; message: string } };
      assert.equal(response.status, 502);
      assert.equal(calls, 3);
      assert.equal(body.error.code, "CODEX_UPSTREAM_UNREACHABLE");
      assert.match(body.error.message, /TypeError: fetch failed/);
      assert.match(body.error.message, /code=ECONNRESET, syscall=read, hostname=chatgpt\.com/);
      assert.doesNotMatch(body.error.message, /private-oauth-token|opaque-private-state/);
    });
  }
});

test("both streaming APIs report mid-stream failure without replay or success completion", async (context) => {
  for (const item of cases.slice(0, 2)) {
    await context.test(item.path, async (t) => {
      let calls = 0;
      const running = await bridgeFor(t, (async () => {
        calls += 1;
        return brokenStream([
          { type: "response.created", sequence_number: 6, response: { id: "resp_partial", status: "in_progress" } },
          { type: "response.output_text.delta", sequence_number: 7, delta: "partial", output_index: 0, content_index: 0 }
        ]);
      }) as typeof fetch);
      const response = await fetch(`${running.url}${item.path}`, {
        method: "POST", headers, body: JSON.stringify({ ...item.body, stream: true }), signal: AbortSignal.timeout(5_000)
      });
      const text = await response.text();
      assert.equal(response.status, 200);
      assert.match(text, /partial/);
      assert.match(text, /event: error/);
      assert.match(text, /CODEX_UPSTREAM_UNREACHABLE/);
      assert.match(text, /ECONNRESET/);
      assert.doesNotMatch(text, /private-oauth-token|opaque-private-state|event: message_stop|event: response.completed|\[DONE\]/);
      assert.equal(calls, 1);
      const errorEvent = eventsFrom(text).find((event) => event.type === "error");
      assert.ok(errorEvent);
      if (item.path === "/v1/responses") {
        assert.equal(errorEvent.code, "CODEX_UPSTREAM_UNREACHABLE");
        assert.equal(errorEvent.sequence_number, 8);
        assert.equal(errorEvent.param, null);
        assert.equal("error" in errorEvent, false);
      } else {
        assert.equal((errorEvent.error as { code: string }).code, "CODEX_UPSTREAM_UNREACHABLE");
      }
    });
  }
});

test("non-streaming APIs fail if the upstream body disconnects and never replay it", async (context) => {
  for (const item of cases) {
    await context.test(item.path, async (t) => {
      let calls = 0;
      const running = await bridgeFor(t, (async () => {
        calls += 1;
        return brokenStream([{ type: "response.created", response: { id: "resp_partial" } }]);
      }) as typeof fetch);
      const response = await fetch(`${running.url}${item.path}`, {
        method: "POST", headers, body: JSON.stringify(item.body), signal: AbortSignal.timeout(5_000)
      });
      const body = await response.json() as { error: { code: string; message: string } };
      assert.equal(response.status, 502);
      assert.equal(body.error.code, "CODEX_UPSTREAM_UNREACHABLE");
      assert.match(body.error.message, /ECONNRESET/);
      assert.equal(calls, 1);
    });
  }
});

test("disconnect after a terminal event does not turn successful streams into failures", async (context) => {
  for (const item of cases.slice(0, 2)) {
    await context.test(item.path, async (t) => {
      const running = await bridgeFor(t, (async () => brokenStream(completeTextEvents("completed"))) as typeof fetch);
      const response = await fetch(`${running.url}${item.path}`, {
        method: "POST", headers, body: JSON.stringify({ ...item.body, stream: true }), signal: AbortSignal.timeout(5_000)
      });
      const text = await response.text();
      assert.match(text, item.path === "/v1/messages" ? /event: message_stop/ : /event: response.completed/);
      assert.doesNotMatch(text, /event: error/);
    });
  }
});

test("native fetch recovers from a real pre-header socket disconnect", { timeout: 5_000 }, async (t) => {
  let calls = 0;
  const upstream = createServer((request, response) => {
    request.resume();
    request.once("end", () => {
      if (++calls === 1) {
        response.destroy();
      } else {
        response.writeHead(200, { "content-type": "text/event-stream" });
        void codexSse(completeTextEvents("recovered over HTTP")).text().then((body) => response.end(body));
      }
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  t.after(async () => {
    upstream.closeAllConnections();
    await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  });
  const address = upstream.address();
  assert.ok(address && typeof address === "object");
  const running = await bridgeFor(t, fetch, `http://127.0.0.1:${address.port}`);
  const response = await fetch(`${running.url}/v1/messages`, {
    method: "POST", headers, body: JSON.stringify(cases[0]?.body), signal: AbortSignal.timeout(4_000)
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /recovered over HTTP/);
  assert.equal(calls, 2);
});

test("client disconnect cancels a server-side retry wait", { timeout: 5_000 }, async (t) => {
  let calls = 0;
  let cancelled!: () => void;
  const cancellation = new Promise<void>((resolve) => { cancelled = resolve; });
  let attempted!: () => void;
  const firstAttempt = new Promise<void>((resolve) => { attempted = resolve; });
  const running = await bridgeFor(t, (async (_url, init) => {
    calls += 1;
    init?.signal?.addEventListener("abort", cancelled, { once: true });
    attempted();
    throw socketFailure();
  }) as typeof fetch, undefined, 10_000);
  const controller = new AbortController();
  const result = assert.rejects(fetch(`${running.url}/v1/responses`, {
    method: "POST", headers, body: JSON.stringify(cases[1]?.body), signal: controller.signal
  }), { name: "AbortError" });
  await firstAttempt;
  controller.abort();
  await result;
  await cancellation;
  assert.equal(calls, 1);
});

function socketFailure(): TypeError {
  const cause = Object.assign(new Error('socket reset; Bearer private-oauth-token; encrypted_content="opaque-private-state"'), {
    code: "ECONNRESET", syscall: "read", hostname: "chatgpt.com"
  });
  return new TypeError("fetch failed", { cause });
}

function brokenStream(events: unknown[]): Response {
  let next = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (next < events.length) {
        const event = events[next++] as { type: string };
        controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
      } else {
        controller.error(socketFailure());
      }
    }
  }), { headers: { "content-type": "text/event-stream" } });
}

async function bridgeFor(t: TestContext, fetchImpl: typeof fetch, baseUrl = "https://example.invalid", retryDelayMs = 0) {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-network-"));
  await writeCodexAuth(home);
  const config: BridgeConfig = {
    host: "127.0.0.1", port: 0, apiKey: "network-test-key", codexHome: home,
    codexBaseUrl: baseUrl, codexClientVersion: "0.139.0", defaultEffort: "medium",
    bodyLimitBytes: 1024 * 1024, logLevel: "silent"
  };
  const credentialReader = new CodexCredentialReader({ codexHome: home });
  const running = await startBridgeServer({
    config, credentialReader,
    codexClient: new CodexClient({ credentialReader, fetchImpl, baseUrl, retryDelayMs })
  });
  t.after(async () => {
    await running.close();
    await rm(home, { recursive: true, force: true });
  });
  return running;
}

function eventsFrom(body: string): Array<Record<string, unknown>> {
  return body.split("\n\n").flatMap((frame) => {
    const data = frame.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
    return data && data !== "[DONE]" ? [JSON.parse(data) as Record<string, unknown>] : [];
  });
}
