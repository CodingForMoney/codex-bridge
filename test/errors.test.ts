import assert from "node:assert/strict";
import test from "node:test";
import {
  BridgeError,
  formatErrorMessage,
  redactSecrets,
  toAnthropicErrorBody,
  toOpenAiErrorBody,
  upstreamTransportError
} from "../src/errors.js";
import { jwt } from "./helpers.js";

test("both API error envelopes preserve bounded transport cause details", () => {
  const socket = Object.assign(new Error("socket reset"), {
    code: "ECONNRESET",
    syscall: "read",
    hostname: "chatgpt.com",
    address: "198.18.0.73",
    port: 443,
    headers: { authorization: "do-not-copy-headers" }
  });
  const error = upstreamTransportError(new TypeError("fetch failed", { cause: socket }), "Codex backend unreachable.");
  const message = formatErrorMessage(error);
  assert.match(message, /TypeError: fetch failed/);
  assert.match(message, /Error: socket reset/);
  assert.match(message, /code=ECONNRESET, syscall=read, hostname=chatgpt.com, address=198\.18\.0\.73, port=443/);
  assert.doesNotMatch(message, /do-not-copy-headers|\bat /);
  assert.equal(error.retryable, true);
  for (const body of [toAnthropicErrorBody(error), toOpenAiErrorBody(error)]) {
    assert.equal((body.error as { message: string }).message, message);
  }
});

test("redacts credentials and opaque content from nested causes", () => {
  const token = jwt({ secret: "test" });
  const secrets = [token, "sk-abcdefghijklmnopqrstuv", "cb_abcdefghijklmnopqrstuv", "opaque secret", "proxy-password"];
  const cause = new Error(`Bearer ${token}; access_token='${token}'; ` +
    '"encrypted_content":"opaque secret"; apiKey=sk-abcdefghijklmnopqrstuv; ' +
    "cb_abcdefghijklmnopqrstuv; http://user:proxy-password@127.0.0.1:7897; " + token);
  const error = new BridgeError("CODEX_UPSTREAM_UNREACHABLE", "Fetch failed.", { cause });
  for (const body of [toAnthropicErrorBody(error), toOpenAiErrorBody(error)]) {
    const serialized = JSON.stringify(body);
    for (const secret of secrets) assert.equal(serialized.includes(secret), false);
    assert.match(serialized, /REDACTED/);
  }
  assert.equal(redactSecrets("literal private value", ["private value"]), "literal [REDACTED]");
});

test("handles AggregateError and cyclic causes without exposing arbitrary fields", () => {
  const dns = Object.assign(new Error("temporary DNS failure"), { code: "EAI_AGAIN", syscall: "getaddrinfo" });
  const aggregate = new AggregateError([dns, dns], "connection attempts failed");
  Object.assign(dns, { cause: aggregate });
  const error = upstreamTransportError(new TypeError("fetch failed", { cause: aggregate }), "Upstream unreachable.");
  const message = formatErrorMessage(error);
  assert.match(message, /AggregateError: connection attempts failed/);
  assert.match(message, /code=EAI_AGAIN/);
  assert.equal(message.match(/temporary DNS failure/g)?.length, 1);
  assert.equal(error.retryable, true);
});

test("redacts long token values before truncating diagnostics", () => {
  const token = jwt({ secret: "x".repeat(1_000) });
  const error = upstreamTransportError(new Error(`login rejected: ${token}`), "Fetch failed.");
  const message = formatErrorMessage(error);
  assert.equal(message.includes(token.slice(0, 30)), false);
  assert.match(message, /login rejected: \[REDACTED\]/);
});

test("does not mark cancellation, permanent DNS, or TLS verification errors retryable", () => {
  for (const code of ["ENOTFOUND", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
    const cause = Object.assign(new Error("connection failed"), { code });
    assert.equal(upstreamTransportError(new TypeError("fetch failed", { cause }), "Failed").retryable, false);
  }
  assert.equal(upstreamTransportError(new DOMException("cancelled", "AbortError"), "Failed").retryable, false);
  assert.equal(upstreamTransportError(new TypeError("unknown fetch failure"), "Failed").retryable, false);
});
