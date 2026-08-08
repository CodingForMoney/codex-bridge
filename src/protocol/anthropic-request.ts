import { createHash } from "node:crypto";
import { BridgeError } from "../errors.js";
import { decodeReasoningEnvelope } from "./reasoning-envelope.js";
import type {
  AnthropicMessageRequest,
  ConvertedRequest,
  RequestConversionOptions,
  ResponsesRequest
} from "./types.js";

const SUPPORTED_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function convertAnthropicRequest(
  value: unknown,
  options: RequestConversionOptions = {}
): ConvertedRequest {
  if (!isRecord(value)) {
    throw invalidRequest("Anthropic Messages request must be a JSON object.");
  }

  const model = options.modelOverride?.trim() || readString(value.model);
  if (!model) {
    throw invalidRequest("Anthropic Messages request requires a model.");
  }
  if (!Array.isArray(value.messages)) {
    throw invalidRequest("Anthropic Messages request requires a messages array.");
  }

  const anthropic: AnthropicMessageRequest = {
    model,
    messages: value.messages.filter(isRecord),
    ...(typeof value.max_tokens === "number" ? { max_tokens: value.max_tokens } : {}),
    ...(value.system !== undefined ? { system: value.system } : {}),
    ...(Array.isArray(value.tools) ? { tools: value.tools } : {}),
    ...(value.tool_choice !== undefined ? { tool_choice: value.tool_choice } : {}),
    ...(typeof value.stream === "boolean" ? { stream: value.stream } : {}),
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
    ...(isRecord(value.output_config) ? { output_config: value.output_config } : {}),
    ...(typeof value.reasoning_effort === "string" ? { reasoning_effort: value.reasoning_effort } : {}),
    ...(value.thinking !== undefined ? { thinking: value.thinking } : {})
  };

  const instructions = extractSystem(value.system) || "You are a helpful assistant.";
  const input = convertMessages(value.messages);
  if (input.length === 0) {
    throw invalidRequest("Anthropic Messages request contains no supported message content.");
  }

  const tools = convertTools(value.tools);
  const toolSelection = convertToolChoice(value.tool_choice, tools);
  const effort = resolveEffort(value, options.defaultEffort);
  const responses: ResponsesRequest = {
    model,
    instructions,
    input,
    ...(toolSelection.tools ? { tools: toolSelection.tools } : {}),
    tool_choice: toolSelection.choice,
    parallel_tool_calls:
      Boolean(toolSelection.tools?.length) &&
      !(isRecord(value.tool_choice) && value.tool_choice.disable_parallel_tool_use === true),
    reasoning: { effort, summary: "auto" },
    store: false,
    stream: true,
    include: ["reasoning.encrypted_content"],
    prompt_cache_key: promptCacheKey(value, instructions, tools),
    ...convertTextOptions(value.output_config)
  };

  return { anthropic, responses, requestedModel: model };
}

function convertMessages(messages: unknown[]): Array<Record<string, unknown>> {
  const input: Array<Record<string, unknown>> = [];
  for (const message of messages) {
    if (!isRecord(message)) {
      throw invalidRequest("Each Anthropic message must be an object.");
    }
    const role = readString(message.role);
    if (role !== "user" && role !== "assistant") {
      throw invalidRequest(`Unsupported Anthropic message role: ${role ?? "missing"}.`);
    }
    convertMessageContent(role, message.content, input);
  }
  return input;
}

