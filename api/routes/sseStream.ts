import { Router, type Request, type Response } from 'express';
import type { UpstreamSseManager } from '../sse/upstreamManager.js';
import type { LocalEventBus } from '../sse/localEventBus.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * SSE downstream endpoint for the renderer.
 * Single multiplexed connection: events tagged by agent name.
 * Heartbeat every 30s to keep connection alive.
 * Receives both upstream (mail from cloud) and local (party/autonomy) events.
 */
export default function sseStreamRoutes(upstreamManager: UpstreamSseManager, localEventBus?: LocalEventBus): Router {
  const router = Router();
  const clients = new Set<{
    res: Response;
    agents: Set<string> | null; // null = all agents
  }>();

  // Register mail event handler — fan out to all connected downstream clients
  upstreamManager.onMailEvent((agent, data) => {
    const payload = JSON.stringify({ agent, ...data });
    for (const client of clients) {
      if (client.agents === null || client.agents.has(agent)) {
        client.res.write(`event: mail\ndata: ${payload}\n\n`);
      }
    }
  });

  // Register local event handler — party/autonomy/standup events
  if (localEventBus) {
    localEventBus.onEvent((event) => {
      const payload = JSON.stringify(event.data);
      for (const client of clients) {
        client.res.write(`event: ${event.event}\ndata: ${payload}\n\n`);
      }
    });
  }

  // GET /v1/sse/stream — downstream SSE for renderer
  router.get('/stream', (req: Request, res: Response) => {
    // Parse optional agent filter
    const agentFilter = req.query.agents
      ? new Set((req.query.agents as string).split(',').map(a => a.trim()))
      : null;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if proxied
    });

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected' })}\n\n`);

    const client = { res, agents: agentFilter };
    clients.add(client);
    if (localEventBus) localEventBus.sseClientCount = clients.size;

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
      if (localEventBus) localEventBus.sseClientCount = clients.size;
    });
  });

  // GET /v1/sse/status — per-agent SSE connection state
  router.get('/status', (req: Request, res: Response) => {
    const status = upstreamManager.getStatus();
    res.json({
      success: true,
      data: {
        agents: status,
        downstream_clients: clients.size,
      },
    });
  });

  // POST /v1/sse/refresh — restart all upstream SSE connections
  router.post('/refresh', (req: Request, res: Response) => {
    const agents = (req.body?.agents as string[]) || Object.keys(upstreamManager.getStatus());
    if (agents.length === 0) {
      res.status(400).json({ success: false, error: 'No agents to refresh' });
      return;
    }
    upstreamManager.refresh(agents);
    res.json({
      success: true,
      data: { refreshed: agents, downstream_clients: clients.size },
    });
  });

  return router;
}
