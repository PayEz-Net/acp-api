import { logger } from '../logging/logger.js';
import type { Config } from '../../config.js';

const SHUTDOWN_TIMEOUT_MS = 10_000;

interface ShutdownDeps {
  cfg: Config;
  partyEngine: { stop: () => void };
  upstreamSse: { stop: () => void };
  healthMonitor: { stop: () => void };
  backoffManager: { shutdown: () => void };
  server: { close: (cb: () => void) => void } | null;
  callbackPort: number;
}

/**
 * Graceful shutdown sequence:
 * 1. Stop party engine
 * 2. Close upstream SSE
 * 3. Stop health monitor + backoff timers
 * 4. Notify Electron callback (/internal/shutdown)
 * 5. Close Express server
 * 6. Exit
 * Force-exit after 10s if stalled.
 */
export function registerShutdownHandlers(deps: ShutdownDeps): void {
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutdown', `Received ${signal}, starting graceful shutdown`);

    // Force exit safety net
    const forceTimer = setTimeout(() => {
      logger.error('shutdown', 'Graceful shutdown timed out after 10s, forcing exit');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    forceTimer.unref();

    try {
      // 1. Stop party engine
      logger.info('shutdown', 'Stopping party engine');
      deps.partyEngine.stop();

      // 2. Close upstream SSE
      logger.info('shutdown', 'Closing upstream SSE connections');
      deps.upstreamSse.stop();

      // 3. Stop health monitor + backoff timers
      deps.healthMonitor.stop();
      deps.backoffManager.shutdown();

      // 4. Notify Electron callback
      try {
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 3000);
        await fetch(`http://127.0.0.1:${deps.callbackPort}/internal/shutdown`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${deps.cfg.acpLocalSecret}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ reason: signal }),
          signal: controller.signal,
        });
        logger.info('shutdown', 'Electron callback notified');
      } catch {
        logger.warn('shutdown', 'Failed to notify Electron callback (may already be down)');
      }

      // 5. Close Express server
      if (deps.server) {
        await new Promise<void>((resolve) => {
          deps.server!.close(() => resolve());
        });
        logger.info('shutdown', 'Express server closed');
      }

      // 6. Exit
      logger.info('shutdown', 'Shutdown complete');
      clearTimeout(forceTimer);
      process.exit(0);
    } catch (err: any) {
      logger.error('shutdown', `Shutdown error: ${err.message}`);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
