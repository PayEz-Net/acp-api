import { Router } from 'express';
import { bootstrap } from '../../core/bootstrap.js';
import { success } from '../response.js';
import { validateAgentName } from '../middleware.js';

export default function bootstrapRoutes(sessionManager) {
  const router = Router();

  router.post('/:name/bootstrap', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'agents_bootstrap';
      const { initialPreferences } = req.body || {};
      const result = await bootstrap(sessionManager, req.params.name, initialPreferences);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(result, 'agents_bootstrap', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
