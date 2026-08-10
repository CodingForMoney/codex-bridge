export interface AnthropicMessageRequest {
  model: string;
  messages: Array<Record<string, unknown>>;
  max_tokens?: number;
  system?: unknown;
  tools?: unknown[];
  tool_choice?: unknown;
  stream?: boolean;
  metadata?: Record<string, unknown>;
  output_config?: Record<string, unknown>;
  reasoning_effort?: string;
  thinking?: unknown;
}

export interface CodexResponsesRequest {
  model: string;
  instructions: string;
  input: string | Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  tool_choice: string;
  parallel_tool_calls: boolean;
  reasoning: {
    effort: string;
    summary: "auto";
  };
  store: false;
  stream: true;
  include: string[];
  prompt_cache_key: string;
  text?: Record<string, unknown>;
}

export interface RequestConversionOptions {
  defaultEffort?: string;
  modelOverride?: string;
}

export interface ConvertedRequest {
  anthropic: AnthropicMessageRequest;
  responses: CodexResponsesRequest & { input: Array<Record<string, unknown>> };
  requestedModel: string;
}
