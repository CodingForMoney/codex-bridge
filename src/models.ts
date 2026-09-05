import { BridgeError } from "./errors.js";

export const SUPPORTED_MODELS = [
  { id: "gpt-6-astra", displayName: "GPT-6 Astra" },
  { id: "gpt-5.6-sol", displayName: "GPT-5.6 Sol" },
  { id: "gpt-5.6-luna", displayName: "GPT-5.6 Luna" }
] as const;

const SUPPORTED_MODEL_IDS = new Set<string>(SUPPORTED_MODELS.map((model) => model.id));

export function resolveSupportedModel(value: unknown, override?: string): string {
  const requested = override?.trim() || requestModel(value);
  if (!requested) {
    throw new BridgeError("PROTOCOL_REQUEST_INVALID", "Request requires a model.", {
      statusCode: 400
    });
  }
  if (!SUPPORTED_MODEL_IDS.has(requested)) {
    throw new BridgeError(
      "CODEX_MODEL_UNAVAILABLE",
      `Unsupported model ${requested}. Codex Bridge supports only ${SUPPORTED_MODELS.map((model) => model.id).join(" and ")}.`,
      { statusCode: 400 }
    );
  }
  return requested;
}

function requestModel(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const model = (value as Record<string, unknown>).model;
  return typeof model === "string" ? model.trim() : undefined;
}
