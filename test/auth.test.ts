import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexCredentialReader } from "../src/auth/credential-reader.js";
import { BridgeError, redactSecrets } from "../src/errors.js";
import { jwt, writeCodexAuth } from "./helpers.js";

test("reads file-backed Codex credentials without exposing tokens in status", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-auth-"));
  const token = await writeCodexAuth(home, { accountId: "workspace-42" });
  const reader = new CodexCredentialReader({ codexHome: home });

  const credential = await reader.read();
  assert.equal(credential.accessToken, token);
  assert.equal(credential.accountId, "workspace-42");
  const status = await reader.status();
  assert.equal(status.state, "ready");
  assert.equal(JSON.stringify(status).includes(token), false);
});

test("reports missing, malformed, and expired credentials precisely", async (context) => {
  await context.test("missing", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-missing-"));
    const status = await new CodexCredentialReader({ codexHome: home }).status();
    assert.equal(status.state, "not_found");
  });
  await context.test("malformed", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-malformed-"));
    await writeFile(path.join(home, "auth.json"), "not-json", "utf8");
    const status = await new CodexCredentialReader({ codexHome: home }).status();
    assert.equal(status.state, "invalid");
  });
  await context.test("expired", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-expired-"));
    await writeCodexAuth(home, { expiresAt: 1 });
    const status = await new CodexCredentialReader({ codexHome: home, now: () => new Date(2_000) }).status();
    assert.equal(status.state, "expired");
  });
});

test("detects unsupported explicit keyring storage", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-keyring-"));
  await writeFile(path.join(home, "config.toml"), 'cli_auth_credentials_store = "keyring"\n', "utf8");
  const status = await new CodexCredentialReader({ codexHome: home }).status();
  assert.equal(status.state, "unsupported_storage");
});

test("redacts bearer and OAuth token fields", () => {
  const token = jwt({ exp: 1 });
  const output = redactSecrets(`Bearer ${token} access_token=${token}`, [token]);
  assert.equal(output.includes(token), false);
  assert.match(output, /\[REDACTED\]/);
});

test("invalid JWT fails with a stable bridge error", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "codex-bridge-badjwt-"));
  await writeFile(path.join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "bad" } }), "utf8");
  await assert.rejects(
    () => new CodexCredentialReader({ codexHome: home }).read(),
    (error: unknown) => error instanceof BridgeError && error.code === "CODEX_AUTH_INVALID"
  );
});
