import { jest } from '@jest/globals';
import { createTask, getTask, listTasks, moveTask, assignTask, editTask, archiveTask, addComment, TRANSITIONS } from '../kanban/board.js';

function createMockStorage() {
  return {
    createTask: jest.fn(async () => 1),
    getTask: jest.fn(async () => null),
    listTasks: jest.fn(async () => []),
    updateTask: jest.fn(async (_id, updates) => ({ id: 1, ...updates })),
    appendKanbanActivity: jest.fn(async () => 1),
    addKanbanComment: jest.fn(async (c) => ({ comment_id: 1, ...c })),
    listKanbanComments: jest.fn(async () => []),
    listKanbanActivity: jest.fn(async () => []),
  };
}

const sampleTask = {
  id: 1,
  title: 'Login page',
  status: 'backlog',
  priority: 'medium',
  assignedTo: null,
  createdBy: 'BAPert',
};

describe('createTask', () => {
  test('creates task with defaults', async () => {
    const storage = createMockStorage();
    const id = await createTask(storage, { title: 'Login page', createdBy: 'BAPert' });
    expect(id).toBe(1);
    const t = storage.createTask.mock.calls[0][0];
    expect(t.title).toBe('Login page');
    expect(t.status).toBe('backlog');
    expect(t.priority).toBe('medium');
  });

  test('throws INVALID_REQUEST without title', async () => {
    const storage = createMockStorage();
    await expect(createTask(storage, {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('getTask', () => {
  test('returns task by id', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue(sampleTask);
    const task = await getTask(storage, 1);
    expect(task.title).toBe('Login page');
  });

  test('throws TASK_NOT_FOUND for missing task', async () => {
    const storage = createMockStorage();
    await expect(getTask(storage, 999)).rejects.toMatchObject({ code: 'TASK_NOT_FOUND' });
  });
});

describe('listTasks', () => {
  test('delegates to storage with filter', async () => {
    const storage = createMockStorage();
    await listTasks(storage, { status: 'review' });
    expect(storage.listTasks).toHaveBeenCalledWith({ status: 'review' });
  });
});

describe('moveTask', () => {
  test('moves backlog to in_progress', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await moveTask(storage, 1, 'in_progress');
    expect(result.status).toBe('in_progress');
    const call = storage.updateTask.mock.calls[0];
    expect(call[0]).toBe(1);
    expect(call[1]).toMatchObject({ status: 'in_progress' });
  });

  test('sets completedAt when moving to done', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'review' });
    const result = await moveTask(storage, 1, 'done');
    expect(result.completedAt).toBeTruthy();
  });

  test('rejects invalid transition', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'backlog' });
    await expect(moveTask(storage, 1, 'done')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  // #64 v1.1: done is NO LONGER terminal — done->in_progress/review reopen (clears completedAt).
  test('reopens from done (done->in_progress), clearing completedAt', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done', completedAt: '2026-01-01T00:00:00Z' });
    const result = await moveTask(storage, 1, 'in_progress');
    expect(result.status).toBe('in_progress');
    expect(storage.updateTask.mock.calls[0][1]).toMatchObject({ status: 'in_progress', completedAt: null });
  });

  test('rejects an ILLEGAL agent edge without force (done->backlog)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done' });
    await expect(moveTask(storage, 1, 'backlog')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('force allows an off-graph move (done->backlog) and audits it', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'done' });
    const result = await moveTask(storage, 1, 'backlog', { force: true, actor: 'jon' });
    expect(result.status).toBe('backlog');
  });

  test('rejects retired status `todo`', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, status: 'backlog' });
    await expect(moveTask(storage, 1, 'todo')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('assignTask', () => {
  test('assigns agent to task', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.assignedTo).toBe('DotNetPert');
    const call = storage.updateTask.mock.calls[0];
    expect(call[0]).toBe(1);
    expect(call[1]).toMatchObject({ assignedTo: 'DotNetPert' });
  });
});

describe('editTask (G1)', () => {
  test('edits free-form fields + audits', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const result = await editTask(storage, 1, { title: 'New title', priority: 'high' }, 'jon');
    expect(result.title).toBe('New title');
    expect(storage.updateTask.mock.calls[0][1]).toMatchObject({ title: 'New title', priority: 'high' });
    expect(storage.appendKanbanActivity).toHaveBeenCalled();
  });

  test('rejects editing status via PATCH (guarded endpoint)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { status: 'done' }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('rejects editing assignee via PATCH', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { assignedTo: 'X' }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('rejects unknown field (no silent drop)', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { bogus: 1 }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('rejects invalid priority', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(editTask(storage, 1, { priority: 'urgent' }, 'jon')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });
});

describe('comments + archive (G3/G5)', () => {
  test('addComment rejects empty body', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    await expect(addComment(storage, 1, { body_md: '  ' }, null)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('addComment persists + audits', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const c = await addComment(storage, 1, { body_md: 'a note', author: 'jon' }, null);
    expect(c.comment_id).toBe(1);
    expect(storage.appendKanbanActivity).toHaveBeenCalled();
  });

  test('archiveTask sets archived + audits', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask });
    const r = await archiveTask(storage, 1, true, 'jon');
    expect(r.archived).toBe(true);
    expect(storage.updateTask.mock.calls[0][1]).toMatchObject({ archived: true });
  });

  // #109: previousAssignee exposed for the reassigned-vs-assigned activity distinction
  test('first-assign (no prior owner) -> previousAssignee null', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, assignedTo: null });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.previousAssignee).toBeNull();
    expect(result.assignedTo).toBe('DotNetPert');
  });

  test('reassign (prior owner) -> previousAssignee = old owner', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...sampleTask, assignedTo: 'QAPert' });
    const result = await assignTask(storage, 1, 'DotNetPert');
    expect(result.previousAssignee).toBe('QAPert');
    expect(result.assignedTo).toBe('DotNetPert');
  });
});

// RECONCILE NOTE: #152's standalone archiveTask/unarchiveTask tests (2-arg archive +
// separate unarchiveTask + idempotency) were dropped — that API is superseded by #64 G5's
// parametrized archiveTask(storage,id,archived,actor,projectId), covered by the
// 'comments + archive (G3/G5)' suite above. unarchive = archiveTask(...,false).

describe('TRANSITIONS', () => {
  test('defines valid state machine', () => {
    expect(TRANSITIONS.backlog).toContain('in_progress');
    expect(TRANSITIONS.in_progress).toContain('review');
    expect(TRANSITIONS.in_progress).toContain('blocked');
    expect(TRANSITIONS.review).toContain('done');
    expect(TRANSITIONS.review).toContain('in_progress');
    expect(TRANSITIONS.blocked).toContain('in_progress');
    // #64 v1.1: done reopens (no longer terminal); `todo` retired.
    expect(TRANSITIONS.done).toEqual(['in_progress', 'review']);
    expect(TRANSITIONS.todo).toBeUndefined();
  });
});
