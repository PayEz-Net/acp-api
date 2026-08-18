// Test-harness env defaults (kanban 221084).
// config.ts hard-requires IDP_URL and VIBE_API_URL at import time — that is
// deliberate product design (no-fallback doctrine, see config.ts comments),
// NOT a bug. But any suite importing the server/config chain then fails to
// COLLECT under jest, where no .env exists. Fill the two required vars with
// inert test values here so suites collect; suites that need specific config
// pass their own overrides into createApp(). Existing env vars win.
if (!process.env.IDP_URL) process.env.IDP_URL = 'https://idp.test.invalid';
if (!process.env.VIBE_API_URL) process.env.VIBE_API_URL = 'https://vibe-api.test.invalid';
