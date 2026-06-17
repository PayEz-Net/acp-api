import { Router } from 'express';
import { success, error } from '../response.js';

/**
 * CLI Proxy Routes
 * 
 * Proxies CLI authentication requests to the IDP API.
 * The CLI talks to ACP API, which forwards to DotNetPert's IDP.
 */
export default function cliProxyRoutes(cfg) {
  const router = Router();
  // cfg.idpUrl is required('IDP_URL') in config — no dev-box fallback in a public build
  // (Decision-C / no-unjustified-fallback; off-LAN Praveen RCA). The old env-or-dev-box
  // default 404'd every off-LAN CLI flow; killed so it can't ship in a public install.
  const idpUrl = cfg.idpUrl;

  // POST /v1/cli/signup - Forward to IDP
  router.post('/v1/cli/signup', async (req, res) => {
    try {
      const response = await fetch(`${idpUrl}/api/ExternalAuth/v1/cli/signup`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.status(response.status).json(error(
          data.code || 'SIGNUP_FAILED',
          data.message || 'Signup failed',
          'cli_signup',
          req.requestId
        ));
      }

      res.json(success(data, 'cli_signup', req.requestId));
    } catch (err) {
      res.status(502).json(error(
        'IDP_UNREACHABLE',
        `Cannot reach IDP at ${idpUrl}: ${err.message}`,
        'cli_signup',
        req.requestId
      ));
    }
  });

  // POST /v1/cli/token - Forward to IDP
  router.post('/v1/cli/token', async (req, res) => {
    try {
      const response = await fetch(`${idpUrl}/api/ExternalAuth/v1/cli/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.status(response.status).json(error(
          data.code || 'TOKEN_FAILED',
          data.message || 'Token exchange failed',
          'cli_token',
          req.requestId
        ));
      }

      res.json(success(data, 'cli_token', req.requestId));
    } catch (err) {
      res.status(502).json(error(
        'IDP_UNREACHABLE',
        `Cannot reach IDP at ${idpUrl}: ${err.message}`,
        'cli_token',
        req.requestId
      ));
    }
  });

  // GET /v1/cli/status - Forward to IDP (requires auth)
  router.get('/v1/cli/status', async (req, res) => {
    try {
      const authHeader = req.headers.authorization;
      
      const response = await fetch(`${idpUrl}/api/ExternalAuth/v1/cli/status`, {
        headers: {
          'Authorization': authHeader || '',
          'Accept': 'application/json',
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return res.status(response.status).json(error(
          data.code || 'STATUS_FAILED',
          data.message || 'Failed to get status',
          'cli_status',
          req.requestId
        ));
      }

      res.json(success(data, 'cli_status', req.requestId));
    } catch (err) {
      res.status(502).json(error(
        'IDP_UNREACHABLE',
        `Cannot reach IDP at ${idpUrl}: ${err.message}`,
        'cli_status',
        req.requestId
      ));
    }
  });

  return router;
}
