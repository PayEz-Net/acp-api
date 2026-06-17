import { Router } from 'express';
import { success, error } from '../response.js';

export default function notificationRoutes(storage) {
  const router = Router();

  // POST /v1/notifications
  router.post('/', async (req, res, next) => {
    try {
      req.operationCode = 'notifications_create';
      const { fromAgent, toAgent, subject, body, priority } = req.body || {};
      if (!fromAgent || !body) {
        return res.status(400).json(
          error('INVALID_REQUEST', 'fromAgent and body are required', 'notifications_create', req.requestId)
        );
      }
      const id = await storage.createMessage({
        messageType: 'notification',
        fromAgent,
        toAgent: toAgent || null,
        subject: subject || null,
        body,
        priority: priority || 'normal',
      });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id, created: true }, 'notifications_create', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
