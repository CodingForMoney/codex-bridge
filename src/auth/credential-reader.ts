import { readFile } from "node:fs/promises";
import { BridgeError } from "../errors.js";
import { codexAuthPath, codexConfigPath, resolveCodexHome } from "./codex-home.js";
import type { CodexCredential, PublicCredentialStatus } from "./credential-status.js";

interface CredentialReaderOptions {
  codexHome?: string;
  now?: () => Date;
  readTextFile?: (path: string) => Promise<string>;
}

interface JwtClaims {
  exp?: number;
  [key: string]: unknown;
}

export class CodexCredentialReader {
  readonly codexHome: string;
  readonly sourcePath: string;
  private readonly now: () => Date;
  private readonly readTextFile: (path: string) => Promise<string>;

  constructor(options: CredentialReaderOptions = {}) {
    this.codexHome = options.codexHome ?? resolveCodexHome();
    this.sourcePath = codexAuthPath(this.codexHome);
    this.now = options.now ?? (() => new Date());
    this.readTextFile = options.readTextFile ?? ((file) => readFile(file, "utf8"));
  }

  async read(): Promise<CodexCredential> {
    let raw: string;
    try {
      raw = await this.readTextFile(this.sourcePath);
    } catch (error) {
      if (isMissingFileError(error)) {
        if (await this.usesUnsupportedStorage()) {
          throw new BridgeError(
            "CODEX_AUTH_STORAGE_UNSUPPORTED",
            "Codex uses keyring credential storage. Codex Bridge currently supports file-backed Codex credentials only.",
            { statusCode: 503 }
          );
        }
        throw new BridgeError(
          "CODEX_AUTH_NOT_FOUND",
          `Codex credentials were not found at ${this.sourcePath}. Run \`codex login\` and retry.`,
          { statusCode: 503 }
        );
      }
      throw new BridgeError(
        "CODEX_AUTH_INVALID",
        `Codex credentials could not be read from ${this.sourcePath}.`,
        { cause: error, statusCode: 503 }
      );
    }

    const root = parseRecord(raw, this.sourcePath);
    const tokens = isRecord(root.tokens) ? root.tokens : undefined;
    const accessToken = readString(tokens?.access_token) ?? readString(tokens?.accessToken);
    if (!accessToken) {
      throw new BridgeError(
        "CODEX_AUTH_INVALID",
        `Codex credentials at ${this.sourcePath} do not contain an access token. Run \`codex login\` and retry.`,
        { statusCode: 503 }
      );
    }

    const accessClaims = parseJwtClaims(accessToken, "Codex access token");
    const expiresAt = expirationFromClaims(accessClaims);
    if (expiresAt.getTime() <= this.now().getTime()) {
      throw new BridgeError(
        "CODEX_AUTH_EXPIRED",
        "Codex credentials have expired. Open Codex and make a request to refresh the login, or run `codex login`, then retry.",
        { statusCode: 401 }
      );
    }

    const idToken = readString(tokens?.id_token) ?? readString(tokens?.idToken);
    const idClaims = idToken ? parseJwtClaims(idToken, "Codex ID token") : undefined;
    const accountId =
      readString(tokens?.account_id) ??
      readString(tokens?.accountId) ??
      accountIdFromClaims(idClaims) ??
      accountIdFromClaims(accessClaims);
    if (!accountId) {
      throw new BridgeError(
        "CODEX_AUTH_INVALID",
        `Codex credentials at ${this.sourcePath} do not contain a ChatGPT account identifier.`,
        { statusCode: 503 }
      );
    }

    return {
      accessToken,
      accountId,
      expiresAt,
      isFedramp: fedrampFromClaims(idClaims) ?? fedrampFromClaims(accessClaims) ?? false,
      source: this.sourcePath
    };
  }

  async status(): Promise<PublicCredentialStatus> {
    try {
      const credential = await this.read();
      return {
        state: "ready",
        source: credential.source,
        expiresAt: credential.expiresAt.toISOString(),
        accountIdPresent: true
      };
    } catch (error) {
      if (!(error instanceof BridgeError)) {
        throw error;
      }
      return {
        state: statusStateForCode(error.code),
        source: this.sourcePath,
        message: error.message
      };
    }
  }

  private async usesUnsupportedStorage(): Promise<boolean> {
    try {
      const config = await this.readTextFile(codexConfigPath(this.codexHome));
      return /^\s*cli_auth_credentials_store\s*=\s*["']keyring["']\s*(?:#.*)?$/m.test(config);
    } catch {
      return false;
    }
  }
}

function parseRecord(raw: string, source: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new BridgeError("CODEX_AUTH_INVALID", `Codex credentials at ${source} are not valid JSON.`, {
      cause: error,
      statusCode: 503
    });
  }
  throw new BridgeError("CODEX_AUTH_INVALID", `Codex credentials at ${source} must be a JSON object.`, {
    statusCode: 503
  });
}

function parseJwtClaims(token: string, label: string): JwtClaims {
  const payload = token.split(".")[1];
  if (!payload) {
    throw new BridgeError("CODEX_AUTH_INVALID", `${label} is not a valid JWT.`, { statusCode: 503 });
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (isRecord(parsed)) {
      return parsed;
    }
  } catch (error) {
    throw new BridgeError("CODEX_AUTH_INVALID", `${label} contains an invalid JWT payload.`, {
      cause: error,
      statusCode: 503
    });
  }
  throw new BridgeError("CODEX_AUTH_INVALID", `${label} contains an invalid JWT payload.`, {
    statusCode: 503
  });
}

function expirationFromClaims(claims: JwtClaims): Date {
  if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) {
    throw new BridgeError("CODEX_AUTH_INVALID", "Codex access token does not contain a valid expiration time.", {
      statusCode: 503
    });
  }
  return new Date(claims.exp * 1000);
}

function accountIdFromClaims(claims: JwtClaims | undefined): string | undefined {
  if (!claims) {
    return undefined;
  }
  const auth = claims["https://api.openai.com/auth"];
  if (!isRecord(auth)) {
    return undefined;
  }
  return readString(auth.chatgpt_account_id) ?? readString(auth.account_id) ?? readString(auth.accountId);
}

function fedrampFromClaims(claims: JwtClaims | undefined): boolean | undefined {
  if (!claims) {
    return undefined;
  }
  const auth = claims["https://api.openai.com/auth"];
  return isRecord(auth) && typeof auth.chatgpt_account_is_fedramp === "boolean"
    ? auth.chatgpt_account_is_fedramp
    : undefined;
}

function statusStateForCode(code: string): PublicCredentialStatus["state"] {
  switch (code) {
    case "CODEX_AUTH_NOT_FOUND":
      return "not_found";
    case "CODEX_AUTH_EXPIRED":
      return "expired";
    case "CODEX_AUTH_UNAUTHORIZED":
      return "unauthorized";
    case "CODEX_AUTH_STORAGE_UNSUPPORTED":
      return "unsupported_storage";
    default:
      return "invalid";
  }
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
