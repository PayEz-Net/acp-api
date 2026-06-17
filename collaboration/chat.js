import { randomUUID } from 'node:crypto';

export async function sendChat(storage, msg) {
  const channel = msg.channel || `chat:${[msg.from, msg.to].sort().join('-')}`;
  return storage.createMessage({
    messageType: 'chat',
    channel,
    clusterId: msg.clusterId || null,
    fromAgent: msg.from,
    toAgent: msg.to,
    body: msg.message || msg.body,
    keywords: msg.keywords || [],
    createdAt: msg.timestamp || new Date().toISOString(),
  });
}

export async function getChatHistory(storage, agentA, agentB) {
  const channel = `chat:${[agentA, agentB].sort().join('-')}`;
  return storage.getMessages({ channel });
}

export async function getClusterMessages(storage, clusterId) {
  return storage.getMessages({ clusterId });
}

export async function createCluster(storage, opts) {
  const cluster = {
    clusterId: opts.clusterId || `cluster_${randomUUID()}`,
    topic: opts.topic || null,
    members: opts.members || [],
    status: 'active',
    zone: opts.zone || 'bar',
    formedAt: opts.formedAt || new Date().toISOString(),
  };
  await storage.createCluster(cluster);
  return cluster;
}

export async function getCluster(storage, clusterId) {
  return storage.getCluster(clusterId);
}

export async function addMember(storage, clusterId, agentId) {
  const cluster = await storage.getCluster(clusterId);
  if (!cluster) {
    const err = new Error(`Cluster "${clusterId}" not found`);
    err.code = 'CLUSTER_NOT_FOUND';
    throw err;
  }
  const members = cluster.members || [];
  if (!members.includes(agentId)) {
    members.push(agentId);
    await storage.updateCluster(clusterId, { members });
  }
  return { ...cluster, members };
}

export async function removeMember(storage, clusterId, agentId) {
  const cluster = await storage.getCluster(clusterId);
  if (!cluster) {
    const err = new Error(`Cluster "${clusterId}" not found`);
    err.code = 'CLUSTER_NOT_FOUND';
    throw err;
  }
  const members = (cluster.members || []).filter((m) => m !== agentId);
  if (members.length === 0) {
    await storage.updateCluster(clusterId, { status: 'dissolved', members, dissolvedAt: new Date().toISOString() });
    return { ...cluster, members, status: 'dissolved' };
  }
  await storage.updateCluster(clusterId, { members });
  return { ...cluster, members };
}

export async function dissolveCluster(storage, clusterId) {
  const cluster = await storage.getCluster(clusterId);
  if (!cluster) {
    const err = new Error(`Cluster "${clusterId}" not found`);
    err.code = 'CLUSTER_NOT_FOUND';
    throw err;
  }
  await storage.updateCluster(clusterId, { status: 'dissolved', dissolvedAt: new Date().toISOString() });
  return { ...cluster, status: 'dissolved' };
}
