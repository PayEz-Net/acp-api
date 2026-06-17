import { Router } from 'express';
import { execWithAgent } from '../../core/exec_with_agent.js';
import { success } from '../response.js';
import { validateAgentName } from '../middleware.js';

export default function execRoutes(sessionManager) {
  const router = Router();

  router.post('/:name/exec', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'agents_exec';
      const { code } = req.body || {};
      if (!code) {
        const err = new Error('Missing "code" in request body');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const result = await execWithAgent(sessionManager, req.params.name, code);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(result, 'agents_exec', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
