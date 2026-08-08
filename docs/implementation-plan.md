# Codex Bridge Implementation Plan

## 1. Objective

Build a focused local gateway that exposes Codex-backed models through an
Anthropic-compatible API for clients such as Claude Code and VibeCodingMaster.

Codex Bridge will:

- be implemented in TypeScript on Node.js
- be distributed as an npm package
- read the existing local Codex OAuth credentials
- translate supported Anthropic Messages requests to the Codex Responses API
- translate Codex responses and streams back to Anthropic-compatible responses
- run as a local service with no remote management dependency

Codex Bridge will not:

- modify Claude Code settings or files
- set persistent Claude Code environment variables
- launch or wrap Claude Code
- modify system proxy or certificate settings
- copy Codex credentials into its own configuration
- refresh, revoke, or otherwise manage Codex OAuth credentials
- provide multi-provider routing, profiles, or fallback providers

## 2. Credential Ownership

Codex remains the only owner of authentication and credential refresh.

Codex Bridge treats the active Codex credential store as the source of truth.
For every upstream request, it loads a fresh credential snapshot from
`$CODEX_HOME/auth.json`, with `$CODEX_HOME` defaulting to `~/.codex`.

The first release supports file-backed Codex credentials. If credentials are
missing, malformed, expired, unauthorized, or stored only in an unsupported
keyring, the request fails with a specific diagnostic. Codex Bridge never uses
the refresh token to contact the OAuth endpoint.

Credential values must never appear in logs, health responses, errors, metrics,
or generated diagnostics.

### Authentication states

- `ready`: a usable access token and account identifier are available
- `not_found`: the expected Codex credential file does not exist
- `invalid`: the credential file or required token claims are invalid
- `expired`: the access token has expired
- `unauthorized`: the Codex backend rejected the current credential
- `unsupported_storage`: no readable file-backed credential is available

When the upstream returns HTTP 401, Codex Bridge reloads the credential file
once. It retries the request only when the newly loaded access token differs
from the token used by the failed request. Otherwise it returns an actionable
error instructing the user to open Codex and make a request, or run
`codex login`, before retrying.

## 3. API Surface

The local server binds to `127.0.0.1` by default and requires a local client
token independent of the Codex credential.

Initial endpoints:

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- `GET /v1/models`
- `GET /health`
- `GET /auth/status`

The health and authentication endpoints expose state and safe metadata only.
They never expose OAuth tokens or raw credential contents.

## 4. Protocol Translation

The Anthropic compatibility layer must support the Claude Code request patterns
used by VibeCodingMaster:

- system instructions and ordered conversation messages
- text and supported structured content blocks
- tool definitions, tool calls, and tool results
- streaming Server-Sent Events
- stop reasons and completion state
- model and reasoning-effort mapping
- token usage when supplied by the upstream response
- upstream errors, rate limits, authentication failures, and cancellations

Unknown fields should be ignored only when they are optional. Unsupported
required behavior must return an explicit compatibility error rather than a
partial or fabricated response.

The Codex backend used by ChatGPT-authenticated Codex clients is not documented
as a stable public third-party API. Upstream request headers, models, event
formats, and endpoints must therefore be isolated behind a versioned adapter.

## 5. Architecture

```text
src/
  auth/
    codex-home.ts
    credential-reader.ts
    credential-status.ts
  upstream/
    codex-client.ts
  protocol/
    anthropic-request.ts
    anthropic-response.ts
    anthropic-stream.ts
    reasoning-envelope.ts
    sse.ts
    token-count.ts
  server/
    app.ts
  cli/
    index.ts
  config/
    config.ts
```

Primary components:

- `CodexCredentialReader` resolves `CODEX_HOME`, loads a fresh snapshot, parses
  token expiry, and returns redacted status information.
- `CodexClient` owns all communication with the Codex backend and performs the
  single credential-reload retry after HTTP 401.
- The protocol modules convert requests, responses, streaming events, tools,
  encrypted reasoning, and errors without containing credential or server
  concerns.
- `LocalServer` handles local client authentication, request cancellation,
  endpoint validation, and graceful shutdown.
- `CLI` exposes `serve`, `status`, and `doctor` without modifying external tools.

## 6. Configuration

Codex Bridge stores only its own non-Codex settings. Suggested environment
variables:

