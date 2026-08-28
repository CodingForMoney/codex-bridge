import { createHash } from "node:crypto";
import { BridgeError } from "../errors.js";
import { resolveSupportedModel } from "../models.js";
import type { CodexCompactRequest, CodexResponsesRequest, RequestConversionOptions } from "./types.js";

const SUPPORTED_EFFORTS = new Set(["none", "low", "medium", "high", "xhigh", "max"]);
const REQUIRED_INCLUDE = "reasoning.encrypted_content";

export interface ConvertedResponsesRequest {
  clientStream: boolean;
  responses: CodexResponsesRequest;
  requestedModel: string;
}

export interface ConvertedResponsesCompactRequest {
  compact: CodexCompactRequest;
  requestedModel: string;
}

export function convertResponsesRequest(
  value: unknown,
  options: RequestConversionOptions = {}
): ConvertedResponsesRequest {
  if (!isRecord(value)) {
    throw invalidRequest("Responses request must be a JSON object.");
  }

  const requestedModel = resolveSupportedModel(value, options.modelOverride);
  const clientStream = optionalBoolean(value.stream, "stream") ?? false;
  validateStatelessRequest(value);
  const instructions = normalizeInstructions(value.instructions);
  const input = normalizeInput(value.input);
  const tools = normalizeTools(value.tools);
  const toolSelection = normalizeToolChoice(value.tool_choice, tools);
  const reasoning = normalizeReasoning(value.reasoning, options.defaultEffort);
  const text = normalizeText(value.text);
  const promptCacheKey = normalizePromptCacheKey(value.prompt_cache_key, instructions, toolSelection.tools);

  return {
    clientStream,
    requestedModel,
    responses: {
      model: requestedModel,
      instructions,
      input,
      ...(toolSelection.tools ? { tools: toolSelection.tools } : {}),
      tool_choice: toolSelection.choice,
      parallel_tool_calls:
        optionalBoolean(value.parallel_tool_calls, "parallel_tool_calls") ?? Boolean(toolSelection.tools?.length),
      reasoning,
      store: false,
      stream: true,
      include: normalizeInclude(value.include),
      prompt_cache_key: promptCacheKey,
      ...(text ? { text } : {})
    }
  };
}

export function convertResponsesCompactRequest(
  value: unknown,
  options: RequestConversionOptions = {}
): ConvertedResponsesCompactRequest {
  if (!isRecord(value)) {
    throw invalidRequest("Responses compact request must be a JSON object.");
  }

  validateCompactRequest(value);
  const requestedModel = resolveSupportedModel(value, options.modelOverride);
  const normalizedInput = normalizeInput(value.input);
  const input = typeof normalizedInput === "string"
    ? [{ role: "user", content: [{ type: "input_text", text: normalizedInput }] }]
    : normalizedInput;
  const instructions = optionalString(value.instructions, "instructions");
  const tools = normalizeTools(value.tools);
  const reasoning = value.reasoning === undefined
    ? undefined
    : normalizeReasoning(value.reasoning, options.defaultEffort);
  const text = normalizeText(value.text);
  const promptCacheKey = optionalString(value.prompt_cache_key, "prompt_cache_key");
  const serviceTier = optionalString(value.service_tier, "service_tier");

  return {
    requestedModel,
    compact: {
      model: requestedModel,
      input,
      ...(instructions !== undefined ? { instructions } : {}),
      ...(tools ? { tools } : {}),
      parallel_tool_calls:
        optionalBoolean(value.parallel_tool_calls, "parallel_tool_calls") ?? Boolean(tools?.length),
      ...(reasoning ? { reasoning } : {}),
      ...(serviceTier !== undefined ? { service_tier: serviceTier } : {}),
      ...(promptCacheKey !== undefined ? { prompt_cache_key: promptCacheKey } : {}),
      ...(text ? { text } : {})
    }
  };
}

export function normalizeReasoningEffort(value: string): string {
  const normalized = value.trim().toLowerCase() === "ultracode" ? "xhigh" : value.trim().toLowerCase();
  if (!SUPPORTED_EFFORTS.has(normalized)) {
    throw invalidRequest(`Unsupported reasoning effort: ${value}.`);
  }
  return normalized;
}

