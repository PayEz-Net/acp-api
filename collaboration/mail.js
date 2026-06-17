export async function sendMail(storage, msg) {
  return storage.createMessage({
    messageType: 'mail',
    channel: null,
    fromAgent: msg.from,
    toAgent: msg.to,
    subject: msg.subject,
    body: msg.body,
    priority: msg.priority || 'normal',
    keywords: msg.keywords || [],
    createdAt: msg.createdAt || new Date().toISOString(),
  });
}

/**
 * #64 GAP 4: live mail sender for SYSTEM notifications (kanban status/review
 * transitions). The legacy sendMail() above calls storage.createMessage, which
 * was DROPPED in a storage refactor (SessionManager has no such method) — it
 * throws, so ->review/->done notifications silently no-op and stranded finished
 * cards (#59/#61/#63/#65; #62 was the workaround). This sender POSTs to the local
 * mail API — the same /v1/mail/send proxy the desktop uses, which delivers via the
 * cloud agentmail path — exactly mirroring the supervisor.js _sendPing fix.
 * Returns a fn matching the (storage, msg) mailSender contract; storage is ignored.
 */
export function makeApiMailSender(port = Number(process.env.PORT) || 3001) {
  return async function sendMailViaApi(_storage, msg) {
    const fromAgent = msg.from || 'system';
    const res = await fetch(`http://127.0.0.1:${port}/v1/mail/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-ACP-Agent': fromAgent },
      body: JSON.stringify({
        from_agent: fromAgent,
        to: Array.isArray(msg.to) ? msg.to : [msg.to],
        subject: msg.subject,
        body: msg.body,
        importance: msg.priority || 'normal',
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`mail API ${res.status}: ${text.slice(0, 200)}`);
    }
    return res.json();
  };
}

export async function getInbox(storage, agentName, opts = {}) {
  const filter = { toAgent: agentName, messageType: 'mail', isArchived: false };
  if (opts.unreadOnly) filter.isRead = false;
  return storage.getMessages(filter, opts.sort);
}

export async function getMail(storage, id) {
  return storage.getMessageById(id);
}

export async function markRead(storage, id) {
  await storage.markRead(id);
}

export async function markAllRead(storage, agentName) {
  await storage.markAllRead(agentName);
}

export async function archiveMail(storage, id) {
  await storage.archiveMessage(id);
}

export function priorityOrder(mails) {
  const order = { urgent: 0, high: 1, normal: 2, low: 3 };
  return [...mails].sort((a, b) => (order[a.priority] ?? 2) - (order[b.priority] ?? 2));
}
