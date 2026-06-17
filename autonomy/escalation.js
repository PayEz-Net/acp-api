const LEVEL_NAMES = { 1: 'relaxed', 2: 'balanced', 3: 'cautious', 4: 'strict' };

export { LEVEL_NAMES };

export function evaluateTriggers(level, context = {}) {
  const triggers = [];

  if (context.systemDown) triggers.push({ type: 'system_failure', minLevel: 1 });
  if (context.allBlocked) triggers.push({ type: 'all_agents_blocked', minLevel: 1 });

  if (context.repeatedBlocker >= 3) triggers.push({ type: 'repeated_blocker', minLevel: 2 });
  if (context.reviewPendingHours > 4) triggers.push({ type: 'stale_review', minLevel: 2 });
  if (context.spinningMinutes > 30) triggers.push({ type: 'agent_spinning', minLevel: 2 });

  if (context.anyBlocker) triggers.push({ type: 'any_blocker', minLevel: 3 });
  if (context.testFailure) triggers.push({ type: 'test_failure', minLevel: 3 });
  if (context.idleMinutes > 15) triggers.push({ type: 'agent_idle', minLevel: 3 });

  if (context.architectureChange) triggers.push({ type: 'architecture_change', minLevel: 4 });
  if (context.schemaChange) triggers.push({ type: 'schema_change', minLevel: 4 });
  if (context.milestoneComplete) triggers.push({ type: 'milestone_signoff', minLevel: 4 });

  return triggers.filter((t) => level >= t.minLevel);
}

export function getShutdownMode(triggers) {
  const types = triggers.map((t) => t.type);
  if (types.includes('system_failure') || types.includes('all_agents_blocked')) return 'hard';
  if (types.includes('test_failure') || types.includes('architecture_change')) return 'soft';
  return 'pause';
}

export async function processEscalation(storage, level, context = {}) {
  const triggers = evaluateTriggers(level, context);
  if (triggers.length === 0) return null;

  const shutdownMode = getShutdownMode(triggers);
  const summary = triggers.map((t) => t.type).join(', ');

  await storage.createEscalation({
    sensitivityLevel: level,
    triggerType: triggers[0].type,
    summary,
    shutdownMode,
  });

  return { triggers, shutdownMode, summary };
}