function convertMessageContent(
  role: "user" | "assistant",
  content: unknown,
  input: Array<Record<string, unknown>>
): void {
  if (typeof content === "string") {
    if (content.length > 0) {
      input.push(messageItem(role, [{ type: role === "assistant" ? "output_text" : "input_text", text: content }]));
    }
    return;
  }
  if (!Array.isArray(content)) {
    throw invalidRequest("Anthropic message content must be a string or content block array.");
  }

  let pending: Array<Record<string, unknown>> = [];
  const flush = () => {
    if (pending.length > 0) {
      input.push(messageItem(role, pending));
      pending = [];
    }
  };

  for (const block of content) {
    if (!isRecord(block)) {
      throw invalidRequest("Anthropic content blocks must be objects.");
    }
    const type = readString(block.type);
    if (type === "text") {
      const text = readStringPreserveWhitespace(block.text);
      if (text !== undefined) {
        pending.push({ type: role === "assistant" ? "output_text" : "input_text", text });
      }
      continue;
    }
    if (type === "image" && role === "user") {
      pending.push(convertImageBlock(block));
      continue;
    }
    if (type === "redacted_thinking" && role === "assistant") {
      flush();
      const data = readString(block.data);
      const envelope = data ? decodeReasoningEnvelope(data) : undefined;
      if (envelope) {
        input.push({
          type: "reasoning",
          id: envelope.id,
          summary: [],
          encrypted_content: envelope.encryptedContent
        });
      }
      continue;
    }
    if (type === "thinking" && role === "assistant") {
      // Foreign reasoning cannot be replayed safely into the Codex backend.
      continue;
    }
    if (type === "tool_use" && role === "assistant") {
      flush();
      const id = readString(block.id);
      const name = readString(block.name);
      if (!id || !name) {
        throw invalidRequest("Anthropic tool_use blocks require id and name.");
      }
      input.push({
        type: "function_call",
        call_id: id,
        name,
        arguments: stringifyJson(block.input ?? {})
      });
      continue;
    }
    if (type === "tool_result" && role === "user") {
      flush();
      const callId = readString(block.tool_use_id) ?? readString(block.tool_call_id);
      if (!callId) {
        throw invalidRequest("Anthropic tool_result blocks require tool_use_id.");
      }
      input.push({
        type: "function_call_output",
        call_id: callId,
        output: convertToolResultOutput(block.content, block.is_error === true)
      });
      continue;
    }
    if (type === "server_tool_use" || type === "web_search_tool_result") {
      throw unsupportedRequest(`Anthropic content block ${type} is not supported yet.`);
    }
    throw unsupportedRequest(`Anthropic content block ${type ?? "missing"} is not supported.`);
  }
  flush();
}

function messageItem(role: "user" | "assistant", content: Array<Record<string, unknown>>): Record<string, unknown> {
  return { type: "message", role, content };
}

function convertImageBlock(block: Record<string, unknown>): Record<string, unknown> {
  const source = isRecord(block.source) ? block.source : undefined;
  const sourceType = readString(source?.type);
  if (sourceType === "base64") {
    const mediaType = readString(source?.media_type);
    const data = readString(source?.data);
    if (!mediaType || !data) {
      throw invalidRequest("Anthropic base64 image blocks require media_type and data.");
    }
    return { type: "input_image", image_url: `data:${mediaType};base64,${data}` };
  }
  if (sourceType === "url") {
    const url = readString(source?.url);
    if (!url) {
      throw invalidRequest("Anthropic URL image blocks require a URL.");
    }
    return { type: "input_image", image_url: url };
  }
  throw unsupportedRequest(`Anthropic image source ${sourceType ?? "missing"} is not supported.`);
}

function convertToolResultOutput(content: unknown, isError: boolean): unknown {
  if (typeof content === "string") {
    return isError ? `[Tool error]\n${content}` : content;
  }
  if (!Array.isArray(content)) {
    const serialized = stringifyJson(content ?? "");
    return isError ? `[Tool error]\n${serialized}` : serialized;
  }

  const items: Array<Record<string, unknown>> = [];
  for (const item of content) {
    if (!isRecord(item)) {
      continue;
    }
    const type = readString(item.type);
    if (type === "text") {
      const text = readStringPreserveWhitespace(item.text);
      if (text !== undefined) {
        items.push({ type: "input_text", text: isError ? `[Tool error]\n${text}` : text });
      }
      continue;
    }
    if (type === "image") {
      items.push(convertImageBlock(item));
      continue;
    }
  }
  if (items.length > 0) {
    return items;
  }
  const serialized = stringifyJson(content);
  return isError ? `[Tool error]\n${serialized}` : serialized;
}

function convertTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidRequest("Anthropic tools must be an array.");
  }
  const tools = value.map((tool) => {
    if (!isRecord(tool)) {
      throw invalidRequest("Anthropic tool definitions must be objects.");
    }
    const name = readString(tool.name);
    if (!name || !isRecord(tool.input_schema)) {
      throw invalidRequest("Anthropic tool definitions require name and input_schema.");
    }
    return {
      type: "function",
      name,
      ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
      parameters: tool.input_schema,
      strict: typeof tool.strict === "boolean" ? tool.strict : false
    };
  });
  return tools.length > 0 ? tools : undefined;
}

function convertToolChoice(
  value: unknown,
  tools: Array<Record<string, unknown>> | undefined
): { choice: string; tools: Array<Record<string, unknown>> | undefined } {
  if (value === undefined) {
    return { choice: "auto", tools };
  }
  if (typeof value === "string") {
    return { choice: value, tools };
  }
  if (!isRecord(value)) {
    throw invalidRequest("Anthropic tool_choice must be a string or object.");
  }
  const type = readString(value.type);
  if (type === "auto" || type === "none") {
    return { choice: type, tools };
  }
  if (type === "any" || type === "required") {
    return { choice: "required", tools };
  }
  if (type === "tool") {
    const name = readString(value.name);
    if (!name) {
      throw invalidRequest("Named Anthropic tool_choice requires a name.");
    }
    const selected = tools?.filter((tool) => tool.name === name);
    if (!selected?.length) {
      throw invalidRequest(`Named Anthropic tool_choice refers to undefined tool: ${name}.`);
    }
    return { choice: "required", tools: selected };
  }
  throw unsupportedRequest(`Anthropic tool_choice ${type ?? "missing"} is not supported.`);
}

function extractSystem(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts: string[] = [];
  for (const block of value) {
    if (isRecord(block) && readString(block.type) === "text") {
      const text = readStringPreserveWhitespace(block.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts.join("\n").trim() || undefined;
}

function resolveEffort(body: Record<string, unknown>, fallback = "medium"): string {
  const outputConfig = isRecord(body.output_config) ? body.output_config : undefined;
  const raw = readString(outputConfig?.effort) ?? readString(body.reasoning_effort) ?? fallback;
  const normalized = raw.toLowerCase() === "ultracode" ? "xhigh" : raw.toLowerCase();
  if (!SUPPORTED_EFFORTS.has(normalized)) {
    throw invalidRequest(`Unsupported reasoning effort: ${raw}.`);
  }
  return normalized;
}

function convertTextOptions(value: unknown): Pick<ResponsesRequest, "text"> | Record<string, never> {
  if (!isRecord(value)) {
    return {};
  }
  const verbosity = readString(value.verbosity);
  return verbosity ? { text: { verbosity } } : {};
}

function promptCacheKey(
  body: Record<string, unknown>,
  instructions: string,
  tools: Array<Record<string, unknown>> | undefined
): string {
  const metadata = isRecord(body.metadata) ? body.metadata : undefined;
  const userId = readString(metadata?.user_id);
  const material = userId ?? JSON.stringify({ instructions, tools: tools?.map((tool) => tool.name) ?? [] });
  return `codex-bridge-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    throw invalidRequest("Anthropic tool content must be JSON serializable.");
  }
}

function invalidRequest(message: string): BridgeError {
  return new BridgeError("PROTOCOL_REQUEST_INVALID", message, { statusCode: 400 });
}

function unsupportedRequest(message: string): BridgeError {
  return new BridgeError("PROTOCOL_REQUEST_UNSUPPORTED", message, { statusCode: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringPreserveWhitespace(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
