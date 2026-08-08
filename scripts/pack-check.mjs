import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("pack:check must run through npm.");
}

const build = spawnSync(process.execPath, [fileURLToPath(new URL("./build.mjs", import.meta.url))], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit"
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

const result = spawnSync(process.execPath, [npmCli, "pack", "--dry-run"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    npm_config_cache: path.join(os.tmpdir(), "codex-bridge-npm-cache")
  },
  stdio: "inherit"
});
process.exit(result.status ?? 1);
