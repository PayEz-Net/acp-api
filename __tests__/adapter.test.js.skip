import { createStorageAdapter } from '../storage/adapter.js';
import { VibeSqlClient } from '../storage/vibesql_client.js';

describe('createStorageAdapter', () => {
  test('returns VibeSqlClient', () => {
    const adapter = createStorageAdapter({ vibesqlUrl: 'http://localhost:5173' });
    expect(adapter).toBeInstanceOf(VibeSqlClient);
  });
});
