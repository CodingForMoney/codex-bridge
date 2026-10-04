export type BridgeErrorCode =
  | "CODEX_AUTH_NOT_FOUND"
  | "CODEX_AUTH_INVALID"
  | "CODEX_AUTH_EXPIRED"
  | "CODEX_AUTH_UNAUTHORIZED"
  | "CODEX_AUTH_STORAGE_UNSUPPORTED"
  | "CODEX_MODEL_UNAVAILABLE"
  | "CODEX_COMPACTION_UNAVAILABLE"
  | "CODEX_MODEL_COMPACTION_UNAVAILABLE"
  | "CODEX_COMPACTION_INPUT_TOO_LARGE"
  | "CODEX_UPSTREAM_UNREACHABLE"
  | "CODEX_UPSTREAM_RATE_LIMITED"
  | "CODEX_UPSTREAM_ERROR"
  | "PROTOCOL_REQUEST_INVALID"
  | "PROTOCOL_REQUEST_UNSUPPORTED"
  | "PROTOCOL_RESPONSE_INVALID"
  | "BRIDGE_UNAUTHORIZED"
  | "BRIDGE_NOT_FOUND"
  | "BRIDGE_METHOD_NOT_ALLOWED"
  | "BRIDGE_BODY_TOO_LARGE"
  | "BRIDGE_API_KEY_NOT_FOUND"
  | "BRIDGE_API_KEY_INVALID"
  | "BRIDGE_CONFIGURATION_INVALID";

export interface BridgeErrorOptions {
  cause?: unknown;
  retryable?: boolean;
  statusCode?: number;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(code: BridgeErrorCode, message: string, options: BridgeErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BridgeError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.statusCode = options.statusCode ?? 500;
  }
}

export function asBridgeError(error: unknown): BridgeError {
  if (error instanceof BridgeError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new BridgeError("CODEX_UPSTREAM_ERROR", message, { cause: error });
}

const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT", "EPIPE",
  "EAI_AGAIN", "ENETUNREACH", "EHOSTUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET"
]);

export function upstreamTransportError(error: unknown, message: string): BridgeError {
  return new BridgeError("CODEX_UPSTREAM_UNREACHABLE", message, {
    cause: error,
    retryable: isTransientNetworkError(error),
    statusCode: 502
  });
}

function isTransientNetworkError(error: unknown): boolean {
  const chain = errorChain(error);
  if (chain.some((entry) => entry.name === "AbortError")) return false;
  const codes = chain.map((entry) => entry.code).filter((code): code is string => typeof code === "string");
  if (codes.some((code) =>
    code === "ENOTFOUND" || code === "CERT_HAS_EXPIRED" ||
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
    code.startsWith("ERR_TLS_") || code.startsWith("ERR_SSL_")
  )) return false;
  return codes.some((code) => TRANSIENT_NETWORK_CODES.has(code));
}

export function formatErrorMessage(error: BridgeError): string {
  const causes = errorChain(error).slice(1).map((entry) => {
    const name = typeof entry.name === "string" ? redactSecrets(entry.name).slice(0, 80) : "Error";
    const message = typeof entry.message === "string" ? redactSecrets(entry.message).slice(0, 512) : "";
    const fields = ["code", "syscall", "hostname", "address", "port"].flatMap((key) => {
      const value = entry[key];
      return typeof value === "string" || typeof value === "number" ? [`${key}=${redactSecrets(String(value)).slice(0, 128)}`] : [];
    });
    return `${name}: ${message}${fields.length ? ` (${fields.join(", ")})` : ""}`;
  });
  return redactSecrets(`${error.message}${causes.length ? ` Caused by: ${causes.join(" -> ")}` : ""}`);
}

function errorChain(error: unknown): Array<Record<string, unknown>> {
  const pending = [error];
  const seen = new Set<object>();
  const chain: Array<Record<string, unknown>> = [];
  while (pending.length && chain.length < 8) {
    const value = pending.shift();
    if (typeof value !== "object" || value === null || seen.has(value)) continue;
    seen.add(value);
    const entry = value as Record<string, unknown>;
    chain.push(entry);
    if (entry.cause !== undefined) pending.push(entry.cause);
    if (Array.isArray(entry.errors)) pending.push(...entry.errors.slice(0, 8));
  }
  return chain;
}

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(access_token|refresh_token|id_token|encrypted_content|api_key|apiKey|client_secret)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1=[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|cb_[A-Za-z0-9_-]{12,})\b/g, "[REDACTED]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1[REDACTED]@");
}

export function anthropicErrorType(error: BridgeError): string {
  if (error.code === "BRIDGE_UNAUTHORIZED" || error.code.startsWith("CODEX_AUTH_")) {
    return "authentication_error";
  }
  if (error.code === "CODEX_UPSTREAM_RATE_LIMITED") {
    return "rate_limit_error";
  }
  if (
    error.code.startsWith("PROTOCOL_REQUEST_") ||
    error.code === "CODEX_MODEL_UNAVAILABLE" ||
    error.code === "CODEX_MODEL_COMPACTION_UNAVAILABLE" ||
    error.code === "CODEX_COMPACTION_INPUT_TOO_LARGE" ||
    error.code === "BRIDGE_BODY_TOO_LARGE"
  ) {
    return "invalid_request_error";
  }
  if (error.code === "BRIDGE_NOT_FOUND") {
    return "not_found_error";
  }
  if (error.code === "CODEX_COMPACTION_UNAVAILABLE") {
    return "not_found_error";
  }
  return "api_error";
}

export function toAnthropicErrorBody(error: BridgeError): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: anthropicErrorType(error),
      message: formatErrorMessage(error),
      code: error.code
    }
  };
}

export function toOpenAiErrorBody(error: BridgeError): Record<string, unknown> {
  return {
    error: {
      message: formatErrorMessage(error),
      type: anthropicErrorType(error),
      param: null,
      code: error.code
    }
  };
}
