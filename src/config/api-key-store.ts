import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeError } from "../errors.js";

interface StoredBridgeConfig {
  version: 1;
  apiKey: string;
  createdAt: string;
}

export interface BridgeApiKeyStoreOptions {
  bridgeHome?: string;
  now?: () => Date;
  createRandomBytes?: (size: number) => Buffer;
}

export class BridgeApiKeyStore {
  readonly bridgeHome: string;
  readonly configPath: string;
  private readonly now: () => Date;
  private readonly createRandomBytes: (size: number) => Buffer;

  constructor(options: BridgeApiKeyStoreOptions = {}) {
    this.bridgeHome = options.bridgeHome ?? path.join(os.homedir(), ".cb");
    this.configPath = path.join(this.bridgeHome, "config.json");
    this.now = options.now ?? (() => new Date());
    this.createRandomBytes = options.createRandomBytes ?? randomBytes;
  }

  async getOrCreate(): Promise<string> {
    try {
      return await this.read();
    } catch (error) {
      if (!(error instanceof BridgeError) || error.code !== "BRIDGE_API_KEY_NOT_FOUND") {
        throw error;
      }
    }

    await this.prepareDirectory();
    const config = this.createConfig();
    const temporaryPath = path.join(this.bridgeHome, `.config-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, serialize(config), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await link(temporaryPath, this.configPath);
      await chmod(this.configPath, 0o600);
      return config.apiKey;
    } catch (error) {
      if (isFileExistsError(error)) {
        return this.read();
      }
      throw new BridgeError(
        "BRIDGE_CONFIGURATION_INVALID",
        `Codex Bridge API key could not be saved to ${this.configPath}.`,
        { cause: error, statusCode: 500 }
      );
    } finally {
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  async read(): Promise<string> {
    let raw: string;
    try {
      raw = await readFile(this.configPath, "utf8");
    } catch (error) {
      if (isMissingFileError(error)) {
        throw new BridgeError(
          "BRIDGE_API_KEY_NOT_FOUND",
          `Codex Bridge API key was not found at ${this.configPath}.`,
          { statusCode: 500 }
        );
      }
      throw new BridgeError(
        "BRIDGE_API_KEY_INVALID",
        `Codex Bridge API key could not be read from ${this.configPath}.`,
        { cause: error, statusCode: 500 }
      );
    }
    return parseConfig(raw, this.configPath).apiKey;
  }

  async refresh(): Promise<string> {
    await this.prepareDirectory();
    const config = this.createConfig();
    const temporaryPath = path.join(this.bridgeHome, `.config-${process.pid}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, serialize(config), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.configPath);
      await chmod(this.configPath, 0o600);
      return config.apiKey;
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new BridgeError(
        "BRIDGE_CONFIGURATION_INVALID",
        `Codex Bridge API key could not be refreshed at ${this.configPath}.`,
        { cause: error, statusCode: 500 }
      );
    }
  }

  private async prepareDirectory(): Promise<void> {
    try {
      await mkdir(this.bridgeHome, { recursive: true, mode: 0o700 });
      await chmod(this.bridgeHome, 0o700);
    } catch (error) {
      throw new BridgeError(
        "BRIDGE_CONFIGURATION_INVALID",
        `Codex Bridge home could not be prepared at ${this.bridgeHome}.`,
        { cause: error, statusCode: 500 }
      );
    }
  }

  private createConfig(): StoredBridgeConfig {
    return {
      version: 1,
      apiKey: `cb_${this.createRandomBytes(32).toString("base64url")}`,
      createdAt: this.now().toISOString()
    };
  }
}

function parseConfig(raw: string, source: string): StoredBridgeConfig {
  try {
    const value: unknown = JSON.parse(raw);
    if (
      isRecord(value) &&
      value.version === 1 &&
      typeof value.apiKey === "string" &&
      /^cb_[A-Za-z0-9_-]{43}$/.test(value.apiKey) &&
      typeof value.createdAt === "string" &&
      !Number.isNaN(Date.parse(value.createdAt))
    ) {
      return { version: 1, apiKey: value.apiKey, createdAt: value.createdAt };
    }
  } catch (error) {
    throw invalidConfig(source, error);
  }
  throw invalidConfig(source);
}

function serialize(config: StoredBridgeConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

function invalidConfig(source: string, cause?: unknown): BridgeError {
  return new BridgeError(
    "BRIDGE_API_KEY_INVALID",
    `Codex Bridge configuration at ${source} is invalid. Run \`codex-bridge key refresh\` to replace it.`,
    { ...(cause === undefined ? {} : { cause }), statusCode: 500 }
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}
