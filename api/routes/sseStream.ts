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
    projectId: string | null;
  }>();

  // Data-driven upstream subscriptions: union all explicitly-requested agent
  // lists from renderer clients. No hardcoded roster, no fallback agents.
  const subscribedAgents = new Set<string>();

  function recomputeUpstream(): void {
    const next = new Set<string>();
    for (const client of clients) {
      if (client.agents) {
        for (const agent of client.agents) next.add(agent);
      }
    }

    const changed =
      next.size !== subscribedAgents.size ||
      [...next].some(a => !subscribedAgents.has(a));
    if (!changed) return;

    subscribedAgents.clear();
    for (const agent of next) subscribedAgents.add(agent);

    if (subscribedAgents.size > 0) {
      console.log(`[SSE] Renderer agent list changed, refreshing upstream subscriptions: ${Array.from(subscribedAgents).join(', ')}`);
      upstreamManager.refresh(Array.from(subscribedAgents));
    } else {
      console.log('[SSE] No agents requested by renderer, stopping upstream subscriptions');
      upstreamManager.stop();
    }
  }

  // Register mail event handler — fan out to all connected downstream clients.
  // The upstream notification wraps the mail fields in notification.data;
  // flatten that onto the SSE payload so the renderer sees
  // { agent, message_id, from_agent, subject, ... }.
  upstreamManager.onMailEvent((agent, notification) => {
    const mailData = (notification.data as Record<string, unknown> | undefined) ?? {};
    const payload = JSON.stringify({ agent, ...mailData });
    for (const client of clients) {
      if (client.agents === null || client.agents.has(agent)) {
        client.res.write(`event: mail\ndata: ${payload}\n\n`);
      }
    }
  });

  // Register local event handler — party/autonomy/standup events
  if (localEventBus) {
    localEventBus.onEvent((event) => {
      for (const client of clients) {
        // Per-agent terminal output must only reach clients subscribed to that
        // agent (or to all agents) AND scoped to the client's project.
        // Other local events remain broadcast until we have a reason to filter them.
        if (event.event === 'agent-output') {
          const agent = event.data?.agent as string | undefined;
          if (client.agents !== null && agent && !client.agents.has(agent)) {
            continue;
          }
          const eventProjectId = event.data?.project_id as string | undefined;
          if (client.projectId !== null && eventProjectId && eventProjectId !== client.projectId) {
            continue;
          }
          // Strip internal routing fields before writing to the wire.
          const { project_id: _projectId, ...wireData } = event.data;
          client.res.write(`event: ${event.event}\ndata: ${JSON.stringify(wireData)}\n\n`);
          continue;
        }
        const payload = JSON.stringify(event.data);
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

    const projectId = req.query.project_id as string | undefined;

    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no', // disable nginx buffering if proxied
    });

    // Send initial connected event
    res.write(`event: connected\ndata: ${JSON.stringify({ status: 'connected' })}\n\n`);

    // Catch-up has been removed from the local sidecar. The renderer's live
    // agent-output feed is sourced from PayEzVibe API GET /v1/agent-output/stream
    // (see acp-desktop useVsqlCacheSse.ts), which handles reconnect catch-up via
    // the `since` query parameter against the backend cache.

    const client = { res, agents: agentFilter, projectId: projectId ?? null };
    clients.add(client);
    if (localEventBus) localEventBus.sseClientCount = clients.size;
    recomputeUpstream();

    // Heartbeat to keep connection alive
    const heartbeat = setInterval(() => {
      res.write(`event: ping\ndata: {}\n\n`);
    }, HEARTBEAT_INTERVAL_MS);

    // Cleanup on disconnect
    req.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
      if (localEventBus) localEventBus.sseClientCount = clients.size;
      recomputeUpstream();
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
