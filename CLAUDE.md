# ACP — Agent Collaboration Platform (Backend)

This is the **backend engine** of ACP. The desktop shell lives at `E:\Repos\acp-desktop`.

ACP is one product with two halves:

| Layer | Repo | Tech |
|-------|------|------|
| **Desktop Shell** | `E:\Repos\acp-desktop` | Electron 28 + React 18 + TypeScript + Vite |
| **Backend API** | `E:\Repos\acp` (this repo) | Node.js + Express (migrating to TypeScript) |

## What This Repo Contains

The headless API server that powers agent collaboration, autonomy, and coordination.

```
acp/
├── api/              Express server + routes
│   ├── server.js     Entry point (node api/server.js)
│   ├── middleware.js  Request middleware
│   ├── response.js   Response helpers
│   └── routes/       REST endpoints
│       ├── bootstrap.js    Agent bootstrap
│       ├── exec.js         Agent execution
│       ├── modify.js       Self-modification
│       ├── sessions.js     Session management
│       ├── messaging.js    Mail/messaging
│       ├── autonomy.js     Autonomous operation
│       ├── kanban.js       Kanban board
│       └── party.js        Party engine
├── collaboration/    Multi-agent coordination
│   ├── chat.js       Real-time chat (building out — see spec)
│   ├── mail.js       Agent mail integration
│   ├── broadcast.js  Broadcast messaging
│   ├── party_engine.js  Party formation
│   └── relevance.js  Message relevance scoring
├── autonomy/         Autonomous agent operation
│   ├── supervisor.js    Agent supervision
│   └── escalation.js   Escalation to humans
├── core/             Core agent lifecycle
│   ├── bootstrap.js     Agent initialization
│   ├── exec_with_agent.js  Execution context
│   └── modify_self.js  Self-modification
├── storage/          Data layer (VibeSQL only)
│   ├── adapter.js       Storage adapter factory
│   └── vibesql_client.js  VibeSQL client (POST /v1/query)
├── agents/
│   └── session_manager.js  Agent session lifecycle
├── config.ts         Environment configuration
└── __tests__/        Jest test suite
```

## Development

```bash
npm install
npm start          # node api/server.js (port 3001)
npm test           # jest with ESM support
npm run lint       # eslint
```

## Configuration

See `config.ts` — key settings:
- `PORT` — API port (default 3001)
- `VIBESQL_URL` — VibeSQL endpoint (default http://localhost:52411)
- `VIBE_API_URL` — Vibe Public API (default https://api.idealvibe.online)

## Architecture Notes

- **VibeSQL is PostgreSQL.** Never reference SQLite. Storage adapter speaks `POST /v1/query` with `{ "sql": "..." }`.
- **Plain JS ESM today, migrating to TypeScript.** New code (especially chat server) should be TypeScript. Existing files migrate incrementally.
- **The Electron shell consumes this API** via HTTP and WebSocket. Transport layer must serve both headless agents and the desktop UI.

## Key Specs

- **Chat Architecture**: `E:\Repos\Agents\BAPert\specs\ACP-agent-chat-architecture-v1.md` (v1.1, QAPert-approved)
- **Harness Analysis**: `docs/acp_harness_analysis.md` (Codex harness patterns)
- **Harness Spec**: `E:\Repos\Agents\BAPert\specs\planned\VIBE_AGENTS_HARNESS_SPEC.md`

## Related Repos

| Repo | Purpose |
|------|---------|
| `E:\Repos\acp-desktop` | Electron desktop shell (the UI half of ACP) |
| `E:\Repos\agent-collaboration-platform` | Older fork of desktop shell (superseded by acp-desktop) |
| `E:\Repos\Agents` | Agent profiles, mail scripts, specs |
| `E:\Repos\vibesql-mail` | Agent mail server + specs |
