# ai-server-template

Thin HTTP server that wraps the **Claude Code CLI** (`claude`) so other services can invoke Claude over HTTP without an Anthropic API key — leveraging the Claude Code subscription already authenticated on the host.

> **Status:** POC — minimal endpoint to validate the approach before adding real features.

## Stack

- Node.js 20+ / TypeScript / Hono
- No database; optional Bearer-token auth on `/api/*` (set `API_TOKEN`)
- `claude` CLI invoked via `child_process.spawn` in headless mode (`-p ... --output-format json`)

## Prerequisites

- `node --version` ≥ 20
- `claude --version` (Claude Code CLI installed and authenticated on the host)

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
Body: `{ "prompt": string, "maxTurns"?: number, "timeoutMs"?: number }`
Spawns `claude -p <prompt> --output-format json --max-turns <n>` and returns its parsed result.

```bash
curl -s -X POST http://localhost:3100/api/v1/test \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_TOKEN" \
  -d '{"prompt":"Réponds uniquement par le nombre 42, sans rien d autre."}'
```

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
`claude` CLI to be mounted in:

- `/opt/claude/bin/claude` — the CLI binary (or a symlink to it)
- `/home/claude/.claude` — the credentials directory (RW, since the CLI
  refreshes OAuth tokens)

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
