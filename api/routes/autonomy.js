import { Router } from 'express';
import { success, error } from '../response.js';

export default function autonomyRoutes(supervisor) {
  const router = Router();

  router.post('/start', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_start';
      const state = await supervisor.start(req.body || {});
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state, 'autonomy_start', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/stop', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_stop';
      const { reason } = req.body || {};
      const state = await supervisor.stop(reason || 'manual');
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state, 'autonomy_stop', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/status', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_status';
      const state = await supervisor.getState();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state || { enabled: false }, 'autonomy_status', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/standup', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_standup';
      const entries = await supervisor.getStandup();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(entries || [], 'autonomy_standup', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/standup', async (req, res, next) => {
    try {
      req.operationCode = 'autonomy_standup_add';
      const id = await supervisor.addStandupEntry(req.body);
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({ id }, 'autonomy_standup_add', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // ── Unattended Mode ─────────────────────────────────

  router.post('/unattended/start', async (req, res, next) => {
    try {
      req.operationCode = 'unattended_start';
      const { stopCondition, maxRuntimeHours, escalationLevel, milestone, notifyWebhook, leadAgent, pingIntervalMinutes } = req.body || {};
      const state = await supervisor.startUnattended({
        stopCondition,
        maxRuntimeHours,
        escalationLevel,
        milestone,
        notifyWebhook,
        leadAgent,
        pingIntervalMinutes,
      });
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state, 'unattended_start', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/unattended/stop', async (req, res, next) => {
    try {
      req.operationCode = 'unattended_stop';
      const { reason } = req.body || {};
      const state = await supervisor.stopUnattended(reason || 'manual');
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(state, 'unattended_stop', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/unattended/status', async (req, res, next) => {
    try {
      req.operationCode = 'unattended_status';
      const state = await supervisor.getState();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success({
        ...(state || { enabled: false }),
        unattendedMode: supervisor.unattendedMode,
        partyEngineActive: supervisor._partyEngine?.running ?? false,
      }, 'unattended_status', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // Emergency hard stop — immediate kill, no graceful shutdown (F-1)
  router.post('/unattended/emergency-stop', async (req, res, next) => {
    try {
      req.operationCode = 'emergency_stop';
      const result = await supervisor.emergencyStop();
      const elapsed = Math.round(performance.now() - req.startTime);
      res.json(success(result, 'emergency_stop', req.requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
