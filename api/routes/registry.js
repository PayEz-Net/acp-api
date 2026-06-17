import { Router } from 'express';
import { success, error } from '../response.js';
import { validateAgentName } from '../middleware.js';

export default function registryRoutes(storage) {
  const router = Router();

  // POST /v1/agents/:name/register
  router.post('/:name/register', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'agents_register';
      const { runtime, adapter, connectionInfo, capabilities } = req.body || {};
      if (!runtime) {
        return res.status(400).json(
          error('INVALID_REQUEST', 'runtime is required', 'agents_register', req.requestId)
        );
      }
      const agentId = `agent:${req.params.name}`;
      await storage.registerAgent({
        agentId,
        runtime,
        adapter: adapter || 'cli-hook',
        connectionInfo: connectionInfo || {},
        capabilities: capabilities || {},
      });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ registered: true, agentId }, 'agents_register', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // POST /v1/agents/:name/deregister
  router.post('/:name/deregister', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'agents_deregister';
      const agentId = `agent:${req.params.name}`;
      await storage.deregisterAgent(agentId);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ deregistered: true, agentId }, 'agents_deregister', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // GET /v1/agents/:name/registration
  router.get('/:name/registration', validateAgentName, async (req, res, next) => {
    try {
      req.operationCode = 'agents_registration';
      const agentId = `agent:${req.params.name}`;
      const reg = await storage.getAgentRegistration(agentId);
      if (!reg) {
        return res.status(404).json(
          error('AGENT_NOT_FOUND', `No registration found for ${req.params.name}`, 'agents_registration', req.requestId)
        );
      }
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(reg, 'agents_registration', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
