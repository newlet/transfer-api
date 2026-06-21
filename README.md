# unlimited.surf OpenAI-compatible Worker

Cloudflare Worker adapter for NewAPI and other OpenAI-compatible clients.

It maps:

- `GET /v1/models` -> `GET /api/models`
- `POST /v1/chat/completions` -> `POST /api/chat`
- `POST /v1/responses` -> text-only compatibility over `POST /api/chat`
- `POST /v1/messages` -> Anthropic-compatible passthrough for Hermes, Claude Code, and MCP-capable agents
- `POST /anthropic/v1/messages` -> alias for the same Anthropic-compatible route
- `POST /v1/files/extract` and `/v1/attachments/extract` -> `POST /api/attachments/extract`
- `/api/*` -> raw upstream proxy

Important: unlimited.surf documents that it does not expose a full OpenAI Responses-compatible `/v1/responses` route yet. This Worker provides text chat compatibility for NewAPI. Structured tool calls are rejected with `501` because the upstream `/api/chat` endpoint only streams text deltas.

For Hermes, Claude Code, and MCP-capable agents, use the Anthropic-compatible route. The Worker preserves the request body, including `tools` and image content blocks, and forwards it to unlimited.surf `/v1/messages`. Tool execution still happens in the local agent. Vision only works if unlimited.surf accepts the image blocks for the selected model.

## Deploy

```bash
npm install
wrangler secret put UNLIMITED_SURF_API_KEY
wrangler secret put WORKER_API_KEY
wrangler deploy
```

`WORKER_API_KEY` is optional but recommended. If it is set, NewAPI must send that key. The Worker uses `UNLIMITED_SURF_API_KEY` for unlimited.surf.

## NewAPI

```text
Channel type: OpenAI compatible
Base URL: https://your-worker.workers.dev/v1
API key: WORKER_API_KEY
Models: gateway-gpt-5, gateway-gpt-5-5, gateway-claude-opus-4-7, ...
```

## Hermes / Claude Code

```text
ANTHROPIC_BASE_URL=https://your-worker.workers.dev
ANTHROPIC_AUTH_TOKEN=WORKER_API_KEY
ANTHROPIC_API_KEY=WORKER_API_KEY
ANTHROPIC_MODEL=claude-opus-4-7-20260101
```

Endpoints:

```text
POST /v1/messages
POST /anthropic/v1/messages
GET /anthropic/v1/models
GET /v1/setup
GET /v1/mcp
GET /v1/codex
```

Smoke test:

```bash
curl https://your-worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer YOUR_WORKER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gateway-gpt-5","messages":[{"role":"user","content":"hello"}],"stream":false}'
```
