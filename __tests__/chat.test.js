import { jest } from '@jest/globals';
import {
  sendChat, getChatHistory, getClusterMessages,
  createCluster, getCluster, addMember, removeMember, dissolveCluster,
} from '../collaboration/chat.js';

function createMockStorage() {
  return {
    createMessage: jest.fn(async () => 1),
    getMessages: jest.fn(async () => []),
    createCluster: jest.fn(async () => {}),
    getCluster: jest.fn(async () => null),
    updateCluster: jest.fn(async () => {}),
  };
}

describe('sendChat', () => {
  test('creates a chat message with sorted channel', async () => {
    const storage = createMockStorage();
    await sendChat(storage, { from: 'sage', to: 'forge', message: 'hey' });
    const msg = storage.createMessage.mock.calls[0][0];
    expect(msg.messageType).toBe('chat');
    expect(msg.channel).toBe('chat:forge-sage');
    expect(msg.fromAgent).toBe('sage');
    expect(msg.toAgent).toBe('forge');
    expect(msg.body).toBe('hey');
  });

  test('uses provided channel if given', async () => {
    const storage = createMockStorage();
    await sendChat(storage, { from: 'sage', to: 'forge', message: 'hi', channel: 'chat:custom' });
    expect(storage.createMessage.mock.calls[0][0].channel).toBe('chat:custom');
  });

  test('passes clusterId for cluster chats', async () => {
    const storage = createMockStorage();
    await sendChat(storage, { from: 'sage', to: 'forge', message: 'hi', clusterId: 'cluster_1' });
    expect(storage.createMessage.mock.calls[0][0].clusterId).toBe('cluster_1');
  });
});

describe('getChatHistory', () => {
  test('queries with sorted channel name', async () => {
    const storage = createMockStorage();
    await getChatHistory(storage, 'sage', 'forge');
    expect(storage.getMessages).toHaveBeenCalledWith({ channel: 'chat:forge-sage' });
  });
});

describe('getClusterMessages', () => {
  test('queries by clusterId', async () => {
    const storage = createMockStorage();
    await getClusterMessages(storage, 'cluster_1');
    expect(storage.getMessages).toHaveBeenCalledWith({ clusterId: 'cluster_1' });
  });
});

describe('createCluster', () => {
  test('creates cluster with defaults', async () => {
    const storage = createMockStorage();
    const cluster = await createCluster(storage, { members: ['sage', 'forge'], topic: 'auth' });
    expect(cluster.clusterId).toMatch(/^cluster_/);
    expect(cluster.members).toEqual(['sage', 'forge']);
    expect(cluster.topic).toBe('auth');
    expect(cluster.status).toBe('active');
    expect(cluster.zone).toBe('bar');
    expect(storage.createCluster).toHaveBeenCalledTimes(1);
  });

  test('uses provided clusterId', async () => {
    const storage = createMockStorage();
    const cluster = await createCluster(storage, { clusterId: 'custom_id', members: [] });
    expect(cluster.clusterId).toBe('custom_id');
  });
});

describe('getCluster', () => {
  test('delegates to storage', async () => {
    const storage = createMockStorage();
    const expected = { clusterId: 'c1', status: 'active' };
    storage.getCluster.mockResolvedValue(expected);
    const result = await getCluster(storage, 'c1');
    expect(result).toEqual(expected);
    expect(storage.getCluster).toHaveBeenCalledWith('c1');
  });
});

describe('addMember', () => {
  test('adds a new member', async () => {
    const storage = createMockStorage();
    storage.getCluster.mockResolvedValue({ clusterId: 'c1', members: ['sage'], status: 'active' });
    const result = await addMember(storage, 'c1', 'forge');
    expect(result.members).toEqual(['sage', 'forge']);
    expect(storage.updateCluster).toHaveBeenCalledWith('c1', { members: ['sage', 'forge'] });
  });

  test('does not duplicate existing member', async () => {
    const storage = createMockStorage();
    storage.getCluster.mockResolvedValue({ clusterId: 'c1', members: ['sage'], status: 'active' });
    const result = await addMember(storage, 'c1', 'sage');
    expect(result.members).toEqual(['sage']);
    expect(storage.updateCluster).not.toHaveBeenCalled();
  });

  test('throws CLUSTER_NOT_FOUND for missing cluster', async () => {
    const storage = createMockStorage();
    await expect(addMember(storage, 'missing', 'sage')).rejects.toMatchObject({ code: 'CLUSTER_NOT_FOUND' });
  });
});

describe('removeMember', () => {
  test('removes a member', async () => {
    const storage = createMockStorage();
    storage.getCluster.mockResolvedValue({ clusterId: 'c1', members: ['sage', 'forge'], status: 'active' });
    const result = await removeMember(storage, 'c1', 'forge');
    expect(result.members).toEqual(['sage']);
    expect(storage.updateCluster).toHaveBeenCalledWith('c1', { members: ['sage'] });
  });

  test('dissolves cluster when last member leaves', async () => {
    const storage = createMockStorage();
    storage.getCluster.mockResolvedValue({ clusterId: 'c1', members: ['sage'], status: 'active' });
    const result = await removeMember(storage, 'c1', 'sage');
    expect(result.members).toEqual([]);
    expect(result.status).toBe('dissolved');
    expect(storage.updateCluster).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'dissolved', members: [] }));
  });

  test('throws CLUSTER_NOT_FOUND for missing cluster', async () => {
    const storage = createMockStorage();
    await expect(removeMember(storage, 'missing', 'sage')).rejects.toMatchObject({ code: 'CLUSTER_NOT_FOUND' });
  });
});

describe('dissolveCluster', () => {
  test('dissolves an existing cluster', async () => {
    const storage = createMockStorage();
    storage.getCluster.mockResolvedValue({ clusterId: 'c1', members: ['sage'], status: 'active' });
    const result = await dissolveCluster(storage, 'c1');
    expect(result.status).toBe('dissolved');
    expect(storage.updateCluster).toHaveBeenCalledWith('c1', expect.objectContaining({ status: 'dissolved' }));
  });

  test('throws CLUSTER_NOT_FOUND for missing cluster', async () => {
    const storage = createMockStorage();
    await expect(dissolveCluster(storage, 'missing')).rejects.toMatchObject({ code: 'CLUSTER_NOT_FOUND' });
  });
});
