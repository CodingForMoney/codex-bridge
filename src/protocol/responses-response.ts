import { BridgeError } from "../errors.js";
import { parseEvent } from "./anthropic-response.js";
import { parseSseStream } from "./sse.js";

export async function collectCodexResponsesResponse(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let terminal: Record<string, unknown> | undefined;
  for await (const frame of parseSseStream(body, signal)) {
    if (frame.data === "[DONE]") {
      continue;
    }
    const event = parseEvent(frame.data);
    const type = readString(event.type);
    if (type === "response.completed" || type === "response.incomplete") {
      const response = record(event.response);
      if (!response) {
        throw invalidResponse(`Codex ${type} event did not contain a response object.`);
      }
      terminal = response;
    } else if (type === "response.failed" || type === "error") {
      throw upstreamEventError(event);
    }
  }
  if (!terminal) {
    throw invalidResponse("Codex stream ended without a terminal Responses object.");
  }
  return terminal;
}

function upstreamEventError(event: Record<string, unknown>): BridgeError {
  const response = record(event.response);
  const error = record(event.error) ?? record(response?.error);
  const message = readString(error?.message) ?? readString(event.message) ?? "Codex response failed.";
  return new BridgeError("CODEX_UPSTREAM_ERROR", message, { retryable: true, statusCode: 502 });
}

function invalidResponse(message: string): BridgeError {
  return new BridgeError("PROTOCOL_RESPONSE_INVALID", message, { retryable: true, statusCode: 502 });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
