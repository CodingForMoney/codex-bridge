import { BridgeError } from "../errors.js";
import { collectCodexResponsesResponse } from "./responses-response.js";

export async function collectCodexCompactResponse(
  body: ReadableStream<Uint8Array> | null,
  input: Array<Record<string, unknown>>,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  const terminal = await collectCodexResponsesResponse(body, signal);
  const upstreamOutput = Array.isArray(terminal.output) ? terminal.output : [];
  const compactionItems = upstreamOutput.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === "compaction"
  );
  if (compactionItems.length !== 1) {
    throw new BridgeError(
      "PROTOCOL_RESPONSE_INVALID",
      `Codex compaction returned ${compactionItems.length} compaction items; expected exactly one.`,
      { statusCode: 502 }
    );
  }

  return {
    ...terminal,
    object: "response.compaction",
    output: [
      ...input.filter(isUserMessage).map(normalizeUserMessage),
      compactionItems[0]
    ]
  };
}

function isUserMessage(item: Record<string, unknown>): boolean {
  return (item.type === undefined || item.type === "message") && item.role === "user";
}

function normalizeUserMessage(item: Record<string, unknown>): Record<string, unknown> {
  return item.type === undefined ? { type: "message", ...item } : item;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
