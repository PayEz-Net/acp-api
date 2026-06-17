import type { Request, Response, NextFunction } from 'express';
import { error } from '../response.js';

/** Routes that require Bearer auth only — agents never call these directly (AC-5) */
const BEARER_ONLY_PATTERN = /\/v1\/agents\/[^/]+\/(register|deregister)$/;

interface AgentStorage {
  getAgentRegistration(agentId: string): Promise<unknown | null>;
}

/**
 * Local auth middleware for acp-api.
 *
 * Supports two auth patterns (AC-3, AC-1):
 *   1. Authorization: Bearer {ACP_LOCAL_SECRET} — renderer / Electron (original)
 *   2. X-ACP-Agent: {agentName} — agents inside ACP (new)
 *
 * Bearer takes precedence when both are present (AC-8).
 * Hook endpoints (register/deregister) remain Bearer-only (AC-5).
 * req.agentName is set on all authenticated requests (AC-4).
 */
/** Public paths that don't require authentication */
const PUBLIC_PATHS = [
  '/health',
  '/v1/auth/login',
  '/v1/auth/status',
  '/v1/agents/init-project',
];

export function localAuth(secret: string | null, storage?: AgentStorage) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Public paths are unauthenticated
    if (PUBLIC_PATHS.includes(req.path)) {
      next();
      return;
    }

    // OPTIONS preflight is unauthenticated
    if (req.method === 'OPTIONS') {
      next();
      return;
    }
    
    const authHeader = req.headers.authorization;
    const agentHeader = req.headers['x-acp-agent'] as string | undefined;

    // --- Bearer auth (takes precedence — AC-8) ---
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      if (secret && token === secret) {
        // Bearer valid — use X-ACP-Agent for identity if present, otherwise 'system'
        (req as any).agentName = agentHeader || 'system';
        // #64 G2 force-gate: the ACP_LOCAL_SECRET Bearer is the DESKTOP/human (renderer)
        // — agents authenticate via X-ACP-Agent only, never the local secret. So a
        // valid-secret caller is the privileged human path eligible for `force`.
        (req as any).authMethod = 'bearer';
        next();
        return;
      }
      // Bearer present but invalid — reject
      res.status(401).json(
        error('UNAUTHORIZED', 'Invalid bearer token', 'auth', (req as any).requestId)
      );
      return;
    }

    // --- Bearer-only routes cannot use agent identity auth (AC-5) ---
    if (BEARER_ONLY_PATTERN.test(req.originalUrl || req.path)) {
      res.status(401).json(
        error('UNAUTHORIZED', 'This endpoint requires Bearer authentication', 'auth', (req as any).requestId)
      );
      return;
    }

    // --- Agent Identity auth (X-ACP-Agent header — AC-1) ---
    if (agentHeader && storage) {
      try {
        const agentId = `agent:${agentHeader}`;
        const reg = await storage.getAgentRegistration(agentId);
        if (reg) {
          (req as any).agentName = agentHeader;
          // #64 G2: agent identity (X-ACP-Agent) is NOT eligible for force-move.
          (req as any).authMethod = 'agent';
          next();
          return;
        }
      } catch (err: any) {
        // Aurum 7269 NON-NEGOTIABLE: a roster-RESOLVE failure (cloud unreachable / no session)
        // must surface an HONEST error — NEVER fall through to "not registered" (the exact
        // silent-empty lie that made off-LAN Praveen look like an unregistered-agent bug when
        // the real cause was an unreachable roster). Distinct status + verbatim reason.
        res.status(503).json(
          error('AGENT_ROSTER_UNAVAILABLE', `Could not resolve the agent roster to verify '${agentHeader}': ${err?.message || err}`, 'auth', (req as any).requestId)
        );
        return;
      }
      // Agent name not registered (AC-2) — reached ONLY when the roster resolved successfully
      // and this name is genuinely absent from it.
      res.status(401).json(
        error('UNAUTHORIZED', `Agent '${agentHeader}' is not registered`, 'auth', (req as any).requestId)
      );
      return;
    }

    // --- Neither auth method present (AC-7) ---
    res.status(401).json(
      error('UNAUTHORIZED', 'Missing authentication: provide Bearer token or X-ACP-Agent header', 'auth', (req as any).requestId)
    );
  };
}
