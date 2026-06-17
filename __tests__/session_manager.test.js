import { jest } from '@jest/globals';
import { SessionManager } from '../agents/session_manager.js';

const mockSession = {
  sessionId: 'sess_test',
  agentName: 'TestAgent',
  character: 'sage',
  customFunctions: {},
  preferences: {},
  memory: {},
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  version: 1,
};

describe('SessionManager', () => {
  let manager;

  beforeEach(() => {
    manager = new SessionManager({ vibesqlUrl: 'http://localhost:5173' });
  });

  test('load returns null when session not found', async () => {
    const result = await manager.load('NonExistent');
    expect(result).toBeNull();
  });

  test('load returns session from memory with correct source', async () => {
    await manager.save(mockSession);
    const result = await manager.load('TestAgent');
    expect(result).not.toBeNull();
    expect(result.source).toBe('memory');
    expect(result.session.agentName).toBe('TestAgent');
  });

  test('save returns savedTo with memory', async () => {
    const result = await manager.save(mockSession);
    expect(result.savedTo).toContain('memory');
  });

  test('delete removes session from memory', async () => {
    await manager.save(mockSession);
    expect(await manager.load('TestAgent')).not.toBeNull();
    await manager.delete('TestAgent');
    expect(await manager.load('TestAgent')).toBeNull();
  });

  test('list returns sessions from memory', async () => {
    await manager.save(mockSession);
    const result = await manager.list();
    expect(result).toHaveLength(1);
    expect(result[0].agentName).toBe('TestAgent');
  });

  test('exposes storage adapter via getter', () => {
    expect(manager.storage).toBeDefined();
  });

  test('getAgentRegistration returns registered agent', async () => {
    const result = await manager.getAgentRegistration('agent:DotNetPert');
    expect(result).not.toBeNull();
    expect(result.name).toBe('DotNetPert');
  });

  test('getAgentRegistration returns null for unknown agent', async () => {
    const result = await manager.getAgentRegistration('agent:Unknown');
    expect(result).toBeNull();
  });

  describe('documents', () => {
    test('createDocument returns doc with id and timestamps', async () => {
      const doc = await manager.createDocument({
        project_id: 14,
        title: 'Test Doc',
        content_md: '# Hello',
        type: 'context',
        version: '1.0',
      });
      expect(doc.id).toBeDefined();
      expect(doc.project_id).toBe(14);
      expect(doc.title).toBe('Test Doc');
      expect(doc.created_at).toBeDefined();
      expect(doc.updated_at).toBeDefined();
    });

    test('listDocuments returns all docs without filter', async () => {
      await manager.createDocument({ project_id: 14, title: 'A', content_md: 'a' });
      await manager.createDocument({ project_id: 15, title: 'B', content_md: 'b' });
      const docs = await manager.listDocuments();
      expect(docs.length).toBeGreaterThanOrEqual(2);
    });

    test('listDocuments filters by project_id', async () => {
      await manager.createDocument({ project_id: 99, title: 'Project 99', content_md: 'x' });
      const docs = await manager.listDocuments({ project_id: 99 });
      expect(docs).toHaveLength(1);
      expect(docs[0].title).toBe('Project 99');
    });

    test('getDocument returns doc by id', async () => {
      const created = await manager.createDocument({ title: 'Get Me', content_md: 'body' });
      const found = await manager.getDocument(created.id);
      expect(found).not.toBeNull();
      expect(found.title).toBe('Get Me');
    });

    test('getDocument returns null for missing id', async () => {
      const found = await manager.getDocument(99999);
      expect(found).toBeNull();
    });

    test('updateDocument patches fields', async () => {
      const created = await manager.createDocument({ title: 'Old', content_md: 'old' });
      const updated = await manager.updateDocument(created.id, { title: 'New' });
      expect(updated.title).toBe('New');
      expect(updated.content_md).toBe('old'); // unchanged
    });

    test('updateDocument returns null for missing id', async () => {
      const result = await manager.updateDocument(99999, { title: 'Nope' });
      expect(result).toBeNull();
    });

    test('deleteDocument removes doc', async () => {
      const created = await manager.createDocument({ title: 'Delete Me', content_md: 'x' });
      const deleted = await manager.deleteDocument(created.id);
      expect(deleted).toBe(true);
      expect(await manager.getDocument(created.id)).toBeNull();
    });

    test('deleteDocument returns false for missing id', async () => {
      const result = await manager.deleteDocument(99999);
      expect(result).toBe(false);
    });
  });
});
