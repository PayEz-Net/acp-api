import { Router } from 'express';
import { success, error } from '../response.js';
import { createBroadcast, listBroadcasts } from '../../collaboration/broadcast.js';
import { sendMail, getInbox, markRead, markAllRead, archiveMail } from '../../collaboration/mail.js';

// Phase 5: /v1/messages/chat and /v1/messages/clusters RETIRED — replaced by /v1/chat/*

export default function messagingRoutes(storage) {
  const router = Router();

  router.post('/broadcast', async (req, res, next) => {
    try {
      req.operationCode = 'msg_broadcast';
      const id = await createBroadcast(storage, req.body);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id }, 'msg_broadcast', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/mail', async (req, res, next) => {
    try {
      req.operationCode = 'msg_mail';
      const id = await sendMail(storage, req.body);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id }, 'msg_mail', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/inbox/:agent', async (req, res, next) => {
    try {
      req.operationCode = 'msg_inbox';
      const unreadOnly = req.query.unread === 'true';
      const sort = req.query.sort || 'newest-unread'; // 'newest' or 'newest-unread'
      const messages = await getInbox(storage, req.params.agent, { unreadOnly, sort });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(messages, 'msg_inbox', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/broadcasts', async (req, res, next) => {
    try {
      req.operationCode = 'msg_broadcasts';
      const channel = req.query.channel || null;
      const broadcasts = await listBroadcasts(storage, channel);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(broadcasts, 'msg_broadcasts', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/inbox/:agent/read', async (req, res, next) => {
    try {
      req.operationCode = 'msg_mark_all_read';
      await markAllRead(storage, req.params.agent);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ agent: req.params.agent }, 'msg_mark_all_read', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/:id/archive', async (req, res, next) => {
    try {
      req.operationCode = 'msg_archive';
      await archiveMail(storage, req.params.id);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id: req.params.id, archived: true }, 'msg_archive', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      req.operationCode = 'msg_read';
      const msg = await storage.getMessageById(parseInt(req.params.id, 10));
      if (!msg) {
        return res.status(404).json(error('NOT_FOUND', `Message ${req.params.id} not found`, 'msg_read', req.requestId));
      }
      await markRead(storage, msg.id);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ ...msg, isRead: true }, 'msg_read', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
