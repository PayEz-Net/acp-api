import { jest } from '@jest/globals';
import { evaluateTriggers, getShutdownMode, processEscalation, LEVEL_NAMES } from '../autonomy/escalation.js';

describe('evaluateTriggers', () => {
  test('level 1 triggers on system failure', () => {
    const triggers = evaluateTriggers(1, { systemDown: true });
    expect(triggers).toHaveLength(1);
    expect(triggers[0].type).toBe('system_failure');
  });

  test('level 1 triggers on all blocked', () => {
    const triggers = evaluateTriggers(1, { allBlocked: true });
    expect(triggers[0].type).toBe('all_agents_blocked');
  });

  test('level 1 ignores level 2+ triggers', () => {
    const triggers = evaluateTriggers(1, { repeatedBlocker: 5, testFailure: true });
    expect(triggers).toHaveLength(0);
  });

  test('level 2 includes repeated blocker', () => {
    const triggers = evaluateTriggers(2, { repeatedBlocker: 3 });
    expect(triggers.some((t) => t.type === 'repeated_blocker')).toBe(true);
  });

  test('level 2 includes stale review', () => {
    const triggers = evaluateTriggers(2, { reviewPendingHours: 5 });
    expect(triggers.some((t) => t.type === 'stale_review')).toBe(true);
  });

  test('level 2 includes agent spinning', () => {
    const triggers = evaluateTriggers(2, { spinningMinutes: 31 });
    expect(triggers.some((t) => t.type === 'agent_spinning')).toBe(true);
  });

  test('level 3 includes any blocker', () => {
    const triggers = evaluateTriggers(3, { anyBlocker: true });
    expect(triggers.some((t) => t.type === 'any_blocker')).toBe(true);
  });

  test('level 3 includes test failure', () => {
    const triggers = evaluateTriggers(3, { testFailure: true });
    expect(triggers.some((t) => t.type === 'test_failure')).toBe(true);
  });

  test('level 3 includes agent idle', () => {
    const triggers = evaluateTriggers(3, { idleMinutes: 16 });
    expect(triggers.some((t) => t.type === 'agent_idle')).toBe(true);
  });

  test('level 4 includes architecture change', () => {
    const triggers = evaluateTriggers(4, { architectureChange: true });
    expect(triggers.some((t) => t.type === 'architecture_change')).toBe(true);
  });

  test('level 4 includes schema change', () => {
    const triggers = evaluateTriggers(4, { schemaChange: true });
    expect(triggers.some((t) => t.type === 'schema_change')).toBe(true);
  });

  test('level 4 includes milestone signoff', () => {
    const triggers = evaluateTriggers(4, { milestoneComplete: true });
    expect(triggers.some((t) => t.type === 'milestone_signoff')).toBe(true);
  });

  test('returns empty for no context', () => {
    expect(evaluateTriggers(4, {})).toHaveLength(0);
  });
});

describe('getShutdownMode', () => {
  test('returns hard for system failure', () => {
    expect(getShutdownMode([{ type: 'system_failure' }])).toBe('hard');
  });

  test('returns hard for all agents blocked', () => {
    expect(getShutdownMode([{ type: 'all_agents_blocked' }])).toBe('hard');
  });

  test('returns soft for test failure', () => {
    expect(getShutdownMode([{ type: 'test_failure' }])).toBe('soft');
  });

  test('returns soft for architecture change', () => {
    expect(getShutdownMode([{ type: 'architecture_change' }])).toBe('soft');
  });

  test('returns pause for other triggers', () => {
    expect(getShutdownMode([{ type: 'stale_review' }])).toBe('pause');
    expect(getShutdownMode([{ type: 'agent_idle' }])).toBe('pause');
  });
});

describe('processEscalation', () => {
  test('returns null when no triggers fire', async () => {
    const storage = { createEscalation: jest.fn(async () => {}) };
    const result = await processEscalation(storage, 2, {});
    expect(result).toBeNull();
    expect(storage.createEscalation).not.toHaveBeenCalled();
  });

  test('creates escalation log and returns result', async () => {
    const storage = { createEscalation: jest.fn(async () => {}) };
    const result = await processEscalation(storage, 1, { systemDown: true });
    expect(result.triggers).toHaveLength(1);
    expect(result.shutdownMode).toBe('hard');
    expect(result.summary).toContain('system_failure');
    expect(storage.createEscalation).toHaveBeenCalledWith(expect.objectContaining({
      sensitivityLevel: 1,
      triggerType: 'system_failure',
      shutdownMode: 'hard',
    }));
  });
});

describe('LEVEL_NAMES', () => {
  test('maps levels correctly', () => {
    expect(LEVEL_NAMES[1]).toBe('relaxed');
    expect(LEVEL_NAMES[2]).toBe('balanced');
    expect(LEVEL_NAMES[3]).toBe('cautious');
    expect(LEVEL_NAMES[4]).toBe('strict');
  });
});
