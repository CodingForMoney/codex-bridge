# Codex Bridge

Codex Bridge is a focused local Anthropic-compatible API bridge for an existing
Codex login. It lets clients such as Claude Code send supported Messages API
requests to Codex-backed models without changing Claude Code settings or
copying Codex OAuth credentials into another tool.

Codex Bridge is intentionally not a provider router. It does not launch Claude
Code, edit `~/.claude`, refresh OAuth tokens, or manage multiple providers.

> The ChatGPT-authenticated Codex backend is not a documented stable
> third-party API. Codex Bridge isolates that integration, but upstream changes
> can still require a bridge update.

## Requirements

- Node.js 20 or newer
- Codex installed and signed in
- file-backed Codex credentials at `$CODEX_HOME/auth.json` or `~/.codex/auth.json`

If Codex stores credentials only in an OS keyring, the first release reports
`CODEX_AUTH_STORAGE_UNSUPPORTED` rather than copying or exporting them.

## Start The Bridge

```bash
npm install --global @codingformoney/codex-bridge
export CODEX_BRIDGE_API_KEY="choose-a-local-client-token"
codex-bridge serve
```

The server listens on `http://127.0.0.1:3456` by default.

Use a temporary process-scoped Claude Code configuration when selecting the
bridge. This leaves normal Claude Code sessions unchanged:

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:3456" \
ANTHROPIC_AUTH_TOKEN="$CODEX_BRIDGE_API_KEY" \
claude --model gpt-5.5
```

The model must be available to the active Codex account. Run
`codex-bridge doctor` or query `/v1/models` to inspect the current catalog.

## CLI

```text
codex-bridge serve [--host HOST] [--port PORT]
codex-bridge status [--host HOST] [--port PORT]
codex-bridge doctor
codex-bridge --version
codex-bridge --help
```

- `serve` starts the local API.
- `status` reports server reachability and redacted credential state.
- `doctor` validates credentials and model discovery without sending a model
  inference request.

There are no `login`, `refresh`, or `logout` commands. Open Codex and make a
request, or run `codex login`, when the bridge reports expired or unauthorized
credentials.

## API

The bridge exposes:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /auth/status`
- `GET /health`

All endpoints except `/health` require either:

```text
x-api-key: <CODEX_BRIDGE_API_KEY>
```

or:

```text
Authorization: Bearer <CODEX_BRIDGE_API_KEY>
```

Messages support text, image inputs, tools, tool results, streaming, reasoning
effort, usage, and Codex encrypted reasoning continuity. Unsupported required
content returns an explicit compatibility error.

`/v1/messages/count_tokens` is a conservative compatibility estimate. The
private Codex backend exposes no tokenizer endpoint, so it must not be used for
billing or exact context-window accounting.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BRIDGE_API_KEY` | required | Bridge-specific local client token |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `CODEX_BRIDGE_PORT` | `3456` | Bind port |
| `CODEX_HOME` | `~/.codex` | Existing Codex home |
| `CODEX_BRIDGE_MODEL` | request model | Force one upstream model |
| `CODEX_BRIDGE_DEFAULT_EFFORT` | `medium` | Default reasoning effort |
| `CODEX_BRIDGE_BODY_LIMIT_BYTES` | `33554432` | Maximum JSON request size |
| `CODEX_BRIDGE_LOG_LEVEL` | `info` | `silent`, `error`, or `info` |
| `CODEX_BRIDGE_CODEX_BASE_URL` | ChatGPT Codex backend | Adapter test/override URL |
| `CODEX_BRIDGE_CODEX_CLIENT_VERSION` | `0.139.0` | Codex model-catalog compatibility version |

Binding outside loopback exposes the bridge to other hosts that can reach the
port. Use a strong client token and a trusted network. A containerized client
can usually reach a host bridge through `host.docker.internal` after the bridge
is explicitly bound to a reachable host address.

## Credential Behavior

Codex Bridge reads a fresh credential snapshot for every upstream request. It
never writes `auth.json` and never uses the refresh token.

If an upstream request returns HTTP 401, the bridge reads the credential file
again. It retries exactly once only when Codex has replaced the access token.
If the token is unchanged, the bridge returns an actionable authentication
error instead of attempting OAuth refresh itself.

Credential values are excluded from health output, status output, errors, and
logs.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
npm run pack:check
```

Automated tests use synthetic JWTs and mocked Codex responses. Real Codex
credentials are never required by the test suite.

The original design and security decisions are recorded in
[`docs/implementation-plan.md`](docs/implementation-plan.md).
