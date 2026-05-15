# ai-server-template

Thin HTTP server that wraps coding-agent CLIs — primarily the **Claude Code CLI** (`claude`), with a fallback to the **OpenAI Codex CLI** (`codex`) — so other services can invoke them over HTTP without an Anthropic / OpenAI API key. It leverages whichever subscription is already authenticated on the host.

> **Status:** POC — minimal endpoint to validate the approach before adding real features.

## Stack

- Node.js 20+ / TypeScript / Hono
- No database; optional Bearer-token auth on `/api/*` (set `API_TOKEN`)
- `claude` CLI invoked via `child_process.spawn` in headless mode (`-p ... --output-format json`)
- `codex` CLI invoked via `codex exec --json --sandbox read-only` as a drop-in alternative

## Prerequisites

- `node --version` ≥ 20
- `claude --version` (Claude Code CLI installed and authenticated on the host)
- *(optional)* `codex --version` (OpenAI Codex CLI installed and authenticated)
  — only required if you intend to route requests with `provider: "codex"`

## Choosing a provider

Every `/api/*` route accepts an optional `provider: "claude" | "codex"` field. When omitted, the server resolves the default provider with this precedence:

1. `DEFAULT_PROVIDER` env var (if set)
2. `defaultProvider` field in `./config.json` (if the file exists)
3. Built-in default: `claude`

To pin the default in a versioned file, copy the example and edit it:

```bash
cp config.example.json config.json
# {
#   "defaultProvider": "codex"
# }
```

`config.json` is git-ignored — each environment can keep its own copy. A real `DEFAULT_PROVIDER` env var always wins over the file, so you can rebuild a Docker image with `DEFAULT_PROVIDER=codex` for staging without touching the committed defaults.

## Run locally

```bash
npm install
cp .env.example .env
npm run dev          # http://localhost:3100
```

## Endpoints

### `GET /health`
Returns server uptime and detected `claude` CLI version.

### `POST /api/v1/test`
Body: `{ "prompt": string, "provider"?: "claude" | "codex", "maxTurns"?: number, "timeoutMs"?: number }`
With `provider: "claude"` (default): spawns `claude -p <prompt> --output-format json --max-turns <n>`.
With `provider: "codex"`: spawns `codex exec --json --skip-git-repo-check --sandbox read-only <prompt>`.

```bash
curl -s -X POST http://localhost:3100/api/v1/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"prompt":"Réponds uniquement par le nombre 42, sans rien d autre."}'

# Force the Codex backend:
curl -s -X POST http://localhost:3100/api/v1/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"provider":"codex","prompt":"Réponds uniquement par le nombre 42."}'
```

### `POST /api/v1/chat` (SSE, streaming)
Body: `{ "prompt": string, "provider"?: "claude" | "codex", "sessionId"?: string, "systemPrompt"?: string, "maxTurns"?: number, "timeoutMs"?: number }`
With `provider: "claude"` (default): spawns `claude --output-format stream-json --verbose --include-partial-messages` (with `--resume <sessionId>` if provided, `--append-system-prompt` if provided, and the `--tools ""` hardening).
With `provider: "codex"`: spawns `codex exec --json --skip-git-repo-check --sandbox read-only` (with `codex exec resume <sessionId>` when `sessionId` is provided, and `systemPrompt` injected as a leading `[SYSTEM]` block). Streams JSONL events back as Server-Sent Events.

Event names: `session` (first, carries `sessionId` for resume), `delta` (incremental text), `message` (assistant message complete), `result` (final accounting: result text, totalCostUsd, numTurns, durationMs), `error` (terminal failure with `code` matching the CLI error code and the originating `provider`). Note that `totalCostUsd` is only populated for Claude — Codex `exec --json` does not expose a per-call cost.

```bash
curl -N -X POST http://localhost:3100/api/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"prompt":"Bonjour, présente-toi en une phrase."}'
```

Multi-turn: capture `sessionId` from the `session` (or `result`) event of turn N, pass it back as `sessionId` on turn N+1 to resume the conversation. Sessions are **not interchangeable** between providers — a session opened with Claude must be continued with Claude, and likewise for Codex. Persistence relies on each CLI's home dir being bind-mounted (`~/.claude` for Claude, `~/.codex` for Codex).

## Authentication

When `API_TOKEN` is set in the environment, all `/api/*` routes require an
`Authorization: Bearer <token>` header. Requests without a token (or with a
wrong one) get `401`. `/health` and `/` stay public so monitors and reverse
proxies can probe them.

Generate a strong token:

```bash
openssl rand -hex 32
```

Leave `API_TOKEN` empty (or unset) to disable auth — handy for local dev only.

## Deploy with Docker

A `Dockerfile` and `docker-compose.yml` are included for deployments behind
[Traefik](https://traefik.io/). The container expects the host's authenticated
CLIs to be mounted in:

- `/opt/claude/bin/claude` — the Claude CLI binary (or a symlink to it)
- `/home/claude/.claude` — the Claude credentials directory (RW, since the CLI
  refreshes OAuth tokens)
- `/opt/codex/bin/codex` *(optional)* — the Codex CLI binary
- `/home/claude/.codex` *(optional)* — the Codex credentials directory (RW)

If you don't intend to serve `provider: "codex"`, you can omit the codex
mounts entirely — the server will still start and any request without
`provider` (or with `provider: "claude"`) keeps working.

The provided compose file targets a host where Traefik already runs on the
`n8n_default` network. Adjust the network name, host paths, and `Host(...)`
rule to match your environment, then:

```bash
cp .env.example .env
# edit .env: set API_TOKEN, etc.
docker compose up -d --build
```

## Tests

```bash
npm test
```

Tests stub `child_process.spawn` to validate parsing/error paths without invoking the real CLI.

## Roadmap

1. Validate POC locally (this).
2. Add `POST /api/v1/calls/structure` — call transcript structuring with 2-speaker diarization.
3. ~~Add Bearer-token auth~~ (done) + rate limiting.
4. ~~Deploy to `ai.takamoa.com`~~ (done — Docker behind the existing Traefik).
5. Integrate from `api-server-template` CRM outbound module.

---

This server is intended to be deployed at **ai.takamoa.com** as the AI gateway for the takamoa stack.
