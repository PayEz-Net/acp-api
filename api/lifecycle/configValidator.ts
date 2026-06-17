import { logger } from '../logging/logger.js';
import type { Config } from '../../config.js';

/**
 * Validates configuration and external service reachability on startup.
 * Logs warnings for degraded services, fatal for required ones.
 */
export async function validateConfig(cfg: Config): Promise<{ ok: boolean; warnings: string[] }> {
  const warnings: string[] = [];

  // Required env vars
  if (!cfg.acpLocalSecret) {
    if (cfg.nodeEnv === 'production') {
      logger.error('config', 'ACP_LOCAL_SECRET is required in production');
      return { ok: false, warnings };
    }
    warnings.push('ACP_LOCAL_SECRET not set — auth disabled (dev mode)');
    logger.warn('config', 'ACP_LOCAL_SECRET not set — auth disabled');
  }

  if (!cfg.acpCallbackPort) {
    warnings.push('ACP_CALLBACK_PORT not set — lifecycle commands will fail');
    logger.warn('config', 'ACP_CALLBACK_PORT not set');
  }

  // Check idealvibe.online reachability (3s timeout) via the public
  // /health endpoint — no auth required, no HMAC signing, no risk of
  // a false-positive "unreachable" warning just because credentials
  // are misaligned. Previous version hit /v1/agentmail/agents with
  // X-Vibe-Client-Secret, which (a) was the wrong auth mode entirely
  // and (b) wouldn't have told us anything about reachability vs
  // credential state anyway.
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${cfg.vibeApiUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) {
      logger.info('config', 'idealvibe.online reachable', { url: cfg.vibeApiUrl });
    } else {
      warnings.push(`idealvibe.online /health returned HTTP ${res.status}`);
      logger.warn('config', `idealvibe.online /health returned HTTP ${res.status}`, { url: cfg.vibeApiUrl });
    }
  } catch (err: any) {
    const msg = err.name === 'AbortError' ? 'timeout (3s)' : err.message;
    warnings.push(`idealvibe.online unreachable: ${msg}`);
    logger.warn('config', `idealvibe.online unreachable: ${msg}`, { url: cfg.vibeApiUrl });
  }

  if (warnings.length > 0) {
    logger.info('config', `Startup validation: ${warnings.length} warning(s)`, { warnings });
  } else {
    logger.info('config', 'All startup validations passed');
  }

  return { ok: true, warnings };
}
