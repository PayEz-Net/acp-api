import { jest } from '@jest/globals';
import { Supervisor } from '../autonomy/supervisor.js';

function createMockStorage(state = null) {
  return {
    getAutonomyState: jest.fn(async () => state),
    updateAutonomyState: jest.fn(async (s) => { Object.assign(state || {}, s); }),
    createStandupEntry: jest.fn(async () => 1),
    listStandupEntries: jest.fn(async () => []),
  };
}

describe('Supervisor', () => {
  test('start enables autonomy', async () => {
    const storage = createMockStorage(null);
    const sup = new Supervisor(storage);
    await sup.start({ milestone: 'day_1' });
    const update = storage.updateAutonomyState.mock.calls[0][0];
    expect(update.enabled).toBe(true);
    expect(update.currentMilestone).toBe('day_1');
    expect(update.stopCondition).toBe('milestone');
  });

  test('start throws if already running', async () => {
    const storage = createMockStorage({ enabled: true });
    const sup = new Supervisor(storage);
    await expect(sup.start()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('stop disables autonomy', async () => {
    const state = { enabled: true, startedAt: new Date().toISOString() };
    const storage = createMockStorage(state);
    const sup = new Supervisor(storage);
    await sup.stop('milestone');
    const update = storage.updateAutonomyState.mock.calls[0][0];
    expect(update.enabled).toBe(false);
    expect(update.stopReason).toBe('milestone');
  });

  test('stop throws if not running', async () => {
    const storage = createMockStorage({ enabled: false });
    const sup = new Supervisor(storage);
    await expect(sup.stop()).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  // #82: review/blocked are NO LONGER terminal stops — a working board (cards in review or
  // blocked) must NOT kill the keep-alive. They're FYI signals in the ping body now.
  test('#82: checkStopConditions does NOT stop on 2+ blocked (FYI signal, not terminal)', async () => {
    const storage = createMockStorage({ enabled: true, startedAt: new Date().toISOString(), maxRuntimeHours: 4 });
    const sup = new Supervisor(storage);
    const tasks = [
      { status: 'blocked' },
      { status: 'blocked' },
      { status: 'in_progress' },
    ];
    expect(await sup.checkStopConditions(tasks)).toBeNull();
  });

  test('#82: checkStopConditions does NOT stop on a full review queue (the self-stop bug)', async () => {
    const storage = createMockStorage({ enabled: true, startedAt: new Date().toISOString(), maxRuntimeHours: 4 });
    const sup = new Supervisor(storage);
    // mirror the live board that triggered the self-stop right after the init ping: 21 in
    // review is a HEALTHY, actively-worked state, not a halt condition.
    const tasks = Array.from({ length: 21 }, () => ({ status: 'review' }));
    expect(await sup.checkStopConditions(tasks)).toBeNull();
  });

  test('checkStopConditions returns milestone when all milestone tasks done', async () => {
    const storage = createMockStorage({ enabled: true, startedAt: new Date().toISOString(), currentMilestone: 'day_1', maxRuntimeHours: 4 });
    const sup = new Supervisor(storage);
    const tasks = [
      { milestone: 'day_1', status: 'done' },
      { milestone: 'day_1', status: 'done' },
      { milestone: 'day_2', status: 'in_progress' },
    ];
    expect(await sup.checkStopConditions(tasks)).toBe('milestone');
  });

  test('checkStopConditions returns max_runtime when exceeded', async () => {
    const past = new Date(Date.now() - 5 * 3600000).toISOString();
    const storage = createMockStorage({ enabled: true, startedAt: past, maxRuntimeHours: 4 });
    const sup = new Supervisor(storage);
    expect(await sup.checkStopConditions([])).toBe('max_runtime');
  });

  test('checkStopConditions returns null when not running', async () => {
    const storage = createMockStorage({ enabled: false });
    const sup = new Supervisor(storage);
    expect(await sup.checkStopConditions([])).toBeNull();
  });

  test('checkStopConditions returns null when no conditions met', async () => {
    const storage = createMockStorage({ enabled: true, startedAt: new Date().toISOString(), maxRuntimeHours: 4 });
    const sup = new Supervisor(storage);
    const tasks = [{ status: 'in_progress' }];
    expect(await sup.checkStopConditions(tasks)).toBeNull();
  });

  test('addStandupEntry delegates to storage', async () => {
    const storage = createMockStorage(null);
    const sup = new Supervisor(storage);
    await sup.addStandupEntry({ agentName: 'DotNetPert', type: 'complete', summary: 'Finished task', taskId: 5 });
    const entry = storage.createStandupEntry.mock.calls[0][0];
    expect(entry.agentName).toBe('DotNetPert');
    expect(entry.entryType).toBe('complete');
    expect(entry.summary).toBe('Finished task');
    expect(entry.taskId).toBe(5);
  });

  test('getStandup returns entries', async () => {
    const storage = createMockStorage(null);
    storage.listStandupEntries.mockResolvedValue([{ id: 1, summary: 'Test' }]);
    const sup = new Supervisor(storage);
    const entries = await sup.getStandup();
    expect(entries).toHaveLength(1);
  });
});
