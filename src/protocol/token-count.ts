import { BridgeError } from "../errors.js";

export interface TokenCountResult {
  input_tokens: number;
}

export function estimateAnthropicInputTokens(value: unknown): TokenCountResult {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new BridgeError(
      "PROTOCOL_REQUEST_INVALID",
      "Token counting requires an Anthropic Messages request with a messages array.",
      { statusCode: 400 }
    );
  }
  const serialized = JSON.stringify({
    system: value.system ?? null,
    messages: value.messages,
    tools: value.tools ?? null
  });
  // The private Codex backend exposes no tokenizer endpoint. This conservative
  // estimate exists for client compatibility and is not used for billing.
  return { input_tokens: Math.max(1, Math.ceil(Buffer.byteLength(serialized, "utf8") / 3.5)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
