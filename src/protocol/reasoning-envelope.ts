const PREFIX = "codex-bridge-reasoning-v1:";

export interface ReasoningEnvelope {
  id: string;
  encryptedContent: string;
}

export function encodeReasoningEnvelope(id: string, encryptedContent: string): string {
  const normalizedId = id.trim();
  if (!normalizedId || !encryptedContent) {
    return encryptedContent;
  }
  const payload = Buffer.from(
    JSON.stringify({ id: normalizedId, encrypted_content: encryptedContent }),
    "utf8"
  ).toString("base64url");
  return `${PREFIX}${payload}`;
}

export function decodeReasoningEnvelope(value: string): ReasoningEnvelope | undefined {
  if (!value.startsWith(PREFIX)) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value.slice(PREFIX.length), "base64url").toString("utf8")
    );
    if (!isRecord(parsed)) {
      return undefined;
    }
    const id = readString(parsed.id);
    const encryptedContent = readString(parsed.encrypted_content);
    return id && encryptedContent ? { id, encryptedContent } : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}
