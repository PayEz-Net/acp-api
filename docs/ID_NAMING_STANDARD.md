# ID Naming Standard

**Rule:** Always use `table_id` format. Never use bare `id`.

## Rationale

Self-documenting code. When you see `inbox_id`, you know exactly what it refers to. When you see `id`, you have no idea.

## Correct Examples

- ✅ `message_id` - The ID of a message in the messages table
- ✅ `inbox_id` - The ID of an inbox entry (cloud API uses this)
- ✅ `agent_id` - The ID of an agent
- ✅ `contract_id` - The ID of a contract
- ✅ `thread_id` - The ID of a conversation thread

## Incorrect Examples

- ❌ `id` - Bare ID, context unclear
- ❌ `msg.id` - Shortened, unclear which table
- ❌ `m.id` - Abbreviated, unclear

## Database Schema

All tables should use:
```sql
CREATE TABLE messages (
  message_id SERIAL PRIMARY KEY,  -- ✅
  -- NOT: id SERIAL PRIMARY KEY   -- ❌
);

CREATE TABLE inbox (
  inbox_id SERIAL PRIMARY KEY,    -- ✅
  message_id INTEGER REFERENCES messages(message_id),
  agent_id INTEGER REFERENCES agents(agent_id)
);
```

## API Endpoints

```
GET /v1/messages/{message_id}        -- ✅
GET /v1/inbox/{inbox_id}             -- ✅
POST /v1/inbox/{inbox_id}/read       -- ✅

NOT:
GET /v1/messages/{id}                -- ❌
```

## JavaScript/TypeScript Code

```typescript
// ✅ Good
const message_id = msg.message_id;
const inbox_id = msg.inbox_id;
await markRead(inbox_id);

// ❌ Bad
const id = msg.id;
const msgId = m.id;
await markRead(id);
```

## Migration Path

1. New code: Use `table_id` format exclusively
2. Existing code: Refactor when touching related code
3. API responses: Include both during transition period
   ```json
   {
     "message_id": 123,
     "inbox_id": 456,
     "id": 123  // deprecated, will be removed
   }
   ```

## Cloud API Compatibility

The cloud API (idealvibe.online) uses:
- `inbox_id` for mark-read operations: `POST /v1/agentmail/inbox/{inbox_id}/read`
- `message_id` for message retrieval: `GET /v1/agentmail/messages/{message_id}`

Our code must map correctly:
- Mark read: Use `inbox_id`
- Fetch message: Use `message_id`
