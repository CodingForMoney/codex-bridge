import { randomUUID } from "node:crypto";
import { asBridgeError, toAnthropicErrorBody } from "../errors.js";
import { encodeReasoningEnvelope } from "./reasoning-envelope.js";
import { mapUsage, parseEvent } from "./anthropic-response.js";
import { encodeSse, parseSseStream } from "./sse.js";

interface OpenBlock {
  index: number;
  kind: "text" | "tool";
  receivedDelta: boolean;
}

export async function* streamCodexAsAnthropic(
  body: ReadableStream<Uint8Array> | null,
  model: string
): AsyncGenerator<string> {
  const state = new AnthropicStreamState(model);
  try {
    for await (const frame of parseSseStream(body)) {
      if (frame.data === "[DONE]") {
        continue;
      }
      for (const event of state.accept(parseEvent(frame.data))) {
        yield event;
      }
    }
    for (const event of state.finish()) {
      yield event;
    }
  } catch (error) {
    yield encodeSse("error", toAnthropicErrorBody(asBridgeError(error)));
  }
}

class AnthropicStreamState {
  private id = `msg_${randomUUID().replaceAll("-", "")}`;
  private started = false;
  private terminal = false;
  private nextIndex = 0;
  private readonly blocks = new Map<string, OpenBlock>();
  private readonly emitted = new Set<string>();
  private sawTool = false;

  constructor(private readonly model: string) {}

  accept(event: Record<string, unknown>): string[] {
    const output: string[] = [];
    const type = readString(event.type);
    if (type === "response.created" || type === "response.in_progress") {
      const response = record(event.response);
      this.id = anthropicId(readString(response?.id) ?? this.id);
      this.ensureStart(output);
      return output;
    }

    if (type === "response.output_text.delta") {
      this.ensureStart(output);
      const key = eventKey(event, "text");
      const block = this.ensureTextBlock(key, output);
      const delta = readStringPreserve(event.delta);
      if (delta !== undefined) {
        block.receivedDelta = true;
        output.push(
          encodeSse("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "text_delta", text: delta }
          })
        );
      }
      return output;
    }

    if (type === "response.output_text.done") {
      const key = eventKey(event, "text");
      this.closeBlock(key, output);
      this.emitted.add(key);
      return output;
    }

    if (type === "response.output_item.added") {
      const item = record(event.item);
      if (item?.type === "function_call") {
        this.ensureStart(output);
        this.ensureToolBlock(itemKey(item, event), item, output);
      }
      return output;
    }

