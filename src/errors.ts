export type BridgeErrorCode =
  | "CODEX_AUTH_NOT_FOUND"
  | "CODEX_AUTH_INVALID"
  | "CODEX_AUTH_EXPIRED"
  | "CODEX_AUTH_UNAUTHORIZED"
  | "CODEX_AUTH_STORAGE_UNSUPPORTED"
  | "CODEX_MODEL_UNAVAILABLE"
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

export function redactSecrets(value: string, secrets: readonly string[] = []): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret.length > 0) {
      redacted = redacted.split(secret).join("[REDACTED]");
    }
  }
  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(access|refresh|id)_token\b\s*[:=]\s*["']?[^\s,"'}]+/gi, "$1_token=[REDACTED]");
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
    error.code === "BRIDGE_BODY_TOO_LARGE"
  ) {
    return "invalid_request_error";
  }
  if (error.code === "BRIDGE_NOT_FOUND") {
    return "not_found_error";
  }
  return "api_error";
}

export function toAnthropicErrorBody(error: BridgeError): Record<string, unknown> {
  return {
    type: "error",
    error: {
      type: anthropicErrorType(error),
      message: redactSecrets(error.message),
      code: error.code
    }
  };
}

export function toOpenAiErrorBody(error: BridgeError): Record<string, unknown> {
  return {
    error: {
      message: redactSecrets(error.message),
      type: anthropicErrorType(error),
      param: null,
      code: error.code
    }
  };
}
