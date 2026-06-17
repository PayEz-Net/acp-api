import { Router } from 'express';
import { success, error } from '../response.js';
import { validateAgentName } from '../middleware.js';

export default function sessionRoutes(sessionManager) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      req.operationCode = 'sessions_list';
      const sessions = await sessionManager.list();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(sessions || [], 'sessions_list', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/:name', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'sessions_get';
      const result = await sessionManager.load(req.params.name);
      if (!result) {
        return res.status(404).json(
          error('SESSION_NOT_FOUND', `Session not found for agent "${req.params.name}"`, 'sessions_get', req.requestId)
        );
      }
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(result, 'sessions_get', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.delete('/:name', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'sessions_delete';
      await sessionManager.delete(req.params.name);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ deleted: req.params.name }, 'sessions_delete', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
