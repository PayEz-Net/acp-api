import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { setSession, clearSession, getSession, ensureValidToken } from '../auth/tokenManager.js';
import { config } from '../../config.js';

export default function authRoutes(): Router {
  const router = Router();

  // POST /v1/auth/login - Login with email/password
  router.post('/login', async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body || {};
      
      if (!email || !password) {
        res.status(400).json(error('VALIDATION_ERROR', 'email and password required', 'auth_login', (req as any).requestId));
        return;
      }

      // Call IDP (external ID API)
      const idpUrl = config.idpUrl;
      const response = await fetch(`${idpUrl}/api/ExternalAuth/login`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'X-Client-Id': 'idealvibe_online',
        },
        body: JSON.stringify({ 
          username_or_email: email, 
          password,
          client_id: 'idealvibe_online',
        }),
      });

      const responseData = await response.json();
      const data = responseData.data || responseData;

      if (!response.ok || !data.result || !data.success) {
        res.status(response.status).json(error(
          data.error?.code || 'LOGIN_FAILED',
          data.error?.message || 'Login failed',
          'auth_login',
          (req as any).requestId
        ));
        return;
      }

      const result = data.result;
      
      // Store session
      setSession({
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: new Date(Date.now() + (result.expires_in || 3600) * 1000),
        userId: result.user?.userId || '',
        email: result.user?.email || email,
      });

      res.json(success({
        user_id: result.user?.userId || '',
        email: result.user?.email || email,
        expires_in: result.expires_in,
      }, 'auth_login', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'auth_login', (req as any).requestId));
    }
  });

  // POST /v1/auth/external-session — Persist a session built from
  // externally-acquired IDP tokens (e.g. renderer OAuth flow that hit IDP
  // directly). Reuses the same tokenManager session storage as /login so
  // every downstream consumer (mail proxy, refresh, status) sees a unified
  // session regardless of how the user signed in.
  //
  // Local-only gate (same shape as /v1/auth/token) — only the Electron main
  // process should call this.
  router.post('/external-session', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress;
    if (clientIp !== '127.0.0.1' && clientIp !== '::1' && !clientIp?.includes('::ffff:127.0.0.1')) {
      res.status(403).json(error('FORBIDDEN', 'External-session endpoint only accessible locally', 'auth_external_session', (req as any).requestId));
      return;
    }

    try {
      const { access_token, refresh_token, user } = req.body || {};

      if (!access_token || !user?.user_id || !user?.email) {
        res.status(400).json(error('VALIDATION_ERROR', 'access_token + user.user_id + user.email required', 'auth_external_session', (req as any).requestId));
        return;
      }

      // setSession derives expiresAt from the JWT's exp claim; the value
      // we pass here is just a fallback in case decoding fails.
      setSession({
        accessToken: access_token,
        refreshToken: refresh_token,
        expiresAt: new Date(Date.now() + 3600 * 1000),
        userId: String(user.user_id),
        email: user.email,
      });

      const session = getSession();
      res.json(success({
        user_id: session?.userId,
        email: session?.email,
        expires_at: session?.expiresAt,
      }, 'auth_external_session', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'auth_external_session', (req as any).requestId));
    }
  });

  // POST /v1/auth/logout
  router.post('/logout', async (req: Request, res: Response) => {
    try {
      const session = getSession();
      if (session?.refreshToken) {
        // Notify IDP (best effort)
        const idpUrl = config.idpUrl;
        await fetch(`${idpUrl}/v1/token/revoke`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: session.refreshToken }),
        }).catch(() => {});
      }
      
      clearSession();
      res.json(success({ logged_out: true }, 'auth_logout', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'auth_logout', (req as any).requestId));
    }
  });

  // POST /v1/auth/refresh - Force token refresh
  router.post('/refresh', async (req: Request, res: Response) => {
    try {
      const refreshed = await ensureValidToken(config.idpUrl, 'route@/v1/auth/refresh');
      if (!refreshed) {
        res.status(401).json(error('REFRESH_FAILED', 'Token refresh failed', 'auth_refresh', (req as any).requestId));
        return;
      }

      const session = getSession();
      res.json(success({
        user_id: session?.userId,
        email: session?.email,
        expires_at: session?.expiresAt,
      }, 'auth_refresh', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'auth_refresh', (req as any).requestId));
    }
  });

  // GET /v1/auth/status
  router.get('/status', async (req: Request, res: Response) => {
    const session = getSession();
    
    if (!session) {
      res.json(success({ 
        is_authenticated: false,
        user: null,
      }, 'auth_status', (req as any).requestId));
      return;
    }

    const token = await ensureValidToken(config.idpUrl, 'route@/v1/auth');
    
    res.json(success({
      is_authenticated: !!token,
      user: token ? {
        user_id: session.userId,
        email: session.email,
      } : null,
      expires_at: session.expiresAt,
    }, 'auth_status', (req as any).requestId));
  });

  // GET /v1/auth/token - Get access token (for internal use)
  router.get('/token', async (req: Request, res: Response) => {
    // Only allow local requests
    const clientIp = req.ip || req.socket.remoteAddress;
    if (clientIp !== '127.0.0.1' && clientIp !== '::1' && !clientIp?.includes('::ffff:127.0.0.1')) {
      res.status(403).json(error('FORBIDDEN', 'Token endpoint only accessible locally', 'auth_token', (req as any).requestId));
      return;
    }

    const token = await ensureValidToken(config.idpUrl, 'route@/v1/auth');
    if (!token) {
      res.status(401).json(error('NOT_AUTHENTICATED', 'No valid token', 'auth_token', (req as any).requestId));
      return;
    }

    res.json(success({ access_token: token }, 'auth_token', (req as any).requestId));
  });

  return router;
}
