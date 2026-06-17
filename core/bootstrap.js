import { randomUUID } from 'node:crypto';

export async function bootstrap(sessionManager, agentName, initialPreferences) {
  const existing = await sessionManager.load(agentName);
  if (existing) {
    return existing;
  }

  const now = new Date().toISOString();
  const session = {
    sessionId: `sess_${randomUUID()}`,
    agentName,
    character: null,
    customFunctions: {},
    preferences: initialPreferences || {},
    memory: {},
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  await sessionManager.save(session);
  return { session, source: 'new' };
}