    if (type === "response.function_call_arguments.delta") {
      this.ensureStart(output);
      const key = eventKey(event, "tool");
      const block = this.ensureToolBlock(key, event, output);
      const delta = readStringPreserve(event.delta);
      if (delta !== undefined) {
        block.receivedDelta = true;
        output.push(
          encodeSse("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: delta }
          })
        );
      }
      return output;
    }

    if (type === "response.output_item.done") {
      const item = record(event.item);
      if (item) {
        this.emitCompletedItem(item, event, output);
      }
      return output;
    }

    if (type === "response.completed" || type === "response.incomplete") {
      const response = record(event.response);
      this.id = anthropicId(readString(response?.id) ?? this.id);
      this.ensureStart(output);
      this.emitUnseenOutput(response?.output, output);
      this.closeAll(output);
      const usage = mapUsage(response?.usage);
      output.push(
        encodeSse("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: type === "response.incomplete" ? "max_tokens" : this.sawTool ? "tool_use" : "end_turn",
            stop_sequence: null
          },
          usage
        })
      );
      output.push(encodeSse("message_stop", { type: "message_stop" }));
      this.terminal = true;
      return output;
    }

    if (type === "response.failed" || type === "error") {
      throw new Error(readString(record(event.error)?.message) ?? "Codex response failed.");
    }
    return output;
  }

  finish(): string[] {
    if (this.terminal) {
      return [];
    }
    throw new Error("Codex stream ended before response.completed or response.incomplete.");
  }

  private ensureStart(output: string[]): void {
    if (this.started) {
      return;
    }
    output.push(
      encodeSse("message_start", {
        type: "message_start",
        message: {
          id: this.id,
          type: "message",
          role: "assistant",
          model: this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      })
    );
    this.started = true;
  }

  private ensureTextBlock(key: string, output: string[]): OpenBlock {
    const existing = this.blocks.get(key);
    if (existing) {
      return existing;
    }
    const block: OpenBlock = { index: this.nextIndex++, kind: "text", receivedDelta: false };
    this.blocks.set(key, block);
    output.push(
      encodeSse("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "text", text: "" }
      })
    );
    return block;
  }

  private ensureToolBlock(
    key: string,
    item: Record<string, unknown>,
    output: string[]
  ): OpenBlock {
    const existing = this.blocks.get(key);
    if (existing) {
      return existing;
    }
    const id = readString(item.call_id) ?? readString(item.id) ?? key;
    const name = readString(item.name) ?? "unknown_tool";
    const block: OpenBlock = { index: this.nextIndex++, kind: "tool", receivedDelta: false };
    this.blocks.set(key, block);
    this.sawTool = true;
    output.push(
      encodeSse("content_block_start", {
        type: "content_block_start",
        index: block.index,
        content_block: { type: "tool_use", id, name, input: {} }
      })
    );
    return block;
  }

  private emitCompletedItem(
    item: Record<string, unknown>,
    event: Record<string, unknown>,
    output: string[]
  ): void {
    const type = readString(item.type);
    const key = itemKey(item, event);
    if (this.emitted.has(key)) {
      return;
    }
    if (type === "message") {
      const block = this.blocks.get(key);
      if (!block) {
        const text = outputText(item);
        if (text) {
          const created = this.ensureTextBlock(key, output);
          output.push(
            encodeSse("content_block_delta", {
              type: "content_block_delta",
              index: created.index,
              delta: { type: "text_delta", text }
            })
          );
        }
      }
      this.closeBlock(key, output);
      this.emitted.add(key);
      return;
    }
    if (type === "function_call") {
      const block = this.ensureToolBlock(key, item, output);
      if (!block.receivedDelta) {
        const args = readStringPreserve(item.arguments) ?? "{}";
        output.push(
          encodeSse("content_block_delta", {
            type: "content_block_delta",
            index: block.index,
            delta: { type: "input_json_delta", partial_json: args }
          })
        );
      }
      this.closeBlock(key, output);
      this.emitted.add(key);
      return;
    }
    if (type === "reasoning") {
      const id = readString(item.id);
      const encrypted = readString(item.encrypted_content);
      if (id && encrypted) {
        const index = this.nextIndex++;
        output.push(
          encodeSse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "redacted_thinking", data: encodeReasoningEnvelope(id, encrypted) }
          })
        );
        output.push(encodeSse("content_block_stop", { type: "content_block_stop", index }));
        this.emitted.add(key);
      }
    }
  }

  private emitUnseenOutput(value: unknown, output: string[]): void {
    if (!Array.isArray(value)) {
      return;
    }
    for (const item of value) {
      if (!isRecord(item)) {
        continue;
      }
      const key = itemKey(item, item);
      if (!this.emitted.has(key)) {
        this.emitCompletedItem(item, item, output);
      }
    }
  }

  private closeBlock(key: string, output: string[]): void {
    const block = this.blocks.get(key);
    if (!block) {
      return;
    }
    output.push(encodeSse("content_block_stop", { type: "content_block_stop", index: block.index }));
    this.blocks.delete(key);
  }

  private closeAll(output: string[]): void {
    for (const [key] of this.blocks) {
      this.closeBlock(key, output);
    }
  }
}

function outputText(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) {
    return "";
  }
  return item.content
    .map(record)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined && entry.type === "output_text")
    .map((entry) => readStringPreserve(entry.text) ?? "")
    .join("");
}

function eventKey(event: Record<string, unknown>, fallback: string): string {
  return readString(event.item_id) ?? readString(event.call_id) ?? fallback;
}

function itemKey(item: Record<string, unknown>, event: Record<string, unknown>): string {
  return readString(item.id) ?? readString(item.call_id) ?? eventKey(event, `item-${readString(item.type) ?? "unknown"}`);
}

function anthropicId(id: string): string {
  return id.startsWith("msg_") ? id : `msg_${id.replace(/[^A-Za-z0-9_-]/g, "")}`;
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
