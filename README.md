# ai-takamoa-server

Thin HTTP server that wraps the **Claude Code CLI** (`claude`) so other services can invoke Claude over HTTP without an Anthropic API key — leveraging the Claude Code subscription already authenticated on the host.

> **Status:** POC — minimal endpoint to validate the approach before adding real features.

## Stack

- Node.js 20+ / TypeScript / Hono
- No database, no auth (POC scope)
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
  -d '{"prompt":"Réponds uniquement par le nombre 42, sans rien d autre."}'
```

## Tests

```bash
npm test
```

Tests stub `child_process.spawn` to validate parsing/error paths without invoking the real CLI.

## Roadmap

1. Validate POC locally (this).
2. Add `POST /api/v1/calls/structure` — call transcript structuring with 2-speaker diarization.
3. Add Bearer-token auth + rate limiting.
4. Deploy to `ai.takamoa.com` (systemd + Hostinger hPanel reverse proxy, no extra packages).
5. Integrate from `api-server-template` CRM outbound module.
