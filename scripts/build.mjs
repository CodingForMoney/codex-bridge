import { chmod, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

await rm(new URL("../dist", import.meta.url), { force: true, recursive: true });

const tsc = new URL("../node_modules/typescript/bin/tsc", import.meta.url);
const result = spawnSync(process.execPath, [fileURLToPath(tsc), "-p", "tsconfig.build.json"], {
  cwd: new URL("..", import.meta.url),
  stdio: "inherit"
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

await chmod(new URL("../dist/src/cli/index.js", import.meta.url), 0o755);
