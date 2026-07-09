import { describe, it, expect, beforeEach } from '@jest/globals';
import { AgentDocumentStore } from '../agentDocumentStore.js';

describe('AgentDocumentStore (in-memory fallback)', () => {
  let store: AgentDocumentStore;

  beforeEach(() => {
    store = new AgentDocumentStore();
    // Force fallback path even if VIBESQL_URL is present in the outer env.
    (store as any).vibeSqlUrl = null;
    (store as any).vibeSqlSecret = null;
  });

  it('creates and retrieves a document', async () => {
    const doc = await store.createDocument({
      title: 'Test Doc',
      content_md: '# Hello',
      type: 'spec',
      agentName: 'BAPert',
      clientId: 1,
      userId: 42,
    });

    expect(doc.id).toBe(1);
    expect(doc.title).toBe('Test Doc');
    expect(doc.type).toBe('spec');
    expect(doc.author_agent).toBe('BAPert');

    const fetched = await store.getDocument(doc.id, { clientId: 1 });
    expect(fetched).not.toBeNull();
    expect(fetched?.title).toBe('Test Doc');
  });

  it('lists documents with project and agent filters', async () => {
    await store.createDocument({ title: 'A', content_md: 'a', project_id: 1, agentName: 'BAPert' });
    await store.createDocument({ title: 'B', content_md: 'b', project_id: 1, agentName: 'NextPert' });
    await store.createDocument({ title: 'C', content_md: 'c', project_id: 2, agentName: 'BAPert' });

    const all = await store.listDocuments();
    expect(all).toHaveLength(3);

    const p1 = await store.listDocuments({ project_id: 1 });
    expect(p1).toHaveLength(2);

    const bapert = await store.listDocuments({ agentName: 'BAPert' });
    expect(bapert).toHaveLength(2);

    const scoped = await store.listDocuments({ project_id: 1, agentName: 'NextPert' });
    expect(scoped).toHaveLength(1);
    expect(scoped[0].title).toBe('B');
  });

  it('scopes get/update/delete by agent', async () => {
    const doc = await store.createDocument({
      title: 'Scoped',
      content_md: 'x',
      agentName: 'BAPert',
      clientId: 1,
    });

    // Another agent cannot see or mutate it.
    expect(await store.getDocument(doc.id, { clientId: 1, agentName: 'NextPert' })).toBeNull();
    expect(await store.updateDocument(doc.id, { title: 'Hacked', agentName: 'NextPert' })).toBeNull();
    expect(await store.deleteDocument(doc.id, { clientId: 1, agentName: 'NextPert' })).toBe(false);

    // The owning agent can.
    const updated = await store.updateDocument(doc.id, { title: 'Updated', agentName: 'BAPert' });
    expect(updated).not.toBeNull();
    expect(updated?.title).toBe('Updated');
    expect(updated?.version).toBe(2);

    expect(await store.deleteDocument(doc.id, { clientId: 1, agentName: 'BAPert' })).toBe(true);
    expect(await store.getDocument(doc.id, { clientId: 1 })).toBeNull();
  });

  it('increments version on update', async () => {
    const doc = await store.createDocument({ title: 'V1', content_md: 'v1', agentName: 'BAPert' });
    const v2 = await store.updateDocument(doc.id, { content_md: 'v2', agentName: 'BAPert' });
    expect(v2?.version).toBe(2);
  });
});
