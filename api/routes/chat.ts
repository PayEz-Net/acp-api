import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { ChatPersistence, VibeQueryClient } from '../../chat/persistence.js';
import type { LocalEventBus } from '../sse/localEventBus.js';
import type { Config } from '../../config.js';

export default function chatRoutes(cfg: Config, localEventBus: LocalEventBus, storage?: any): Router {
  const router = Router();
  const db = new VibeQueryClient({ vibesqlDirectUrl: cfg.vibesqlDirectUrl || 'http://localhost', vibesqlContainerSecret: cfg.vibesqlContainerSecret });
  const chat = new ChatPersistence(db);

  // POST /v1/chat/conversations — create conversation
  router.post('/conversations', async (req: Request, res: Response) => {
    try {
      const { title, type, projectId, metadata, participants } = req.body || {};
      if (!title || !type) {
        res.status(400).json(error('INVALID_REQUEST', 'title and type required', 'chat_create_conv', (req as any).requestId));
        return;
      }
      // Stamp active project_id if not explicitly provided
      const activeProjectId = projectId || (storage ? await storage.getActiveProjectId() : null);
      // Archived project guard
      if (activeProjectId && storage) {
        const project = await storage.getProject(activeProjectId);
        if (project?.status === 'archived') {
          res.status(403).json(error('PROJECT_ARCHIVED', 'Project is archived', 'chat_create_conv', (req as any).requestId));
          return;
        }
      }
      const conversation = await chat.createConversation({ title, type, projectId: activeProjectId ? String(activeProjectId) : null, metadata });

      // Add participants if provided
      if (Array.isArray(participants)) {
        for (const p of participants) {
          await chat.addParticipant(conversation.id, {
            participantId: p.participantId || p.participant_id,
            participantType: p.participantType || p.participant_type || 'agent',
            displayName: p.displayName || p.display_name || p.participantId,
          });
        }
      }

      // Create default thread
      const thread = await chat.createThread({
        conversationId: conversation.id,
        slug: 'main',
        subject: title,
      });

      res.json(success({ conversation, thread }, 'chat_create_conv', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_create_conv', (req as any).requestId));
    }
  });

  // GET /v1/chat/conversations — list conversations for agent
  router.get('/conversations', async (req: Request, res: Response) => {
    try {
      const agent = req.query.agent as string;
      if (!agent) {
        res.status(400).json(error('INVALID_REQUEST', 'agent query param required', 'chat_list_conv', (req as any).requestId));
        return;
      }
      const activity = await chat.getThreadActivity(agent);
      const unread = await chat.getUnreadCounts(agent);
      // Project scoping: filter threads by active project (post-fetch)
      let filteredActivity = activity;
      if (storage) {
        const activeProjectId = await storage.getActiveProjectId();
        if (activeProjectId) {
          const pidStr = String(activeProjectId);
          // Batch fetch conversations and filter by project (C-3: eliminates N+1)
          const convIds = [...new Set(activity.map((a: any) => a.conversationId))];
          if (convIds.length > 0) {
            const convs = await chat.getConversationsByIds(convIds);
            const projectConvs = new Set<string>(
              convs
                .filter((c: any) => !c.projectId || c.projectId === pidStr)
                .map((c: any) => c.id)
            );
            filteredActivity = activity.filter((a: any) => projectConvs.has(a.conversationId));
          }
        }
      }
      res.json(success({ threads: filteredActivity, unread }, 'chat_list_conv', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_list_conv', (req as any).requestId));
    }
  });

  // GET /v1/chat/conversations/:id — get conversation with recent messages
  router.get('/conversations/:id', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const conversation = await chat.getConversation(id);
      if (!conversation) {
        res.status(404).json(error('NOT_FOUND', 'Conversation not found', 'chat_get_conv', (req as any).requestId));
        return;
      }
      const participants = await chat.getParticipants(id);
      res.json(success({ conversation, participants }, 'chat_get_conv', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_get_conv', (req as any).requestId));
    }
  });

  // POST /v1/chat/conversations/:id/messages — send message
  router.post('/conversations/:id/messages', async (req: Request, res: Response) => {
    try {
      const conversationId = req.params.id as string;
      const { threadId, authorId, text, formatted, parentMessageId } = req.body || {};
      if (!authorId || !text) {
        res.status(400).json(error('INVALID_REQUEST', 'authorId and text required', 'chat_send', (req as any).requestId));
        return;
      }

      // Use provided threadId or find the main thread
      let resolvedThreadId = threadId;
      if (!resolvedThreadId) {
        const thread = await chat.getThread(`${conversationId}::main`);
        resolvedThreadId = thread?.id || `${conversationId}::main`;
      }

      const message = await chat.sendMessage({
        threadId: resolvedThreadId,
        authorId,
        text,
        formatted: formatted || null,
        parentMessageId: parentMessageId || null,
      });

      // SSE event
      localEventBus.emit({
        event: 'chat-message',
        data: { conversationId, message },
      });

      res.json(success(message, 'chat_send', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_send', (req as any).requestId));
    }
  });

  // GET /v1/chat/conversations/:id/messages — paginated messages
  router.get('/conversations/:id/messages', async (req: Request, res: Response) => {
    try {
      const conversationId = req.params.id as string;
      const threadId = (req.query.threadId as string) || `${conversationId}::main`;
      const before = req.query.before as string | undefined;
      const limit = Math.min(parseInt(req.query.limit as string || '50', 10), 100);

      const result = await chat.getMessages(threadId, before, limit);
      res.json(success(result, 'chat_messages', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_messages', (req as any).requestId));
    }
  });

  // POST /v1/chat/conversations/:id/messages/:messageId/read — mark read
  router.post('/conversations/:id/messages/:messageId/read', async (req: Request, res: Response) => {
    try {
      const { participantId } = req.body || {};
      if (!participantId) {
        res.status(400).json(error('INVALID_REQUEST', 'participantId required', 'chat_read', (req as any).requestId));
        return;
      }
      await chat.trackDelivery(req.params.messageId as string, participantId, 'read');
      res.json(success({ marked: true }, 'chat_read', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_read', (req as any).requestId));
    }
  });

  // POST /v1/chat/conversations/:id/participants — add participant
  router.post('/conversations/:id/participants', async (req: Request, res: Response) => {
    try {
      const { participantId, participantType, displayName } = req.body || {};
      if (!participantId) {
        res.status(400).json(error('INVALID_REQUEST', 'participantId required', 'chat_add_part', (req as any).requestId));
        return;
      }
      const participant = await chat.addParticipant(req.params.id as string, {
        participantId,
        participantType: participantType || 'agent',
        displayName: displayName || participantId,
      });
      res.json(success(participant, 'chat_add_part', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_add_part', (req as any).requestId));
    }
  });

  // DELETE /v1/chat/conversations/:id/participants/:agentId — remove participant
  router.delete('/conversations/:id/participants/:agentId', async (req: Request, res: Response) => {
    try {
      await chat.removeParticipant(req.params.id as string, req.params.agentId as string);
      res.json(success({ removed: true }, 'chat_remove_part', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('CHAT_ERROR', err.message, 'chat_remove_part', (req as any).requestId));
    }
  });

  return router;
}
