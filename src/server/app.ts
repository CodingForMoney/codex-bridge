import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";
import { asBridgeError, BridgeError, toAnthropicErrorBody } from "../errors.js";
import { CodexCredentialReader } from "../auth/credential-reader.js";
import type { BridgeConfig } from "../config/config.js";
import { convertAnthropicRequest } from "../protocol/anthropic-request.js";
import { collectCodexResponse } from "../protocol/anthropic-response.js";
import { streamCodexAsAnthropic } from "../protocol/anthropic-stream.js";
import { estimateAnthropicInputTokens } from "../protocol/token-count.js";
import { resolveSupportedModel, SUPPORTED_MODELS } from "../models.js";
import { CodexClient } from "../upstream/codex-client.js";

export interface CodexClientLike {
  createResponse(request: Parameters<CodexClient["createResponse"]>[0], signal?: AbortSignal): Promise<Response>;
}

export interface BridgeApiKeyProvider {
  read(): Promise<string>;
}

export interface BridgeServerOptions {
  config: BridgeConfig;
  credentialReader?: CodexCredentialReader;
  codexClient?: CodexClientLike;
  apiKeyProvider?: BridgeApiKeyProvider;
}

export interface RunningBridgeServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startBridgeServer(options: BridgeServerOptions): Promise<RunningBridgeServer> {
  const credentialReader = options.credentialReader ?? new CodexCredentialReader({
    ...(options.config.codexHome ? { codexHome: options.config.codexHome } : {})
  });
  const codexClient = options.codexClient ?? new CodexClient({
    credentialReader,
    baseUrl: options.config.codexBaseUrl,
    clientVersion: options.config.codexClientVersion
  });
  const apiKeyProvider = options.apiKeyProvider ?? {
    read: async () => options.config.apiKey
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response, options.config, credentialReader, codexClient, apiKeyProvider);
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.listen(options.config.port, options.config.host);
  await once(server, "listening");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.config.port;
  return {
    server,
    url: `http://${displayHost(options.config.host)}:${port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: BridgeConfig,
  credentialReader: CodexCredentialReader,
  codexClient: CodexClientLike,
  apiKeyProvider: BridgeApiKeyProvider
): Promise<void> {
  const controller = new AbortController();
  request.once("aborted", () => controller.abort());
  response.once("error", () => controller.abort());
  response.once("close", () => {
    if (!response.writableEnded) {
      controller.abort();
    }
  });
  try {
    const url = new URL(request.url ?? "/", "http://codex-bridge.local");
    if (request.method === "GET" && url.pathname === "/health") {
      json(response, 200, { status: "ok", service: "codex-bridge" });
      return;
    }
    authenticate(request, await apiKeyProvider.read());

    if (request.method === "GET" && url.pathname === "/auth/status") {
      json(response, 200, await credentialReader.status());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/models") {
      json(response, 200, {
        object: "list",
        data: SUPPORTED_MODELS.map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "openai",
          ...(model.displayName ? { display_name: model.displayName } : {})
        }))
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
      const body = await readJson(request, config.bodyLimitBytes);
      resolveSupportedModel(body, config.modelOverride);
      json(response, 200, estimateAnthropicInputTokens(body));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/messages") {
      const body = await readJson(request, config.bodyLimitBytes);
      const converted = convertAnthropicRequest(body, {
        defaultEffort: config.defaultEffort,
        ...(config.modelOverride ? { modelOverride: config.modelOverride } : {})
      });
      const upstream = await codexClient.createResponse(converted.responses, controller.signal);
      if (converted.anthropic.stream) {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no"
        });
        try {
          for await (const event of streamCodexAsAnthropic(
            upstream.body,
            converted.requestedModel,
            controller.signal
          )) {
            if (!responseWritable(response, controller.signal)) {
              return;
            }
            if (!response.write(event) && !(await waitForDrain(response, controller.signal))) {
              return;
            }
          }
        } finally {
          if (controller.signal.aborted) {
            await upstream.body?.cancel().catch(() => undefined);
          }
        }
        if (responseWritable(response, controller.signal)) {
          response.end();
        }
      } else {
        const message = await collectCodexResponse(upstream.body, converted.requestedModel);
        json(response, 200, message);
      }
      return;
    }

    if (["/auth/status", "/v1/models", "/v1/messages", "/v1/messages/count_tokens"].includes(url.pathname)) {
      throw new BridgeError("BRIDGE_METHOD_NOT_ALLOWED", `Method ${request.method ?? "unknown"} is not allowed for ${url.pathname}.`, {
        statusCode: 405
      });
    }
    throw new BridgeError("BRIDGE_NOT_FOUND", `Endpoint ${url.pathname} was not found.`, { statusCode: 404 });
  } catch (error) {
    if (controller.signal.aborted || response.destroyed) {
      return;
    }
    const bridgeError = asBridgeError(error);
    if (!response.headersSent) {
      json(response, bridgeError.statusCode, toAnthropicErrorBody(bridgeError));
    } else {
      response.end();
    }
  }
}

function responseWritable(response: ServerResponse, signal: AbortSignal): boolean {
  return !signal.aborted && !response.destroyed && !response.writableEnded;
}

async function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<boolean> {
  if (!responseWritable(response, signal)) {
    return false;
  }
  try {
    await once(response, "drain", { signal });
    return responseWritable(response, signal);
  } catch (error) {
    if (!responseWritable(response, signal)) {
      return false;
    }
    throw error;
  }
}

function authenticate(request: IncomingMessage, expected: string): void {
  const direct = header(request, "x-api-key");
  const authorization = header(request, "authorization");
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (direct !== expected && bearer !== expected) {
    throw new BridgeError("BRIDGE_UNAUTHORIZED", "The Codex Bridge client token is missing or invalid.", {
      statusCode: 401
    });
  }
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) {
      throw new BridgeError("BRIDGE_BODY_TOO_LARGE", `Request body exceeds the ${limit}-byte limit.`, {
        statusCode: 413
      });
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    throw new BridgeError("PROTOCOL_REQUEST_INVALID", "Request body must be valid JSON.", {
      cause: error,
      statusCode: 400
    });
  }
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store"
  });
  response.end(body);
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function displayHost(host: string): string {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}