- `CODEX_BRIDGE_HOST`
- `CODEX_BRIDGE_PORT`
- `CODEX_BRIDGE_API_KEY`
- `CODEX_BRIDGE_LOG_LEVEL`
- `CODEX_BRIDGE_CODEX_CLIENT_VERSION`, used only by the versioned private
  backend adapter for model-catalog compatibility
- `CODEX_HOME`, consumed as the standard Codex credential location

No Codex access token, refresh token, or ID token may be accepted as persistent
Codex Bridge configuration.

Claude Code or VibeCodingMaster remains responsible for selecting when to use
the bridge and for passing the bridge URL and local client token to that process.

## 7. CLI Behavior

```text
codex-bridge serve
codex-bridge status
codex-bridge doctor
codex-bridge --version
codex-bridge --help
```

- `serve` starts the local gateway.
- `status` reports server reachability and redacted Codex authentication state.
- `doctor` validates Node.js, credential storage, model discovery, local port,
  and upstream reachability without sending a model request by default.

There is no `login`, `refresh`, or `logout` command. Those operations belong to
Codex.

## 8. Error Contract

Errors use a stable machine-readable code and an actionable message. Initial
codes include:

- `CODEX_AUTH_NOT_FOUND`
- `CODEX_AUTH_INVALID`
- `CODEX_AUTH_EXPIRED`
- `CODEX_AUTH_UNAUTHORIZED`
- `CODEX_AUTH_STORAGE_UNSUPPORTED`
- `CODEX_MODEL_UNAVAILABLE`
- `CODEX_UPSTREAM_UNREACHABLE`
- `CODEX_UPSTREAM_RATE_LIMITED`
- `PROTOCOL_REQUEST_UNSUPPORTED`
- `PROTOCOL_RESPONSE_INVALID`

Authentication errors direct the user back to Codex. They must not recommend
editing credential files manually.

## 9. Security Requirements

- bind to loopback unless the user explicitly selects another address
- require a bridge-specific client token
- redact authorization headers and all Codex token values
- avoid request-body logging by default
- disable telemetry by default
- use a minimal dependency set
- publish no npm lifecycle scripts that execute during installation
- use npm provenance and protected publishing credentials
- test packaged artifacts to ensure source credentials and local files are not
  included

The gateway is intended for local, single-user use. Remote multi-user hosting is
outside the initial scope.

## 10. Testing Strategy

### Unit tests

- `CODEX_HOME` and default-path resolution
- valid, malformed, missing, and expired credential files
- JWT expiry parsing and redaction
- credentials replaced between two requests
- credentials replaced after an upstream 401
- no retry when the credential is unchanged
- request and response block conversion
- tool-call and tool-result conversion
- streaming event ordering and termination
- stable error mapping

### Integration tests

- local HTTP endpoints and client authentication
- streaming cancellation and client disconnects
- model discovery caching and invalidation
- mocked Codex 401, 429, 5xx, malformed stream, and network failure
- verification that no code path writes to `auth.json` or `~/.claude`

### Manual smoke tests

- Claude Code basic text exchange
- Claude Code tool use
- long streaming response
- Codex credential expiration followed by a user-driven Codex refresh
- VibeCodingMaster session using a bridge model
- normal Claude Code model startup after bridge use

Real Codex credentials must never be used in automated CI.

## 11. Delivery Stages

### Stage 1: Foundation

- TypeScript npm package and CLI
- configuration and local server
- read-only credential reader
- health, status, and model endpoints
- mocked upstream test harness

### Stage 2: Anthropic Compatibility

- non-streaming Messages conversion
- streaming conversion
- tool-use conversion
- error and cancellation behavior

### Stage 3: Client Validation

- Claude Code smoke tests
- VibeCodingMaster integration tests
- compatibility fixtures captured without credentials or private content

### Stage 4: npm Release

- package-content audit
- security and secret scan
- README usage documentation
- npm provenance and initial release

## 12. Acceptance Criteria

The first release is complete when:

- Claude Code can complete text and tool-use requests through Codex Bridge
- VibeCodingMaster can select the bridge without persistent Claude changes
- normal Claude Code providers remain unaffected
- replacing the Codex credential is observed on the next request
- expired credentials produce an actionable error without OAuth refresh
- no Codex credential is copied into Codex Bridge state
- no code path writes to Codex or Claude Code configuration
- protocol and authentication failure paths are covered by automated tests
