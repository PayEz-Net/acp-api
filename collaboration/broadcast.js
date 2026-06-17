export async function createBroadcast(storage, msg) {
  const now = new Date().toISOString();
  return storage.createMessage({
    messageType: 'broadcast',
    channel: msg.channel || 'party:general',
    fromAgent: msg.fromAgent,
    body: msg.body || msg.message,
    keywords: msg.keywords || [],
    createdAt: msg.createdAt || now,
  });
}

export async function listBroadcasts(storage, channel) {
  const filter = { messageType: 'broadcast' };
  if (channel) filter.channel = channel;
  return storage.getMessages(filter);
}

export async function feedSignalFromBroadcast(storage, broadcast) {
  const agentId = broadcast.agentId || broadcast.fromAgent;
  const agentName = broadcast.agentName || broadcast.fromAgent;
  await storage.upsertSignal({
    agentId,
    agentName,
    zone: broadcast.zone || 'bar',
    workingOn: broadcast.body || broadcast.message || null,
    keywords: broadcast.keywords || [],
    needs: broadcast.needs || [],
    offers: broadcast.offers || [],
  });
}
