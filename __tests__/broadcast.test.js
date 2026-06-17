import { jest } from '@jest/globals';
import { createBroadcast, listBroadcasts, feedSignalFromBroadcast } from '../collaboration/broadcast.js';

function createMockStorage() {
  return {
    createMessage: jest.fn(async () => 42),
    getMessages: jest.fn(async () => []),
    upsertSignal: jest.fn(async () => {}),
  };
}

describe('createBroadcast', () => {
  test('creates a broadcast message with correct fields', async () => {
    const storage = createMockStorage();
    const id = await createBroadcast(storage, {
      fromAgent: 'BAPert',
      body: 'Shipped auth module',
      keywords: ['auth', 'jwt'],
      channel: 'party:backend',
    });
    expect(id).toBe(42);
    expect(storage.createMessage).toHaveBeenCalledTimes(1);
    const msg = storage.createMessage.mock.calls[0][0];
    expect(msg.messageType).toBe('broadcast');
    expect(msg.fromAgent).toBe('BAPert');
    expect(msg.body).toBe('Shipped auth module');
    expect(msg.keywords).toEqual(['auth', 'jwt']);
    expect(msg.channel).toBe('party:backend');
  });

  test('defaults channel to party:general', async () => {
    const storage = createMockStorage();
    await createBroadcast(storage, { fromAgent: 'BAPert', body: 'Hello' });
    const msg = storage.createMessage.mock.calls[0][0];
    expect(msg.channel).toBe('party:general');
  });

  test('accepts message field as body alias', async () => {
    const storage = createMockStorage();
    await createBroadcast(storage, { fromAgent: 'BAPert', message: 'Test message' });
    const msg = storage.createMessage.mock.calls[0][0];
    expect(msg.body).toBe('Test message');
  });
});

describe('listBroadcasts', () => {
  test('queries with broadcast messageType', async () => {
    const storage = createMockStorage();
    await listBroadcasts(storage);
    expect(storage.getMessages).toHaveBeenCalledWith({ messageType: 'broadcast' });
  });

  test('passes channel filter when provided', async () => {
    const storage = createMockStorage();
    await listBroadcasts(storage, 'party:backend');
    expect(storage.getMessages).toHaveBeenCalledWith({ messageType: 'broadcast', channel: 'party:backend' });
  });
});

describe('feedSignalFromBroadcast', () => {
  test('upserts signal from broadcast data', async () => {
    const storage = createMockStorage();
    await feedSignalFromBroadcast(storage, {
      agentId: 'sage',
      agentName: 'BAPert',
      body: 'Working on auth',
      keywords: ['auth'],
      needs: ['tests'],
      offers: ['auth spec'],
    });
    expect(storage.upsertSignal).toHaveBeenCalledTimes(1);
    const signal = storage.upsertSignal.mock.calls[0][0];
    expect(signal.agentId).toBe('sage');
    expect(signal.agentName).toBe('BAPert');
    expect(signal.zone).toBe('bar');
    expect(signal.workingOn).toBe('Working on auth');
    expect(signal.keywords).toEqual(['auth']);
    expect(signal.needs).toEqual(['tests']);
    expect(signal.offers).toEqual(['auth spec']);
  });

  test('falls back to fromAgent for identity fields', async () => {
    const storage = createMockStorage();
    await feedSignalFromBroadcast(storage, {
      fromAgent: 'BAPert',
      message: 'Hello',
    });
    const signal = storage.upsertSignal.mock.calls[0][0];
    expect(signal.agentId).toBe('BAPert');
    expect(signal.agentName).toBe('BAPert');
  });
});
