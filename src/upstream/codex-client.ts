import { BridgeError, redactSecrets } from "../errors.js";
import type { CodexCredential } from "../auth/credential-status.js";
import { CodexCredentialReader } from "../auth/credential-reader.js";
import type { CodexCompactRequest, CodexResponsesRequest } from "../protocol/types.js";

export interface CodexClientOptions {
  credentialReader: CodexCredentialReader;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clientVersion?: string;
}

export class CodexClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientVersion: string;

  constructor(private readonly options: CodexClientOptions) {
    this.baseUrl = (options.baseUrl ?? "https://chatgpt.com/backend-api/codex").replace(/\/$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.clientVersion = options.clientVersion ?? "0.139.0";
  }

  async createResponse(request: CodexResponsesRequest, signal?: AbortSignal): Promise<Response> {
    return this.withCredentialReload("responses", (credential) =>
      this.request("responses", credential, {
        method: "POST",
        accept: "text/event-stream",
        body: JSON.stringify(request),
        ...(signal ? { signal } : {})
      })
    );
  }

  async compactResponse(request: CodexCompactRequest, signal?: AbortSignal): Promise<Response> {
    return this.withCredentialReload("compaction", (credential) =>
      this.request("responses", credential, {
        method: "POST",
        accept: "text/event-stream",
        body: JSON.stringify({
          model: request.model,
          instructions: request.instructions ?? "",
          input: [...request.input, { type: "compaction_trigger" }],
          ...(request.tools ? { tools: request.tools } : {}),
          tool_choice: "auto",
          parallel_tool_calls: request.parallel_tool_calls,
          reasoning: request.reasoning ?? { effort: "medium", summary: "auto" },
          store: false,
          stream: true,
          include: ["reasoning.encrypted_content"],
          prompt_cache_key: request.prompt_cache_key ?? "codex-bridge-compaction",
          ...(request.service_tier ? { service_tier: request.service_tier } : {}),
          ...(request.text ? { text: request.text } : {})
        } satisfies CodexResponsesRequest),
        ...(signal ? { signal } : {})
      })
    );
  }

  private async withCredentialReload(
    operation: "responses" | "compaction",
    perform: (credential: CodexCredential) => Promise<Response>
  ): Promise<Response> {
    const first = await this.options.credentialReader.read();
    let response = await perform(first);
    if (response.status === 401) {
      response.body?.cancel().catch(() => undefined);
      const latest = await this.options.credentialReader.read();
      if (latest.accessToken !== first.accessToken) {
        response = await perform(latest);
      }
    }
    if (!response.ok) {
      throw await responseError(response, operation);
    }
    return response;
  }

  private async request(
    path: string,
    credential: CodexCredential,
    init: { method: "GET" | "POST"; accept: string; body?: string; signal?: AbortSignal }
  ): Promise<Response> {
    const headers = new Headers({
      authorization: `Bearer ${credential.accessToken}`,
      "chatgpt-account-id": credential.accountId,
      originator: "codex_cli_rs",
      "user-agent": `codex_cli_rs/${this.clientVersion} (codex-bridge)`,
      accept: init.accept
    });
    if (init.body !== undefined) {
      headers.set("content-type", "application/json");
    }
    if (credential.isFedramp) {
      headers.set("x-openai-fedramp", "true");
    }
    try {
      return await this.fetchImpl(`${this.baseUrl}/${path}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {})
      });
    } catch (error) {
      if (init.signal?.aborted) {
        throw error;
      }
      throw new BridgeError(
        "CODEX_UPSTREAM_UNREACHABLE",
        `Codex backend could not be reached at ${this.baseUrl}.`,
        { cause: error, retryable: true, statusCode: 502 }
      );
    }
  }
}

async function responseError(
  response: Response,
  operation: "responses" | "compaction"
): Promise<BridgeError> {
  const raw = await response.text().catch(() => "");
  const upstream = safeUpstreamError(raw);
  const message = upstream.message ?? `Codex backend returned HTTP ${response.status}.`;
  if (response.status === 401) {
    return new BridgeError(
      "CODEX_AUTH_UNAUTHORIZED",
      "Codex rejected the current login. Open Codex and make a request to refresh the login, or run `codex login`, then retry.",
      { statusCode: 401 }
    );
  }
  if (response.status === 429) {
    return new BridgeError("CODEX_UPSTREAM_RATE_LIMITED", message, {
      retryable: true,
      statusCode: 429
    });
  }
  if (operation === "compaction") {
    if (isCompactionInputTooLarge(response.status, upstream.code)) {
      return new BridgeError("CODEX_COMPACTION_INPUT_TOO_LARGE", message, {
        statusCode: response.status
      });
    }
    if (isModelCompactionUnavailable(upstream.code, message)) {
      return new BridgeError("CODEX_MODEL_COMPACTION_UNAVAILABLE", message, {
        statusCode: response.status
      });
    }
    if (response.status === 404 || response.status === 405) {
      return new BridgeError(
        "CODEX_COMPACTION_UNAVAILABLE",
        upstream.message ?? "The Codex backend does not expose Responses compaction.",
        { statusCode: response.status }
      );
    }
  }
  return new BridgeError("CODEX_UPSTREAM_ERROR", message, {
    retryable: response.status >= 500,
    statusCode: response.status >= 400 && response.status < 600 ? response.status : 502
  });
}

function safeUpstreamError(raw: string): { message?: string; code?: string } {
  if (!raw.trim()) {
    return {};
  }
  try {
    const root = record(JSON.parse(raw));
    const error = record(root?.error);
    const message = readString(error?.message) ?? readString(root?.detail) ?? readString(root?.message);
    const code = readString(error?.code) ?? readString(root?.code);
    return {
      ...(message ? { message: redactSecrets(message) } : {}),
      ...(code ? { code } : {})
    };
  } catch {
    return raw.length <= 500 ? { message: redactSecrets(raw) } : {};
  }
}

function isCompactionInputTooLarge(status: number, code: string | undefined): boolean {
  return status === 413 || code === "context_length_exceeded" || code === "input_too_large";
}

function isModelCompactionUnavailable(code: string | undefined, message: string): boolean {
  if (code === "model_not_supported" || code === "unsupported_model") {
    return true;
  }
  return /model/i.test(message) && /(not supported|unsupported|unavailable)/i.test(message);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
