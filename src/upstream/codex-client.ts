import { BridgeError, redactSecrets } from "../errors.js";
import type { CodexCredential } from "../auth/credential-status.js";
import { CodexCredentialReader } from "../auth/credential-reader.js";
import type { CodexResponsesRequest } from "../protocol/types.js";

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
    return this.withCredentialReload((credential) =>
      this.request("responses", credential, {
        method: "POST",
        body: JSON.stringify(request),
        ...(signal ? { signal } : {})
      })
    );
  }

  private async withCredentialReload(
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
      throw await responseError(response);
    }
    return response;
  }

  private async request(
    path: string,
    credential: CodexCredential,
    init: { method: "GET" | "POST"; body?: string; signal?: AbortSignal }
  ): Promise<Response> {
    const headers = new Headers({
      authorization: `Bearer ${credential.accessToken}`,
      "chatgpt-account-id": credential.accountId,
      originator: "codex_cli_rs",
      "user-agent": `codex_cli_rs/${this.clientVersion} (codex-bridge)`,
      accept: init.method === "POST" ? "text/event-stream" : "application/json"
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

async function responseError(response: Response): Promise<BridgeError> {
  const raw = await response.text().catch(() => "");
  const message = safeUpstreamMessage(raw) ?? `Codex backend returned HTTP ${response.status}.`;
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
  return new BridgeError("CODEX_UPSTREAM_ERROR", message, {
    retryable: response.status >= 500,
    statusCode: response.status >= 400 && response.status < 600 ? response.status : 502
  });
}

function safeUpstreamMessage(raw: string): string | undefined {
  if (!raw.trim()) {
    return undefined;
  }
  try {
    const root = record(JSON.parse(raw));
    const error = record(root?.error);
    const message = readString(error?.message) ?? readString(root?.detail) ?? readString(root?.message);
    return message ? redactSecrets(message) : undefined;
  } catch {
    return raw.length <= 500 ? redactSecrets(raw) : undefined;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
