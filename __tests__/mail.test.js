import { jest } from '@jest/globals';
import {
  sendMail, getInbox, getMail, markRead, markAllRead, archiveMail, priorityOrder,
} from '../collaboration/mail.js';

function createMockStorage() {
  return {
    createMessage: jest.fn(async () => 42),
    getMessages: jest.fn(async () => []),
    getMessageById: jest.fn(async () => null),
    markRead: jest.fn(async () => {}),
    markAllRead: jest.fn(async () => {}),
    archiveMessage: jest.fn(async () => {}),
  };
}

describe('sendMail', () => {
  test('creates a mail message', async () => {
    const storage = createMockStorage();
    const id = await sendMail(storage, {
      from: 'BAPert',
      to: 'DotNetPert',
      subject: 'Task: Login',
      body: 'Please implement login',
      priority: 'high',
    });
    expect(id).toBe(42);
    const msg = storage.createMessage.mock.calls[0][0];
    expect(msg.messageType).toBe('mail');
    expect(msg.fromAgent).toBe('BAPert');
    expect(msg.toAgent).toBe('DotNetPert');
    expect(msg.subject).toBe('Task: Login');
    expect(msg.body).toBe('Please implement login');
    expect(msg.priority).toBe('high');
  });

  test('defaults priority to normal', async () => {
    const storage = createMockStorage();
    await sendMail(storage, { from: 'A', to: 'B', subject: 'Hi', body: 'Hello' });
    expect(storage.createMessage.mock.calls[0][0].priority).toBe('normal');
  });
});

describe('getInbox', () => {
  test('queries for mail to agent, not archived', async () => {
    const storage = createMockStorage();
    await getInbox(storage, 'BAPert');
    expect(storage.getMessages).toHaveBeenCalledWith(
      {
        toAgent: 'BAPert',
        messageType: 'mail',
        isArchived: false,
      },
      undefined,
    );
  });

  test('unreadOnly adds isRead filter', async () => {
    const storage = createMockStorage();
    await getInbox(storage, 'BAPert', { unreadOnly: true });
    expect(storage.getMessages).toHaveBeenCalledWith(
      {
        toAgent: 'BAPert',
        messageType: 'mail',
        isArchived: false,
        isRead: false,
      },
      undefined,
    );
  });
});

describe('getMail', () => {
  test('returns message by id', async () => {
    const storage = createMockStorage();
    const mail = { id: 5, subject: 'Test', body: 'Hello' };
    storage.getMessageById.mockResolvedValue(mail);
    const result = await getMail(storage, 5);
    expect(result).toEqual(mail);
    expect(storage.getMessageById).toHaveBeenCalledWith(5);
  });

  test('returns null when not found', async () => {
    const storage = createMockStorage();
    storage.getMessageById.mockResolvedValue(null);
    const result = await getMail(storage, 999);
    expect(result).toBeNull();
    expect(storage.getMessageById).toHaveBeenCalledWith(999);
  });
});

describe('markRead', () => {
  test('delegates to storage', async () => {
    const storage = createMockStorage();
    await markRead(storage, 5);
    expect(storage.markRead).toHaveBeenCalledWith(5);
  });
});

describe('markAllRead', () => {
  test('delegates to storage', async () => {
    const storage = createMockStorage();
    await markAllRead(storage, 'BAPert');
    expect(storage.markAllRead).toHaveBeenCalledWith('BAPert');
  });
});

describe('archiveMail', () => {
  test('delegates to storage', async () => {
    const storage = createMockStorage();
    await archiveMail(storage, 5);
    expect(storage.archiveMessage).toHaveBeenCalledWith(5);
  });
});

describe('priorityOrder', () => {
  test('sorts by priority: urgent > high > normal > low', () => {
    const mails = [
      { id: 1, priority: 'low' },
      { id: 2, priority: 'urgent' },
      { id: 3, priority: 'normal' },
      { id: 4, priority: 'high' },
    ];
    const sorted = priorityOrder(mails);
    expect(sorted.map((m) => m.id)).toEqual([2, 4, 3, 1]);
  });

  test('does not mutate original array', () => {
    const mails = [{ id: 1, priority: 'low' }, { id: 2, priority: 'high' }];
    const sorted = priorityOrder(mails);
    expect(mails[0].id).toBe(1);
    expect(sorted[0].id).toBe(2);
  });
});
