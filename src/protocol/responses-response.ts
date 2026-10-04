import { asBridgeError, BridgeError, formatErrorMessage, redactSecrets } from "../errors.js";
import { parseEvent } from "./anthropic-response.js";
import { encodeSse, parseSseStream } from "./sse.js";

export async function collectCodexResponsesResponse(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): Promise<Record<string, unknown>> {
  let terminal: Record<string, unknown> | undefined;
  const accumulator = new NativeResponsesAccumulator();
  for await (const frame of parseSseStream(body, signal)) {
    if (frame.data === "[DONE]") {
      continue;
    }
    const event = accumulator.accept(parseEvent(frame.data));
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

export async function* normalizeCodexResponsesStream(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const accumulator = new NativeResponsesAccumulator();
  let terminal = false;
  let lastSequence = -1;
  try {
    for await (const frame of parseSseStream(body, signal)) {
      if (frame.data === "[DONE]") {
        if (!terminal) throw invalidResponse("Codex stream ended without a terminal Responses event.");
        yield "data: [DONE]\n\n";
        return;
      }
      const event = accumulator.accept(parseEvent(frame.data));
      const type = readString(event.type) ?? frame.event ?? "message";
      if (typeof event.sequence_number === "number" && Number.isInteger(event.sequence_number)) {
        lastSequence = Math.max(lastSequence, event.sequence_number);
      }
      if (["response.completed", "response.incomplete", "response.failed", "error"].includes(type)) terminal = true;
      yield encodeSse(frame.event ?? type,
        type === "error" || type === "response.failed" ? redactEventError(event) : event);
    }
    if (!terminal) throw invalidResponse("Codex stream ended without a terminal Responses event.");
  } catch (error) {
    if (signal?.aborted || terminal) return;
    const bridgeError = asBridgeError(error);
    yield encodeSse("error", {
      type: "error",
      code: bridgeError.code,
      message: formatErrorMessage(bridgeError),
      param: null,
      sequence_number: lastSequence + 1
    });
  }
}

function redactEventError(event: Record<string, unknown>): Record<string, unknown> {
  const result = { ...event };
  if (typeof result.message === "string") result.message = redactSecrets(result.message);
  const error = record(result.error);
  if (error && typeof error.message === "string") {
    result.error = { ...error, message: redactSecrets(error.message) };
  }
  const response = record(result.response);
  const responseError = record(response?.error);
  if (response && responseError && typeof responseError.message === "string") {
    result.response = { ...response, error: { ...responseError, message: redactSecrets(responseError.message) } };
  }
  return result;
}

class NativeResponsesAccumulator {
  private readonly items = new Map<string, Record<string, unknown>>();
  private readonly order: string[] = [];

  accept(event: Record<string, unknown>): Record<string, unknown> {
    const type = readString(event.type);
    if (
      type === "response.output_item.added" ||
      type === "response.output_item.done"
    ) {
      const item = record(event.item);
      if (item) this.setItem(event, item);
      return event;
    }
    if (type !== "response.completed" && type !== "response.incomplete")
      return event;

    const response = record(event.response);
    if (!response) return event;
    const existing = Array.isArray(response.output) ? response.output : [];
    if (existing.length) return event;
    return {
      ...event,
      response: {
        ...response,
        output: this.order
          .map((key) => this.items.get(key))
          .filter(
            (item): item is Record<string, unknown> => item !== undefined,
          ),
      },
    };
  }

  private setItem(
    event: Record<string, unknown>,
    item: Record<string, unknown>
  ): void {
    const id = readString(item.id);
    const index =
      typeof event.output_index === "number" ? event.output_index : undefined;
    const key = id ?? `output:${index ?? this.order.length}`;
    if (!this.items.has(key)) this.order.push(key);
    this.items.set(key, item);
  }
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
