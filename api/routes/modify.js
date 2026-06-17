import { Router } from 'express';
import { modifySelf } from '../../core/modify_self.js';
import { success } from '../response.js';
import { validateAgentName } from '../middleware.js';

export default function modifyRoutes(sessionManager) {
  const router = Router();

  router.post('/:name/modify', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'agents_modify';
      const modifications = req.body || {};
      const result = await modifySelf(sessionManager, req.params.name, modifications);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(result, 'agents_modify', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
