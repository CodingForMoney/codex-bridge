# Codex Bridge

Codex Bridge is a focused local Anthropic Messages and OpenAI Responses API
bridge for an existing Codex login. It lets clients send supported requests to
Codex-backed models without changing Claude Code settings or copying Codex
OAuth credentials into another tool.

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
npm install --global codex-anthropic-bridge
codex-bridge serve
```

On first use, Codex Bridge generates a local API key and saves it to
`~/.cb/config.json`. Every `serve` startup prints the current key so it can be
copied into the client. The server listens on `http://127.0.0.1:3456` by
default.

Use a temporary process-scoped Claude Code configuration when selecting the
bridge. This leaves normal Claude Code sessions unchanged:

```bash
export CB_API_KEY="copy-the-key-printed-by-codex-bridge"
ANTHROPIC_BASE_URL="http://127.0.0.1:3456" \
ANTHROPIC_AUTH_TOKEN="$CB_API_KEY" \
claude --model gpt-6.1-sol
```

OpenAI Responses clients can use the same server and key:

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.CB_API_KEY,
  baseURL: "http://127.0.0.1:3456/v1"
});

const response = await client.responses.create({
  model: "gpt-6.1-sol",
  input: "Hello"
});
```

## Supported Models

Codex Bridge supports exactly:

| Model | Maximum context window | Effective context window |
| --- | ---: | ---: |
| `gpt-6-astra` | 272,000 tokens | approximately 258,400 tokens |
| `gpt-6.1-sol` | 272,000 tokens | approximately 258,400 tokens |
| `gpt-6-luna` | 272,000 tokens | approximately 258,400 tokens |

The effective window is 95% of the maximum window according to the current
Codex model metadata. These limits are controlled by the upstream model and may
change when Codex updates its model catalog; Codex Bridge does not override or
independently enforce them.

`GET /v1/models` returns this fixed list. Requests for any other model fail
with `CODEX_MODEL_UNAVAILABLE` before an upstream request is sent.

## CLI

```text
codex-bridge serve [--host HOST] [--port PORT]
codex-bridge status [--host HOST] [--port PORT]
codex-bridge doctor
codex-bridge key refresh
codex-bridge --version
codex-bridge --help
```

- `serve` starts the local API.
- `status` reports server reachability and redacted credential state.
- `doctor` validates local credentials and reports the supported models without
  sending a model inference request.
- `key refresh` replaces the local Bridge API key and prints the new value.

The running server reads the stored key for every protected request. A manual
refresh therefore takes effect immediately: clients using the old key receive
HTTP 401 and must be updated with the newly printed key.

There are no `login`, `refresh`, or `logout` commands. Open Codex and make a
request, or run `codex login`, when the bridge reports expired or unauthorized
credentials.

## API

The bridge exposes:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /v1/models`
- `GET /auth/status`
- `GET /health`

All endpoints except `/health` require either:

```text
x-api-key: <printed Codex Bridge API key>
```

or:

```text
Authorization: Bearer <printed Codex Bridge API key>
```

Messages support text, image inputs, tools, tool results, streaming, reasoning
effort, usage, and Codex encrypted reasoning continuity. Unsupported required
content returns an explicit compatibility error.

Responses support string or item-array input, text and image URL content,
function tools and results, encrypted reasoning history, structured text
configuration, and streaming or non-streaming output. The upstream request is
always stateless and streamed internally; non-streaming client requests are
assembled from the terminal Responses event.

Responses compaction accepts the OpenAI-compatible `POST /v1/responses/compact`
contract. The ChatGPT Codex subscription backend does
not expose that route directly, so the bridge uses the current Codex protocol:
it sends the complete history plus a `compaction_trigger` through
`/responses`, then returns a `response.compaction` object containing the
retained user messages and the upstream compaction item. The compaction item,
its encrypted content, IDs, ordering, usage, and unknown fields remain opaque.
Pass the returned `output` items plus the next user message to
`POST /v1/responses`:

```javascript
const compacted = await client.responses.compact({
  model: "gpt-6.1-sol",
  input: completeHistory
});

const next = await client.responses.create({
  model: "gpt-6.1-sol",
  input: [...compacted.output, { role: "user", content: "Continue." }]
});
```

