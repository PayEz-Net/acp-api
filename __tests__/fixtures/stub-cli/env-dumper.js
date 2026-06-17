const keys = [
  'ACP_CONVERSATION_ID',
  'ACP_CONTRACTOR_CMD',
  'ACP_LOCAL_SECRET',
  'VIBESQL_CONTAINER_SECRET',
  'VAULT_API_TOKEN',
  'PATH',
  // Extra keys to inspect can be passed as CLI args. Live-exec regression
  // tests use this to assert arbitrary non-allowlisted vars were stripped.
  ...process.argv.slice(2),
];
for (const k of keys) {
  const v = process.env[k];
  if (v !== undefined) process.stderr.write(`env: ${k}=${v}\n`);
}
process.exit(1);
