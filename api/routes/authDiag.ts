import { Router, type Request, type Response } from 'express';
import { success } from '../response.js';
import { getAuthRc } from '../auth/authRcLog.js';
import { isSessionTerminallyDead, getTerminalReason } from '../auth/tokenManager.js';

/**
 * WO-1 Deliverable D §5.6 — queryable [AuthRC] surface.
 *
 * "Surfaced to the captured main log AND a queryable surface (sidecar diag
 * endpoint returning a recent ring-buffer) — not 'relaunch and hope it's
 * not stale'." Mounted AFTER localAuth (authenticated, renderer-only).
 */
export default function authDiagRoutes(): Router {
  const router = Router();

  // GET /v1/auth-rc?limit=50 — recent ring-buffer + current terminal state
  router.get('/', (req: Request, res: Response) => {
    const limit = Math.max(1, Math.min(Number(req.query.limit) || 50, 200));
    res.json(
      success(
        {
          terminally_dead: isSessionTerminallyDead(),
          terminal_reason: getTerminalReason(),
          entries: getAuthRc(limit),
        },
        'auth_rc',
        (req as any).requestId,
      ),
    );
  });

  return router;
}
