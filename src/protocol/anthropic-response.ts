import { randomUUID } from "node:crypto";
import { BridgeError } from "../errors.js";
import { encodeReasoningEnvelope } from "./reasoning-envelope.js";
import { parseSseStream } from "./sse.js";

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface AnthropicMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: Array<Record<string, unknown>>;
  stop_reason: "end_turn" | "tool_use" | "max_tokens";
  stop_sequence: null;
  usage: AnthropicUsage;
}

export async function collectCodexResponse(
  body: ReadableStream<Uint8Array> | null,
  model: string
): Promise<AnthropicMessage> {
  const state = new ResponseAccumulator(model);
  for await (const frame of parseSseStream(body)) {
    if (frame.data === "[DONE]") {
      continue;
    }
    state.accept(parseEvent(frame.data));
  }
  return state.finish();
}

export class ResponseAccumulator {
  private id = `msg_${randomUUID().replaceAll("-", "")}`;
  private readonly items = new Map<string, Record<string, unknown>>();
  private readonly order: string[] = [];
  private completed = false;
  private incomplete = false;
  private usage: AnthropicUsage = { input_tokens: 0, output_tokens: 0 };

  constructor(private readonly model: string) {}

  accept(event: Record<string, unknown>): void {
    const type = readString(event.type);
    if (type === "response.created" || type === "response.in_progress") {
      const response = record(event.response);
      this.id = anthropicId(readString(response?.id) ?? this.id);
      return;
    }
    if (type === "response.output_item.added" || type === "response.output_item.done") {
      const item = record(event.item);
      if (item) {
        this.setItem(item, type.endsWith(".done"));
      }
      return;
    }
    if (type === "response.output_text.delta") {
      this.appendText(event);
      return;
    }
    if (type === "response.function_call_arguments.delta") {
      this.appendArguments(event);
      return;
    }
    if (type === "response.completed" || type === "response.incomplete") {
      const response = record(event.response);
      this.id = anthropicId(readString(response?.id) ?? this.id);
      this.completed = type === "response.completed";
      this.incomplete = type === "response.incomplete";
      this.usage = mapUsage(response?.usage);
      this.acceptOutput(response?.output);
      return;
    }
    if (type === "response.failed" || type === "error") {
      throw upstreamEventError(event);
    }
  }

  finish(): AnthropicMessage {
    if (!this.completed && !this.incomplete) {
      throw new BridgeError(
        "PROTOCOL_RESPONSE_INVALID",
        "Codex stream ended before response.completed or response.incomplete.",
        { retryable: true, statusCode: 502 }
      );
    }
    const content = this.order
      .map((key) => this.items.get(key))
      .filter((item): item is Record<string, unknown> => item !== undefined)
      .map(toAnthropicBlock)
      .filter((item): item is Record<string, unknown> => item !== undefined);
    const hasTools = content.some((block) => block.type === "tool_use");
    return {
      id: this.id,
      type: "message",
      role: "assistant",
      model: this.model,
      content,
      stop_reason: this.incomplete ? "max_tokens" : hasTools ? "tool_use" : "end_turn",
      stop_sequence: null,
      usage: this.usage
    };
  }

  private setItem(item: Record<string, unknown>, done: boolean): void {
    const key = itemKey(item, this.order.length);
    if (!this.items.has(key)) {
      this.order.push(key);
    }
    const prior = this.items.get(key);
    if (done || !prior) {
      this.items.set(key, { ...prior, ...item });
    }
  }

  private appendText(event: Record<string, unknown>): void {
    const delta = readStringPreserve(event.delta);
    if (delta === undefined) {
      return;
    }
    const key = eventKey(event, "message", this.order.length);
    const current = this.items.get(key);
    if (!current) {
      this.order.push(key);
      this.items.set(key, { type: "message", id: key, role: "assistant", content: [] });
    }
    const item = this.items.get(key)!;
    const content = Array.isArray(item.content) ? [...item.content] : [];
    const last = record(content.at(-1));
    if (last?.type === "output_text") {
      last.text = `${readStringPreserve(last.text) ?? ""}${delta}`;
      content[content.length - 1] = last;
    } else {
      content.push({ type: "output_text", text: delta });
    }
    item.content = content;
  }