function validateStatelessRequest(value: Record<string, unknown>): void {
  if (value.store !== undefined && value.store !== false) {
    throw unsupportedRequest("Responses store must be false because Codex Bridge does not persist responses.");
  }
  if (value.background !== undefined && value.background !== false) {
    throw unsupportedRequest("Responses background mode is not supported.");
  }
  for (const field of ["previous_response_id", "conversation"] as const) {
    if (value[field] !== undefined && value[field] !== null) {
      throw unsupportedRequest(`Responses ${field} is not supported; send complete input history instead.`);
    }
  }
}

function validateCompactRequest(value: Record<string, unknown>): void {
  for (const field of ["previous_response_id", "conversation"] as const) {
    if (value[field] !== undefined && value[field] !== null) {
      throw unsupportedRequest(`Responses compact ${field} is not supported; send complete input history instead.`);
    }
  }
  for (const field of ["stream", "store", "background", "include"] as const) {
    if (value[field] !== undefined) {
      throw unsupportedRequest(`Responses compact ${field} is not supported.`);
    }
  }
}

function normalizeInstructions(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "You are a helpful assistant.";
  }
  if (typeof value !== "string") {
    throw invalidRequest("Responses instructions must be a string.");
  }
  return value;
}

function normalizeInput(value: unknown): string | Array<Record<string, unknown>> {
  if (typeof value === "string") {
    if (!value.length) {
      throw invalidRequest("Responses input must not be empty.");
    }
    return value;
  }
  if (!Array.isArray(value) || value.length === 0 || !value.every(isRecord)) {
    throw invalidRequest("Responses input must be a non-empty string or array of input items.");
  }
  for (const item of value) {
    validateInputItem(item);
  }
  return value;
}

function validateInputItem(item: Record<string, unknown>): void {
  const type = readString(item.type);
  if (type === undefined || type === "message") {
    validateMessageItem(item);
    return;
  }
  if (type === "reasoning") {
    if (!readString(item.id) || !readString(item.encrypted_content)) {
      throw invalidRequest("Responses reasoning input items require id and encrypted_content.");
    }
    return;
  }
  if (type === "compaction") {
    if (!readString(item.encrypted_content)) {
      throw invalidRequest("Responses compaction input items require encrypted_content.");
    }
    if (item.id !== undefined && !readString(item.id)) {
      throw invalidRequest("Responses compaction input item id must be a non-empty string when supplied.");
    }
    return;
  }
  if (type === "function_call") {
    if (!readString(item.call_id) || !readString(item.name) || typeof item.arguments !== "string") {
      throw invalidRequest("Responses function_call input items require call_id, name, and string arguments.");
    }
    return;
  }
  if (type === "function_call_output") {
    if (!readString(item.call_id) || item.output === undefined) {
      throw invalidRequest("Responses function_call_output input items require call_id and output.");
    }
    return;
  }
  throw unsupportedRequest(`Responses input item type ${type} is not supported.`);
}

function validateMessageItem(item: Record<string, unknown>): void {
  const role = readString(item.role);
  if (role !== "user" && role !== "assistant" && role !== "system" && role !== "developer") {
    throw invalidRequest(`Responses message input requires a supported role; received ${role ?? "missing"}.`);
  }
  if (typeof item.content === "string") {
    return;
  }
  if (!Array.isArray(item.content) || !item.content.every(isRecord)) {
    throw invalidRequest("Responses message content must be a string or content block array.");
  }
  for (const block of item.content) {
    const type = readString(block.type);
    if (type === "input_text" || type === "output_text") {
      if (typeof block.text !== "string") {
        throw invalidRequest(`Responses ${type} blocks require text.`);
      }
      continue;
    }
    if (type === "input_image") {
      if (!readString(block.image_url)) {
        throw invalidRequest("Responses input_image blocks require image_url.");
      }
      continue;
    }
    if (type === "refusal") {
      if (typeof block.refusal !== "string") {
        throw invalidRequest("Responses refusal blocks require refusal text.");
      }
      continue;
    }
    throw unsupportedRequest(`Responses message content type ${type ?? "missing"} is not supported.`);
  }
}

function normalizeTools(value: unknown): Array<Record<string, unknown>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw invalidRequest("Responses tools must be an array.");
  }
  const tools = value.map((tool) => {
    if (!isRecord(tool)) {
      throw invalidRequest("Responses tool definitions must be objects.");
    }
    const type = readString(tool.type);
    if (type !== "function") {
      throw unsupportedRequest(`Responses tool type ${type ?? "missing"} is not supported.`);
    }
    const name = readString(tool.name);
    if (!name || !isRecord(tool.parameters)) {
      throw invalidRequest("Responses function tools require name and parameters.");
    }
    return {
      type: "function",
      name,
      ...(readString(tool.description) ? { description: readString(tool.description) } : {}),
      parameters: tool.parameters,
      strict: typeof tool.strict === "boolean" ? tool.strict : false
    };
  });
  return tools.length ? tools : undefined;
}

