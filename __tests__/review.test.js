import { jest } from '@jest/globals';
import { reviewTask, autoMailOnStatusChange } from '../kanban/review.js';

function createMockStorage() {
  return {
    getTask: jest.fn(async () => null),
    updateTask: jest.fn(async () => {}),
  };
}

const reviewableTask = {
  id: 5,
  title: 'Login page',
  status: 'review',
  assignedTo: 'DotNetPert',
  createdBy: 'BAPert',
  specPath: 'specs/login.md',
};

describe('reviewTask', () => {
  test('approve moves to done and sends mail', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...reviewableTask });
    const mailSender = jest.fn(async () => {});
    const result = await reviewTask(storage, mailSender, 5, 'approve', { reviewer: 'QAPert', notes: 'Looks good' });
    expect(result.status).toBe('done');
    expect(result.reviewedBy).toBe('QAPert');
    expect(result.completedAt).toBeTruthy();
    const call = storage.updateTask.mock.calls[0];
    expect(call[0]).toBe(5);
    expect(call[1]).toMatchObject({ status: 'done' });
    expect(mailSender).toHaveBeenCalledTimes(2);
    const assigneeMail = mailSender.mock.calls[0][1];
    expect(assigneeMail.to).toBe('DotNetPert');
    expect(assigneeMail.subject).toContain('APPROVED');
    const creatorMail = mailSender.mock.calls[1][1];
    expect(creatorMail.to).toBe('BAPert');
    expect(creatorMail.subject).toContain('DONE');
  });

  test('reject moves to in_progress and sends mail', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...reviewableTask });
    const mailSender = jest.fn(async () => {});
    const result = await reviewTask(storage, mailSender, 5, 'reject', { notes: 'Missing tests' });
    expect(result.status).toBe('in_progress');
    expect(result.reviewNotes).toBe('Missing tests');
    expect(mailSender).toHaveBeenCalledTimes(1);
    expect(mailSender.mock.calls[0][1].priority).toBe('high');
  });

  test('comment updates notes without changing status', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...reviewableTask });
    const result = await reviewTask(storage, null, 5, 'comment', { notes: 'Check line 42' });
    expect(result.status).toBe('review');
    expect(result.reviewNotes).toBe('Check line 42');
  });

  test('throws if task not in review', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...reviewableTask, status: 'in_progress' });
    await expect(reviewTask(storage, null, 5, 'approve')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('throws for invalid action', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...reviewableTask });
    await expect(reviewTask(storage, null, 5, 'invalid')).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  test('approve skips creator mail if same as assignee', async () => {
    const storage = createMockStorage();
    storage.getTask.mockResolvedValue({ ...reviewableTask, createdBy: 'DotNetPert' });
    const mailSender = jest.fn(async () => {});
    await reviewTask(storage, mailSender, 5, 'approve');
    expect(mailSender).toHaveBeenCalledTimes(1);
  });
});

describe('autoMailOnStatusChange', () => {
  test('sends review mail to QAPert', async () => {
    const storage = createMockStorage();
    const mailSender = jest.fn(async () => {});
    await autoMailOnStatusChange(storage, mailSender, reviewableTask, 'review');
    expect(mailSender).toHaveBeenCalledTimes(1);
    const mail = mailSender.mock.calls[0][1];
    expect(mail.to).toBe('QAPert');
    expect(mail.subject).toContain('REVIEW');
    expect(mail.priority).toBe('high');
  });

  test('sends blocked mail to creator', async () => {
    const storage = createMockStorage();
    const mailSender = jest.fn(async () => {});
    await autoMailOnStatusChange(storage, mailSender, { ...reviewableTask, blockers: 'API down' }, 'blocked');
    const mail = mailSender.mock.calls[0][1];
    expect(mail.to).toBe('BAPert');
    expect(mail.subject).toContain('BLOCKED');
    expect(mail.priority).toBe('urgent');
  });

  test('sends done mail to creator', async () => {
    const storage = createMockStorage();
    const mailSender = jest.fn(async () => {});
    await autoMailOnStatusChange(storage, mailSender, reviewableTask, 'done');
    const mail = mailSender.mock.calls[0][1];
    expect(mail.to).toBe('BAPert');
    expect(mail.subject).toContain('DONE');
  });

  test('does nothing without mailSender', async () => {
    const storage = createMockStorage();
    await autoMailOnStatusChange(storage, null, reviewableTask, 'review');
  });
});
