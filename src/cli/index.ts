#!/usr/bin/env node
import { CodexCredentialReader } from "../auth/credential-reader.js";
import { loadConfig } from "../config/config.js";
import { asBridgeError, redactSecrets } from "../errors.js";
import { startBridgeServer } from "../server/app.js";
import { CodexClient } from "../upstream/codex-client.js";
import { VERSION } from "../version.js";

const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("-") ? args[0] : "serve";

try {
  if (args.includes("--help") || args.includes("-h") || command === "help") {
    printHelp();
  } else if (args.includes("--version") || args.includes("-V") || command === "version") {
    console.log(VERSION);
  } else if (command === "serve") {
    await serve();
  } else if (command === "status") {
    await status();
  } else if (command === "doctor") {
    await doctor();
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  const bridgeError = asBridgeError(error);
  console.error(`${bridgeError.code}: ${redactSecrets(bridgeError.message)}`);
  process.exitCode = 1;
}

async function serve(): Promise<void> {
  const config = loadConfig(withCliOverrides(process.env, args));
  const running = await startBridgeServer({ config });
  if (config.logLevel === "info") {
    console.log(`Codex Bridge ${VERSION} is running at ${running.url}`);
  }
  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
}

async function status(): Promise<void> {
  const config = loadConfig(withCliOverrides(process.env, args));
  const base = `http://${config.host}:${config.port}`;
  let server: "reachable" | "unreachable" = "unreachable";
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(2_000) });
    server = response.ok ? "reachable" : "unreachable";
  } catch {
    // Redacted status remains useful when the server is stopped.
  }
  const credentialReader = new CodexCredentialReader({
    ...(config.codexHome ? { codexHome: config.codexHome } : {})
  });
  console.log(JSON.stringify({ server, url: base, auth: await credentialReader.status() }, null, 2));
}

async function doctor(): Promise<void> {
  const config = loadConfig(withCliOverrides(process.env, args));
  const credentialReader = new CodexCredentialReader({
    ...(config.codexHome ? { codexHome: config.codexHome } : {})
  });
  const client = new CodexClient({
    credentialReader,
    baseUrl: config.codexBaseUrl,
    clientVersion: config.codexClientVersion
  });
  const auth = await credentialReader.status();
  if (auth.state !== "ready") {
    console.log(JSON.stringify({ ok: false, node: process.version, auth }, null, 2));
    process.exitCode = 1;
    return;
  }
  const models = await client.listModels(AbortSignal.timeout(10_000));
  console.log(JSON.stringify({ ok: true, node: process.version, auth, models: models.map((model) => model.id) }, null, 2));
}

function withCliOverrides(env: NodeJS.ProcessEnv, values: string[]): NodeJS.ProcessEnv {
  const output = { ...env };
  const host = option(values, "--host");
  const port = option(values, "--port");
  if (host) {
    output.CODEX_BRIDGE_HOST = host;
  }
  if (port) {
    output.CODEX_BRIDGE_PORT = port;
  }
  return output;
}

function option(values: string[], name: string): string | undefined {
  const direct = values.find((value) => value.startsWith(`${name}=`));
  if (direct) {
    return direct.slice(name.length + 1);
  }
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function printHelp(): void {
  console.log(`Codex Bridge ${VERSION}

Usage:
  codex-bridge serve [--host HOST] [--port PORT]
  codex-bridge status [--host HOST] [--port PORT]
  codex-bridge doctor
  codex-bridge --version

Required environment:
  CODEX_BRIDGE_API_KEY       Local client token accepted by the bridge

Optional environment:
  CODEX_BRIDGE_HOST          Bind host (default: 127.0.0.1)
  CODEX_BRIDGE_PORT          Bind port (default: 3456)
  CODEX_HOME                 Existing Codex home (default: ~/.codex)
  CODEX_BRIDGE_MODEL         Force one upstream Codex model
  CODEX_BRIDGE_DEFAULT_EFFORT  Default reasoning effort (default: medium)
  CODEX_BRIDGE_CODEX_CLIENT_VERSION  Codex catalog compatibility version

Codex Bridge never logs in, refreshes OAuth tokens, or changes Claude Code settings.`);
}