function normalizeToolChoice(
  value: unknown,
  tools: Array<Record<string, unknown>> | undefined
): { choice: string; tools: Array<Record<string, unknown>> | undefined } {
  if (value === undefined) {
    return { choice: "auto", tools };
  }
  if (typeof value === "string") {
    if (value !== "auto" && value !== "none" && value !== "required") {
      throw unsupportedRequest(`Responses tool_choice ${value} is not supported.`);
    }
    return { choice: value, tools };
  }
  if (!isRecord(value) || readString(value.type) !== "function") {
    throw unsupportedRequest("Responses tool_choice supports only auto, none, required, or a named function.");
  }
  const name = readString(value.name);
  const selected = name ? tools?.filter((tool) => tool.name === name) : undefined;
  if (!name || !selected?.length) {
    throw invalidRequest(`Named Responses tool_choice refers to an undefined function: ${name ?? "missing"}.`);
  }
  return { choice: "required", tools: selected };
}

function normalizeReasoning(
  value: unknown,
  fallback = "medium"
): CodexResponsesRequest["reasoning"] {
  if (value !== undefined && !isRecord(value)) {
    throw invalidRequest("Responses reasoning must be an object.");
  }
  const reasoning = value as Record<string, unknown> | undefined;
  for (const key of Object.keys(reasoning ?? {})) {
    if (key !== "effort" && key !== "summary") {
      throw unsupportedRequest(`Responses reasoning.${key} is not supported.`);
    }
  }
  const rawEffort = readString(reasoning?.effort) ?? fallback;
  const summary = readString(reasoning?.summary);
  if (summary !== undefined && summary !== "auto") {
    throw unsupportedRequest(`Responses reasoning.summary ${summary} is not supported.`);
  }
  return { effort: normalizeReasoningEffort(rawEffort), summary: "auto" };
}

function normalizeText(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw invalidRequest("Responses text must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (key !== "verbosity" && key !== "format") {
      throw unsupportedRequest(`Responses text.${key} is not supported.`);
    }
  }
  const verbosity = readString(value.verbosity);
  if (verbosity !== undefined && verbosity !== "low" && verbosity !== "medium" && verbosity !== "high") {
    throw invalidRequest(`Unsupported Responses text verbosity: ${verbosity}.`);
  }
  if (value.format !== undefined && !isRecord(value.format)) {
    throw invalidRequest("Responses text.format must be an object.");
  }
  return {
    ...(verbosity ? { verbosity } : {}),
    ...(isRecord(value.format) ? { format: value.format } : {})
  };
}

function normalizeInclude(value: unknown): string[] {
  if (value === undefined) {
    return [REQUIRED_INCLUDE];
  }
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw invalidRequest("Responses include must be an array of strings.");
  }
  for (const item of value) {
    if (item !== REQUIRED_INCLUDE) {
      throw unsupportedRequest(`Responses include value ${item} is not supported.`);
    }
  }
  return [REQUIRED_INCLUDE];
}

function normalizePromptCacheKey(
  value: unknown,
  instructions: string,
  tools: Array<Record<string, unknown>> | undefined
): string {
  if (value !== undefined) {
    const provided = readString(value);
    if (!provided) {
      throw invalidRequest("Responses prompt_cache_key must be a non-empty string.");
    }
    return provided;
  }
  const material = JSON.stringify({ instructions, tools: tools?.map((tool) => tool.name) ?? [] });
  return `codex-bridge-${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

function optionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw invalidRequest(`Responses ${field} must be a boolean.`);
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = readString(value);
  if (!normalized) {
    throw invalidRequest(`Responses compact ${field} must be a non-empty string.`);
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function invalidRequest(message: string): BridgeError {
  return new BridgeError("PROTOCOL_REQUEST_INVALID", message, { statusCode: 400 });
}

function unsupportedRequest(message: string): BridgeError {
  return new BridgeError("PROTOCOL_REQUEST_UNSUPPORTED", message, { statusCode: 400 });
}
