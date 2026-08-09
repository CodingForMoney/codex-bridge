import { BridgeError } from "../errors.js";
import { resolveSupportedModel } from "../models.js";

export interface BridgeConfig {
  host: string;
  port: number;
  apiKey: string;
  codexHome?: string;
  codexBaseUrl: string;
  codexClientVersion: string;
  modelOverride?: string;
  defaultEffort: string;
  bodyLimitBytes: number;
  logLevel: "silent" | "error" | "info";
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, apiKey = ""): BridgeConfig {
  if (!apiKey) {
    throw new BridgeError(
      "BRIDGE_CONFIGURATION_INVALID",
      "Codex Bridge API key was not supplied by the local key store.",
      { statusCode: 500 }
    );
  }
  const port = integer(env.CODEX_BRIDGE_PORT, 3456, 1, 65535, "CODEX_BRIDGE_PORT");
  const bodyLimitBytes = integer(
    env.CODEX_BRIDGE_BODY_LIMIT_BYTES,
    32 * 1024 * 1024,
    1024,
    256 * 1024 * 1024,
    "CODEX_BRIDGE_BODY_LIMIT_BYTES"
  );
  const logLevel = env.CODEX_BRIDGE_LOG_LEVEL?.trim() || "info";
  if (logLevel !== "silent" && logLevel !== "error" && logLevel !== "info") {
    throw new BridgeError(
      "BRIDGE_CONFIGURATION_INVALID",
      "CODEX_BRIDGE_LOG_LEVEL must be silent, error, or info.",
      { statusCode: 500 }
    );
  }
  const modelOverride = env.CODEX_BRIDGE_MODEL?.trim();
  return {
    host: env.CODEX_BRIDGE_HOST?.trim() || "127.0.0.1",
    port,
    apiKey,
    ...(env.CODEX_HOME?.trim() ? { codexHome: env.CODEX_HOME.trim() } : {}),
    codexBaseUrl: (env.CODEX_BRIDGE_CODEX_BASE_URL?.trim() || "https://chatgpt.com/backend-api/codex").replace(/\/$/, ""),
    codexClientVersion: env.CODEX_BRIDGE_CODEX_CLIENT_VERSION?.trim() || "0.139.0",
    ...(modelOverride ? { modelOverride: resolveSupportedModel({ model: modelOverride }) } : {}),
    defaultEffort: env.CODEX_BRIDGE_DEFAULT_EFFORT?.trim() || "medium",
    bodyLimitBytes,
    logLevel
  };
}

function integer(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new BridgeError(
      "BRIDGE_CONFIGURATION_INVALID",
      `${name} must be an integer from ${minimum} to ${maximum}.`,
      { statusCode: 500 }
    );
  }
  return value;
}