Compaction remains stateless: the caller owns the history and decides when to
compact or fall back. Treat returned compaction items as opaque and continue
with the same upstream model because their encrypted content is model- and
provider-specific. See the [OpenAI Responses Compaction API](https://developers.openai.com/api/reference/resources/responses/methods/compact).

The Responses endpoint implements the supported Codex subset rather than the
entire OpenAI platform API. It requires `store: false` when `store` is supplied
and rejects background mode, server-side conversation continuation, hosted
tools, file inputs, and unsupported include or reasoning options. Send complete
input history, including encrypted reasoning items, for stateless continuation.

`GET /health` includes `capabilities.responses_compact: true` so clients can
discover native compaction support without sending a probe request.

`/v1/messages/count_tokens` is a conservative compatibility estimate. The
private Codex backend exposes no tokenizer endpoint, so it must not be used for
billing or exact context-window accounting.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_BRIDGE_HOST` | `127.0.0.1` | Bind address |
| `CODEX_BRIDGE_PORT` | `3456` | Bind port |
| `CODEX_HOME` | `~/.codex` | Existing Codex home |
| `CODEX_BRIDGE_MODEL` | request model | Force `gpt-6-astra`, `gpt-6.1-sol`, or `gpt-6-luna` |
| `CODEX_BRIDGE_DEFAULT_EFFORT` | `medium` | Default reasoning effort |
| `CODEX_BRIDGE_BODY_LIMIT_BYTES` | `33554432` | Maximum JSON request size |
| `CODEX_BRIDGE_LOG_LEVEL` | `info` | `silent`, `error`, or `info` |
| `CODEX_BRIDGE_MAX_RETRIES` | `2` | Transient retries before the upstream response starts, from `0` to `5` |
| `CODEX_BRIDGE_CODEX_BASE_URL` | ChatGPT Codex backend | Adapter test/override URL |
| `CODEX_BRIDGE_CODEX_CLIENT_VERSION` | `0.139.0` | Private Codex backend client identity |

Binding outside loopback exposes the bridge to other hosts that can reach the
port. Use a strong client token and a trusted network. A containerized client
can usually reach a host bridge through `host.docker.internal` after the bridge
is explicitly bound to a reachable host address.

## Credential Behavior

The Bridge-specific client key is generated from 32 random bytes. Codex Bridge
creates `~/.cb` with mode `0700` and `~/.cb/config.json` with mode `0600` on
Unix-like systems. This key is unrelated to Codex OAuth credentials.

Run `codex-bridge key refresh` to rotate it. The command replaces only the
Bridge key and never touches Codex credentials.

Codex Bridge reads a fresh credential snapshot for every upstream request. It
never writes `auth.json` and never uses the refresh token.

If an upstream request returns HTTP 401, the bridge reads the credential file
again. It retries exactly once only when Codex has replaced the access token.
If the token is unchanged, the bridge returns an actionable authentication
error instead of attempting OAuth refresh itself.

Credential values are excluded from health output, status output, errors, and
logs.

## Network And Retries

Codex Bridge uses Node.js `fetch` and the operating system's network routes.
A VPN with TUN routing can carry Bridge traffic without an explicit proxy.
An OS HTTP/SOCKS proxy setting alone does not configure Node.js `fetch`.
The Bridge never changes system proxy or Claude Code settings.

For an explicit HTTP proxy, start only the Bridge process with Node.js
environment-proxy support (Node.js 22.21.0+ or 24.5.0+). Replace the example
proxy port with your VPN's actual HTTP proxy port:

```bash
HTTPS_PROXY="http://127.0.0.1:7897" \
HTTP_PROXY="http://127.0.0.1:7897" \
NO_PROXY="localhost,127.0.0.1,::1" \
NODE_USE_ENV_PROXY=1 codex-bridge serve
```

See [Node.js enterprise network configuration](https://nodejs.org/en/learn/http/enterprise-network-configuration)
for version requirements and proxy configuration. Older Node.js versions still
work with transparent VPN routing, but the command above requires a version
with environment-proxy support.

Transient connection failures (such as connection reset, temporary DNS
failure, and connect timeout) and HTTP `408`, `429`, `500`, `502`, `503`, or
`504` receive at most two retries by default: after 1 second, then 2 seconds.
Additional configured retries use exponential backoff capped at 10 seconds;
`Retry-After` can increase the wait up to the same cap. Set
`CODEX_BRIDGE_MAX_RETRIES=0` to disable these retries.

Invalid requests, permanent DNS failures, TLS verification failures, unchanged
unauthorized credentials, and client cancellation are not retried. Cancelling
a request stops any pending backoff. The separate single credential-reload
retry described above remains available when the login token changed.

Retries apply only before a successful upstream response is received. Once
its body starts, the Bridge never replays it, even for non-streaming clients.
A partial-stream disconnect or missing completion produces an explicit SSE
`error` event in the client's API format instead of silently ending or
fabricating success. A disconnect after a terminal success event does not
turn that completed stream into a failure.

HTTP errors and streaming errors include sanitized cause messages and
available network details such as `code`, `syscall`, host, and port. OAuth
tokens, API keys, proxy credentials, and labeled `encrypted_content` values
are redacted; request bodies, headers, and stack traces are not copied into
diagnostics. The Bridge does not save request or response logs to disk.

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

To run the opt-in live compatibility tests against all supported Codex models,
use an existing file-backed Codex login:

```bash
CODEX_BRIDGE_RUN_LIVE_TESTS=1 npm test
```

The live test sends real model requests and consumes subscription usage. It
verifies public reasoning-summary events independently from reasoning-token
accounting and never prints encrypted reasoning content or credentials.

The original design and security decisions are recorded in
[`docs/implementation-plan.md`](docs/implementation-plan.md).
