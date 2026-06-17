import { Router } from 'express';
import { success, error } from '../response.js';
import { computeRelevanceMatrix, computeRelevance } from '../../collaboration/relevance.js';

export default function partyRoutes(storage, _partyEngine) {
  const router = Router();

  router.post('/signal', async (req, res, next) => {
    try {
      req.operationCode = 'party_signal';
      const signal = req.body;
      if (!signal.agentId || !signal.agentName) {
        const err = new Error('Signal requires agentId and agentName');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      await storage.upsertSignal(signal);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ agentId: signal.agentId }, 'party_signal', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/state', async (req, res, next) => {
    try {
      req.operationCode = 'party_state';
      const signals = await storage.listSignals();
      const mingles = await storage.listActiveMingles();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ agents: signals, mingles }, 'party_state', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/relevance', async (req, res, next) => {
    try {
      req.operationCode = 'party_relevance';
      const signals = await storage.listSignals();
      const matrix = computeRelevanceMatrix(signals);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(matrix, 'party_relevance', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/relevance/:agentA/:agentB', async (req, res, next) => {
    try {
      req.operationCode = 'party_relevance_pair';
      const signals = await storage.listSignals();
      const a = signals.find((s) => s.agentId === req.params.agentA);
      const b = signals.find((s) => s.agentId === req.params.agentB);
      if (!a || !b) {
        return res.status(404).json(error('AGENT_NOT_FOUND', 'One or both agents not found', 'party_relevance_pair', req.requestId));
      }
      const score = computeRelevance(a, b);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ agentA: req.params.agentA, agentB: req.params.agentB, score }, 'party_relevance_pair', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/mingle', async (req, res, next) => {
    try {
      req.operationCode = 'party_mingle';
      const { agentA, agentB, interactionType, topic } = req.body || {};
      if (!agentA || !agentB) {
        const err = new Error('Mingle requires agentA and agentB');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const { randomUUID } = await import('node:crypto');
      const mingle = {
        mingleId: `mingle_${randomUUID()}`,
        agentA,
        agentB,
        interactionType: interactionType || 'chit_chat',
        topic: topic || null,
        outcome: 'pending',
        startedAt: new Date().toISOString(),
      };
      await storage.createMingle(mingle);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(mingle, 'party_mingle', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/mingle/:id/resolve', async (req, res, next) => {
    try {
      req.operationCode = 'party_mingle_resolve';
      const { outcome } = req.body || {};
      await storage.updateMingle(req.params.id, {
        outcome: outcome || 'completed',
        endedAt: new Date().toISOString(),
      });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ mingleId: req.params.id, outcome: outcome || 'completed' }, 'party_mingle_resolve', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/agents/:id/zone', async (req, res, next) => {
    try {
      req.operationCode = 'party_zone';
      const { zone } = req.body || {};
      if (!zone) {
        const err = new Error('Zone is required');
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const signals = await storage.listSignals();
      const agent = signals.find((s) => s.agentId === req.params.id);
      if (!agent) {
        return res.status(404).json(error('AGENT_NOT_FOUND', `Agent "${req.params.id}" not found`, 'party_zone', req.requestId));
      }
      await storage.upsertSignal({ ...agent, zone });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ agentId: req.params.id, zone }, 'party_zone', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
