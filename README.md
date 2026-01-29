# EveryBot

Moltbot-Lite: Windows-first AI assistant with Web + Mail, workspace files, memory, and scheduled tasks.

## Features

- **Web UI**: Local HTTP server (default port 3000), chat and session list at `/`
- **Mail**: IMAP/SMTP (e.g. QQ mailbox), MBCTX protocol for context and agent selection
- **LLM**: SiliconFlow (OpenAI-compatible), configurable models
- **Memory**: Per-conversation summary + facts (file-based), optional LLM summarization
- **File tools**: Workspace-only (WorkspaceFS), read/list without approval; write/delete require approval via `/api/approvals`
- **Scheduler**: Cron tasks in `data/tasks.json`, actions: sendMessage (mail), runTool, runChat

## Quick start

1. Copy `.env.example` to `.env` and set at least:
   - `SILICONFLOW_API_KEY` for LLM
   - Optionally `MAIL_USER` / `MAIL_PASS` for Mail channel
2. Install and run:

```bash
pnpm install
pnpm dev
```

3. Open http://localhost:3000 for the Web UI.

## API

- `GET /api/sessions` – list conversations
- `POST /api/chat` – send message (body: `{ sessionId?, message, agentId? }`)
- `GET /api/thread?sessionId=...` – get thread
- `POST /api/tools/file/list` – list workspace (body: `{ path? }`)
- `POST /api/tools/file/read` – read file (body: `{ path, maxBytes? }`)
- `POST /api/tools/file/write` – request write (returns `pendingId`; then `POST /api/approvals/:id/approve`)
- `POST /api/tools/file/delete` – request delete (same approval flow)
- `GET /api/approvals` – list pending approvals
- `POST /api/approvals/:id/approve` – approve and run
- `POST /api/approvals/:id/reject` – reject
- `GET /api/tasks` – list scheduled tasks
- `POST /api/tasks` – add task (body: `{ id?, cron, timezone?, action, enabled? }`)

## Data layout

- `data/conv/<convId>/` – meta.json, thread.jsonl, summary.md, facts.json
- `data/workspace/` – file tool root
- `data/tasks.json` – scheduled tasks
- `data/runs.jsonl` – scheduler run log
- `data/audit.jsonl` – tool call audit
- `data/inbox_processed.jsonl` – mail dedupe

## License

MIT