  private appendArguments(event: Record<string, unknown>): void {
    const delta = readStringPreserve(event.delta);
    if (delta === undefined) {
      return;
    }
    const key = eventKey(event, "function_call", this.order.length);
    if (!this.items.has(key)) {
      this.order.push(key);
      this.items.set(key, {
        type: "function_call",
        id: key,
        call_id: readString(event.call_id) ?? key,
        name: readString(event.name) ?? "unknown_tool",
        arguments: ""
      });
    }
    const item = this.items.get(key)!;
    item.arguments = `${readStringPreserve(item.arguments) ?? ""}${delta}`;
  }

  private acceptOutput(output: unknown): void {
    if (!Array.isArray(output)) {
      return;
    }
    for (const item of output) {
      if (isRecord(item)) {
        this.setItem(item, true);
      }
    }
  }
}

export function parseEvent(data: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(data);
    if (isRecord(value)) {
      return value;
    }
  } catch (error) {
    throw new BridgeError("PROTOCOL_RESPONSE_INVALID", "Codex returned malformed SSE JSON.", {
      cause: error,
      statusCode: 502
    });
  }
  throw new BridgeError("PROTOCOL_RESPONSE_INVALID", "Codex returned a non-object SSE event.", {
    statusCode: 502
  });
}

export function mapUsage(value: unknown): AnthropicUsage {
  const usage = record(value);
  const details = record(usage?.input_tokens_details);
  const cached = readNumber(details?.cached_tokens);
  const created = readNumber(details?.cache_write_tokens);
  return {
    input_tokens: readNumber(usage?.input_tokens) ?? 0,
    output_tokens: readNumber(usage?.output_tokens) ?? 0,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
    ...(created !== undefined ? { cache_creation_input_tokens: created } : {})
  };
}

function toAnthropicBlock(item: Record<string, unknown>): Record<string, unknown> | undefined {
  const type = readString(item.type);
  if (type === "message") {
    const content = Array.isArray(item.content) ? item.content : [];
    const text = content
      .map(record)
      .filter((entry): entry is Record<string, unknown> => entry !== undefined)
      .filter((entry) => entry.type === "output_text")
      .map((entry) => readStringPreserve(entry.text) ?? "")
      .join("");
    return text ? { type: "text", text } : undefined;
  }
  if (type === "function_call") {
    const callId = readString(item.call_id) ?? readString(item.id);
    const name = readString(item.name);
    if (!callId || !name) {
      return undefined;
    }
    return { type: "tool_use", id: callId, name, input: parseArguments(item.arguments) };
  }
  if (type === "reasoning") {
    const id = readString(item.id);
    const encrypted = readString(item.encrypted_content);
    if (!id || !encrypted) {
      return undefined;
    }
    return { type: "redacted_thinking", data: encodeReasoningEnvelope(id, encrypted) };
  }
  return undefined;
}

function parseArguments(value: unknown): unknown {
  const text = readStringPreserve(value) ?? "{}";
  try {
    return JSON.parse(text);
  } catch {
    return { _codex_bridge_raw_arguments: text };
  }
}

function itemKey(item: Record<string, unknown>, fallback: number): string {
  return readString(item.id) ?? readString(item.call_id) ?? `${readString(item.type) ?? "item"}-${fallback}`;
}

function eventKey(event: Record<string, unknown>, kind: string, fallback: number): string {
  return readString(event.item_id) ?? readString(event.call_id) ?? `${kind}-${fallback}`;
}

function anthropicId(id: string): string {
  return id.startsWith("msg_") ? id : `msg_${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
}

function upstreamEventError(event: Record<string, unknown>): BridgeError {
  const error = record(event.error) ?? record(record(event.response)?.error);
  const message = readString(error?.message) ?? readString(event.message) ?? "Codex response failed.";
  return new BridgeError("CODEX_UPSTREAM_ERROR", message, { retryable: true, statusCode: 502 });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringPreserve(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
