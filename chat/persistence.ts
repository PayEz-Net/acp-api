// Phase 1: Stub chat persistence - no VibeSQL dependency
// Chat data is not persisted, stored in memory only

export class VibeQueryClient {
  private url: string;
  private secret: string | undefined;

  constructor(config: { vibesqlDirectUrl: string; vibesqlContainerSecret?: string }) {
    // Stub - no actual connection
    this.url = config.vibesqlDirectUrl || 'http://localhost';
    this.secret = config.vibesqlContainerSecret;
  }

  async query(_sql: string): Promise<any> {
    // Stub - returns empty result
    return { rows: [], rowCount: 0 };
  }
}

// In-memory storage for chat data
const memoryStore = {
  conversations: new Map<string, any>(),
  threads: new Map<string, any>(),
  messages: new Map<string, any[]>(),
  participants: new Map<string, any[]>(),
};

let idCounter = 1;
function generateId(): string {
  return `chat_${Date.now()}_${idCounter++}`;
}

export class ChatPersistence {
  private db: VibeQueryClient;

  constructor(db: VibeQueryClient) {
    this.db = db;
  }

  async createConversation(data: { title: string; type: string; projectId?: string | null; metadata?: any; state?: string }): Promise<any> {
    const id = generateId();
    const conv = {
      id,
      title: data.title,
      type: data.type,
      project_id: data.projectId || null,
      metadata: data.metadata || {},
      state: data.state || 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memoryStore.conversations.set(id, conv);
    return conv;
  }

  async createThread(data: { conversationId: string; slug: string; subject: string; metadata?: any }): Promise<any> {
    const id = generateId();
    const thread = {
      id,
      conversation_id: data.conversationId,
      slug: data.slug,
      subject: data.subject,
      metadata: data.metadata || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    memoryStore.threads.set(id, thread);
    return thread;
  }

  async addMessage(data: { threadId: string; senderId: string; senderType: string; content: string; contentType?: string; metadata?: any }): Promise<any> {
    const id = generateId();
    const msg = {
      id,
      thread_id: data.threadId,
      sender_id: data.senderId,
      sender_type: data.senderType,
      content: data.content,
      content_type: data.contentType || 'text',
      metadata: data.metadata || {},
      created_at: new Date().toISOString(),
    };
    
    const threadMessages = memoryStore.messages.get(data.threadId) || [];
    threadMessages.push(msg);
    memoryStore.messages.set(data.threadId, threadMessages);
    
    return msg;
  }

  async addParticipant(conversationId: string, participant: { participantId: string; participantType: string; displayName: string }): Promise<any> {
    const p = {
      conversation_id: conversationId,
      participant_id: participant.participantId,
      participant_type: participant.participantType,
      display_name: participant.displayName,
      joined_at: new Date().toISOString(),
    };
    
    const participants = memoryStore.participants.get(conversationId) || [];
    participants.push(p);
    memoryStore.participants.set(conversationId, participants);
    
    return p;
  }

  async getConversation(id: string): Promise<any | null> {
    return memoryStore.conversations.get(id) || null;
  }

  async getThread(id: string): Promise<any | null> {
    return memoryStore.threads.get(id) || null;
  }

  async getMessages(threadId: string, beforeOrLimit?: string | number, limit?: number): Promise<any[]> {
    // Stub - accepts (threadId) or (threadId, before, limit) signatures
    const messages = memoryStore.messages.get(threadId) || [];
    
    // If before (cursor) is provided, filter messages before that id
    if (typeof beforeOrLimit === 'string' && beforeOrLimit) {
      const beforeIndex = messages.findIndex((m: any) => m.id === beforeOrLimit);
      if (beforeIndex >= 0) {
        return messages.slice(0, beforeIndex).slice(-(limit || 50));
      }
    }
    
    // If limit is provided as second arg
    if (typeof beforeOrLimit === 'number') {
      return messages.slice(0, beforeOrLimit);
    }
    
    return messages;
  }

  async getParticipants(conversationId: string): Promise<any[]> {
    return memoryStore.participants.get(conversationId) || [];
  }

  async listConversations(_filters?: any): Promise<any[]> {
    return Array.from(memoryStore.conversations.values());
  }

  async updateConversation(id: string, updates: Partial<{ title: string; metadata: any }>): Promise<any | null> {
    const conv = memoryStore.conversations.get(id);
    if (!conv) return null;
    
    if (updates.title) conv.title = updates.title;
    if (updates.metadata) conv.metadata = { ...conv.metadata, ...updates.metadata };
    conv.updated_at = new Date().toISOString();
    
    return conv;
  }

  async deleteConversation(id: string): Promise<boolean> {
    return memoryStore.conversations.delete(id);
  }

  // Additional stub methods for compatibility
  async sendMessage(_data: any): Promise<any> {
    return { id: generateId(), delivered: true };
  }

  async trackDelivery(_messageId: string, _status: string, _metadata?: any): Promise<void> {
    // Stub - no-op
  }

  async removeParticipant(_conversationId: string, _participantId: string): Promise<boolean> {
    // Stub - always returns true
    return true;
  }

  async setSubscription(_conversationId: string, _participantId: string, _subscribed: boolean | string): Promise<void> {
    // Stub - no-op
  }

  async getThreadActivity(threadIdsOrAgent: string[] | string): Promise<any[]> {
    // Stub - accepts string or string[], returns empty array
    return [];
  }

  async getUnreadCounts(conversationIdsOrAgent: string[] | string, _participantId?: string): Promise<Record<string, number>> {
    // Stub - accepts various arg patterns, returns empty object
    return {};
  }

  async getConversationsByIds(ids: string[]): Promise<any[]> {
    // Stub - returns matching conversations from memory
    return ids.map(id => memoryStore.conversations.get(id)).filter(Boolean);
  }
}
