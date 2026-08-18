import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

const mockEnsureValidToken = jest.fn<() => Promise<string | null>>();
const mockGetAccessToken = jest.fn<() => string | null>();
const mockGetSession = jest.fn<() => { userId: string } | null>();
const mockRequireTokenClientId = jest.fn<() => string>();

jest.unstable_mockModule('../../auth/tokenManager.js', () => ({
  ensureValidToken: mockEnsureValidToken,
  getAccessToken: mockGetAccessToken,
  getSession: mockGetSession,
  requireTokenClientId: mockRequireTokenClientId,
}));

const { AgentDocumentStore } = await import('../agentDocumentStore.js');

describe('AgentDocumentStore', () => {
  let store: InstanceType<typeof AgentDocumentStore>;
  const fetchMock = jest.fn<typeof fetch>();

  beforeEach(() => {
    store = new AgentDocumentStore();
    mockGetAccessToken.mockReturnValue('mock-token');
    mockGetSession.mockReturnValue({ userId: '42' });
    mockRequireTokenClientId.mockReturnValue('123');
    mockEnsureValidToken.mockResolvedValue('mock-token');
    (globalThis as any).fetch = fetchMock;
  });

  afterEach(() => {
    jest.clearAllMocks();
    delete (globalThis as any).fetch;
  });

  it('posts to Vibe API agent_documents table with Bearer token and X-Client-Id', async () => {
    // Product moved createDocument off the raw-SQL /v1/query lane onto the REST
    // collections API (see rest()/tablePath() in agentDocumentStore.ts); mocks and
    // assertions below match the CURRENT contract.
    fetchMock
      // listAllRows: GET table rows (drives nextLogicalId)
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({ success: true, data: [] }),
      } as any)
      // rest POST: insert the new row
      .mockResolvedValueOnce({
        ok: true,
        text: async () => JSON.stringify({
          success: true,
          data: [{
            data: {
              document_id: 1,
              title: 'T',
              content_md: 'C',
              doc_type: 'reference',
              version: 1,
              created_at: '2024-01-01T00:00:00.000Z',
            },
            created_at: '2024-01-01T00:00:00.000Z',
          }],
        }),
      } as any);

    const doc = await store.createDocument({ title: 'T', content_md: 'C' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const insertCall = fetchMock.mock.calls.find(
      (c) =>
        (c[0] as string).includes('/v1/collections/vibe_agents/tables/agent_documents') &&
        c[1]?.method === 'POST'
    );
    expect(insertCall).toBeDefined();
    expect(insertCall![1]?.headers).toMatchObject({
      Authorization: 'Bearer mock-token',
      'X-Client-Id': '123',
      'X-Vibe-Via': 'idp-proxy',
      'Content-Type': 'application/json',
    });
    expect(doc.id).toBe(1);
  });

  it('throws when VIBE_API_URL is not configured', async () => {
    (store as any).vibeApiUrl = null;
    await expect(store.createDocument({ title: 'T', content_md: 'C' }))
      .rejects.toThrow('VIBE_API_URL not configured');
  });

  it('throws when there is no active IDP session', async () => {
    mockGetAccessToken.mockReturnValue(null);
    mockEnsureValidToken.mockResolvedValue(null);
    await expect(store.createDocument({ title: 'T', content_md: 'C' }))
      .rejects.toThrow('No active IDP session');
  });
});
