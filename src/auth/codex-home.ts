import os from "node:os";
import path from "node:path";

export function resolveCodexHome(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = os.homedir()
): string {
  const configured = env.CODEX_HOME?.trim();
  return configured ? path.resolve(configured) : path.join(homeDirectory, ".codex");
}

export function codexAuthPath(codexHome: string): string {
  return path.join(codexHome, "auth.json");
}

export function codexConfigPath(codexHome: string): string {
  return path.join(codexHome, "config.toml");
}
