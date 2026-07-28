// ACP API server
import express from 'express';
import path from 'path';
import { config } from '../config.js';
import { SessionManager } from '../agents/session_manager.js';
import { cors, requestId, timing, errorHandler } from './middleware.js';
import { success, error } from './response.js';
import { localAuth } from './middleware/localAuth.js';
import mailProxyRoutes from './routes/mailProxy.js';
import bootstrapRoutes from './routes/bootstrap.js';
import modifyRoutes from './routes/modify.js';
import execRoutes from './routes/exec.js';
import sessionRoutes from './routes/sessions.js';
import partyRoutes from './routes/party.js';
import messagingRoutes from './routes/messaging.js';
import kanbanRoutes from './routes/kanban.js';
import chatRoutes from './routes/chat.js';
import autonomyRoutes from './routes/autonomy.js';
import registryRoutes from './routes/registry.js';
import notificationRoutes from './routes/notifications.js';
import { PartyEngine } from '../collaboration/party_engine.js';
import { UpstreamSignalRManager } from './sse/upstreamSignalRManager.js';
import sseStreamRoutes from './routes/sseStream.js';
import terminalReplayRoutes from './routes/terminalReplay.js';
import { BackoffManager } from './lifecycle/backoff.js';
import { HealthMonitor } from './lifecycle/healthMonitor.js';
import { makeCrashRestartScheduler } from './lifecycle/crashRestart.js';
import agentLifecycleRoutes from './routes/agentLifecycle.js';
import { bootstrap } from '../core/bootstrap.js';
import { LocalEventBus } from './sse/localEventBus.js';
import { TerminalOutputBridge } from './terminal/terminalOutputBridge.js';
import { LifecycleHooks } from './lifecycle/hooks.js';
import { Supervisor } from '../autonomy/supervisor.js';
import { logger, setLogLevel, requestLogger } from './logging/logger.js';
import { registerShutdownHandlers } from './lifecycle/shutdown.js';
import { ContractorService } from './contractors/service.js';
import { SessionManager as ContractorSessionManager } from './contractors/sessionManager.js';
import contractorRoutes from './routes/contractors.js';
import contractRoutes from './routes/contracts.js';
import projectRoutes from './routes/projects.js';
import standupProxyRoutes from './routes/standupProxy.js';
import documentRoutes from './routes/documents.js';
import { AgentDocumentStore } from './storage/agentDocumentStore.js';
import agentRoutes from './routes/agents.js';
import teamRoutes from './routes/team.js';
import teamsRoutes from './routes/teams.js';
import cliProxyRoutes from './routes/cliProxy.js';
import authRoutes from './routes/auth.js';
import authDiagRoutes from './routes/authDiag.js';
import { setTerminalDeadEmitter } from './auth/tokenManager.js';
import magicLinkEmailRoutes from './routes/magicLinkEmail.js';

import { validateConfig } from './lifecycle/configValidator.js';

// Crash logger — never fly blind on uncaught errors
process.on('uncaughtException', (err) => {
  console.error('[FATAL] uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] unhandledRejection:', reason);
  process.exit(1);
});

const startTime = Date.now();

export async function createApp(cfg) {
  console.error('[ACP] createApp starting');
  const appConfig = cfg || config;
  const app = express();

  // Set log level from config
  if (appConfig.logLevel) setLogLevel(appConfig.logLevel);

  app.use(express.json());
  app.use(cors(appConfig.corsOrigins));
  app.use(requestId);
  app.use(timing);
  app.use(requestLogger());

  const sessionManager = new SessionManager(appConfig);
  await sessionManager.init();
  // SessionManager implements the storage interface directly
  const storage = sessionManager;
  const documentStorage = new AgentDocumentStore();
  
  // Local auth — accepts Bearer (renderer) and/or X-ACP-Agent (agents)
  if (appConfig.nodeEnv === 'production' && !appConfig.acpLocalSecret) {
    console.error('[ACP] FATAL: ACP_LOCAL_SECRET not set in production mode');
    process.exit(1);
  }
  if (!appConfig.acpLocalSecret) {
    console.warn('[ACP] WARNING: ACP_LOCAL_SECRET not set — Bearer auth disabled, agent identity auth only');
  }
  
  // Auth routes - ACP API is the auth hub (mounted BEFORE localAuth so they're public)
  app.use('/v1/auth', authRoutes());
  // Magic-link email forwarder (Phase 1 hot-patch, backfilled from
  // acp-stable-api e265ffd/8dccbbe for QAPert's ACP→IDP round-trip smoke).
  // No /issue or /redeem in this repo; just the one thin /email pass-through.
  app.use('/v1/auth/magic-link', magicLinkEmailRoutes());

  // Apply local auth middleware to all routes after this point
  app.use(localAuth(appConfig.acpLocalSecret || null, storage));
  
  // Health endpoint — unauthenticated, must respond within 1s
  // Storage probe has 500ms timeout to stay within budget
  let lastStorageStatus = 'unknown';
  app.get('/health', async (req, res) => {
    const healthStart = Date.now();
    const checks = { storage: lastStorageStatus, filesystem: 'ok' };
    try {
      await Promise.race([
        storage.init().then(() => { checks.storage = 'ok'; }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 500)),
      ]);
    } catch {
      checks.storage = lastStorageStatus === 'ok' ? 'ok' : 'degraded';
    }
    lastStorageStatus = checks.storage;
    const uptimeMs = Date.now() - startTime;
    const responseMs = Date.now() - healthStart;
    res.json(success({
      ...checks,
      uptime_seconds: Math.floor(uptimeMs / 1000),
      version: '1.1.0',
      response_ms: responseMs,
    }, 'health', req.requestId));
  });

  // Local event bus for party/autonomy SSE events
  const localEventBus = new LocalEventBus();

  // Terminal output bridge: raw PTY output -> normalized SSE agent-output events.
  // No local storage; the desktop posts directly to PayEzVibe API /v1/agent-output.
  const terminalOutputBridge = new TerminalOutputBridge(localEventBus);
  terminalOutputBridge.startPeriodicFlush();

  // WO-1 Deliverable C seam: sidecar = SOLE terminal-dead authority (§9
  // Option A). Inject the one-shot AUTH_SESSION_DEAD emitter so tokenManager
  // can push to the renderer over the EXISTING SSE stream without importing
  // express/SSE (no circular dep; tokenManager stays unit-testable).
  // tokenManager guards idempotency — this fires exactly once per dead session.
  setTerminalDeadEmitter((reason) => {
    console.error(`[Auth] session terminally dead (${reason.code}) — emitting AUTH_SESSION_DEAD once`);
    localEventBus.emitAuthSessionDead({
      code: reason.code,
      message: reason.message,
      ts: reason.ts,
    });
  });

  // Contractor service — disabled by default (not stable yet)
  const contractorService = appConfig.enableContractors 
    ? new ContractorService(storage, localEventBus, appConfig)
    : null;

  // Session manager — auto-spawn contractor sessions (Phase 2b)
  const contractorSessionManager = appConfig.enableContractors
    ? new ContractorSessionManager(storage, localEventBus, appConfig)
    : null;
    
  // Orphan detection on startup (only if contractors enabled)
  if (contractorSessionManager) {
    contractorSessionManager.checkOrphans().then(n => {
      if (n > 0) logger.info(`[SessionManager] Marked ${n} orphaned contract(s) as expired`);
    }).catch(() => {});
  }

  // Mail proxy — acp-api signs with HMAC, renderer only needs local bearer token
  // onMailSent callback wired after lifecycleHooks is created (below)
  // contractorService injected for pre-send contractor resolution (null if disabled)
  let mailSentCallback = null;
  app.use('/v1/mail', mailProxyRoutes(appConfig, (from, subject, to) => {
    if (mailSentCallback) mailSentCallback(from, subject, to);
  }, contractorService, contractorSessionManager));

  // SignalR upstream (mail from cloud) → local SSE downstream fan-out.
  // Replaces per-agent cloud SSE: SignalR + Redis backplane survives multi-pod.
  const upstreamSse = new UpstreamSignalRManager(appConfig);
  app.use('/v1/sse', sseStreamRoutes(upstreamSse, localEventBus));

  // Terminal replay API — proxies /v1/terminal/replay to PayEzVibe API
  // GET /v1/agent-output/history; aggregates /sessions and /export locally.
  app.use('/v1/terminal', terminalReplayRoutes(appConfig));

  // WO-1 Deliverable D §5.6 — queryable [AuthRC] ring-buffer surface.
  // Authenticated (mounted after localAuth) — renderer/diagnostics only.
  app.use('/v1/auth-rc', authDiagRoutes());

  // Agent lifecycle — spawn/kill/restart via Electron callback, crash-loop backoff
  const backoffManager = new BackoffManager();
  const callbackPort = appConfig.acpCallbackPort;

  const scheduleRestart = makeCrashRestartScheduler({
    cfg: appConfig,
    backoff: backoffManager,
    callbackPort,
    bootstrap: (name) => bootstrap(sessionManager, name),
  });

  const healthMonitor = new HealthMonitor(appConfig, backoffManager, callbackPort, scheduleRestart);

  app.use('/v1/lifecycle/agents', agentLifecycleRoutes({
    cfg: appConfig,
    backoff: backoffManager,
    healthMonitor,
    callbackPort,
    bootstrap: (name) => bootstrap(sessionManager, name),
  }));

  // Internal PTY exit route at /internal/pty/exit (where Electron callback server sends exit reports)
  app.post('/internal/pty/exit', async (req, res) => {
    const { agentName, terminalId, exitCode } = req.body || {};
    if (!agentName || exitCode === undefined) {
      return res.status(400).json(error('INVALID_REQUEST', 'agentName and exitCode required', 'pty_exit', req.requestId));
    }
    healthMonitor.handlePtyExit(agentName, terminalId || '', exitCode);
    // Fire lifecycle hooks (party signal removal, standup, SSE) — async, non-blocking
    app._lifecycleHooks?.onAgentExited(agentName, exitCode).catch(() => {});
    res.json(success({
      agent_name: agentName,
      exit_code: exitCode,
      new_status: backoffManager.get(agentName)?.status || 'unknown',
    }, 'pty_exit', req.requestId));
  });

  // Internal PTY register route — seed sidecar BackoffManager state for agents
  // spawned directly by acp-desktop (e.g., spawn-orchestrator) without going
  // through /v1/lifecycle/agents/:name/spawn. Without this registration,
  // /internal/pty/output cannot resolve project_id/session_id and the local
  // replay cache stays empty.
  app.post('/internal/pty/register', async (req, res) => {
    const { agentName, terminalId, projectId, provider } = req.body || {};
    if (!agentName || !terminalId || projectId === undefined || projectId === null) {
      return res.status(400).json(error('INVALID_REQUEST', 'agentName, terminalId, and projectId required', 'pty_register', req.requestId));
    }
    const resolvedProjectId = typeof projectId === 'number' ? projectId : Number(projectId);
    if (!Number.isFinite(resolvedProjectId)) {
      return res.status(400).json(error('INVALID_REQUEST', 'projectId must be a number', 'pty_register', req.requestId));
    }

    try {
      // Bootstrap (or reuse) the local ACP session — same session authority as
      // /v1/lifecycle/agents/:name/spawn so /internal/pty/output resolves a
      // consistent session_id.
      const { session } = await bootstrap(sessionManager, agentName);

      const state = backoffManager.getOrCreate(agentName);
      state.projectId = resolvedProjectId;
      backoffManager.markSpawned(agentName, terminalId, session.sessionId, provider || null);

      res.json(success({
        agent_name: agentName,
        terminal_id: terminalId,
        session_id: session.sessionId,
        project_id: resolvedProjectId,
        provider: state.provider,
      }, 'pty_register', req.requestId));
    } catch (err) {
      console.error('[PTY Register] failed to seed lifecycle state:', err);
      res.status(500).json(error('REGISTER_FAILED', 'Failed to seed agent lifecycle state', 'pty_register', req.requestId));
    }
  });

  // Internal PTY output route — raw chunks from acp-desktop -> normalized SSE.
  // No local storage; the desktop already posts scrubbed output directly to
  // PayEzVibe API /v1/agent-output. project_id and session_id are resolved
  // server-side from the agent's lifecycle state; the desktop payload is not
  // trusted for scoping.
  app.post('/internal/pty/output', async (req, res) => {
    const { agentName, terminalId, data, provider } = req.body || {};
    if (!agentName || !terminalId || typeof data !== 'string') {
      terminalOutputBridge.recordInvalidInput();
      return res.status(400).json(error('INVALID_REQUEST', 'agentName, terminalId, and data string required', 'pty_output', req.requestId));
    }
    const state = backoffManager.get(agentName);
    if (!state || state.projectId == null || !state.sessionId) {
      terminalOutputBridge.recordInvalidInput();
      return res.status(400).json(error('AGENT_NOT_REGISTERED', 'Agent lifecycle state not found; project/session cannot be resolved', 'pty_output', req.requestId));
    }
    const resolvedProvider = state.provider || provider || 'unknown';
    const resolvedProjectId = String(state.projectId);
    const resolvedSessionId = state.sessionId;
    terminalOutputBridge.push(agentName, terminalId, data, resolvedProvider, resolvedProjectId, resolvedSessionId);
    res.json(success({
      agent_name: agentName,
      terminal_id: terminalId,
      received_bytes: data.length,
    }, 'pty_output', req.requestId));
  });

  app.use('/v1/agents', bootstrapRoutes(sessionManager));
  app.use('/v1/agents', modifyRoutes(sessionManager));
  app.use('/v1/agents', execRoutes(sessionManager));
  app.use('/v1/sessions', sessionRoutes(sessionManager));

  const partyEngine = new PartyEngine(storage, appConfig);
  app.use('/v1/party', partyRoutes(storage, partyEngine));
  // /v1/messages — chat + clusters RETIRED in Phase 5 (replaced by /v1/chat/*)
  app.use('/v1/messages', messagingRoutes(storage));
  app.use('/v1/kanban', kanbanRoutes(storage, localEventBus));
  app.use('/v1/chat', chatRoutes(appConfig, localEventBus, storage));
  // Contractor routes — only mounted if enabled (disabled by default)
  if (contractorService && contractorSessionManager) {
    app.use('/v1/contractors', contractorRoutes(contractorService, appConfig, contractorSessionManager));
    app.use('/v1/contracts', contractRoutes(contractorService, contractorSessionManager));
  }
  // Standup (Team Check-in) proxy — #66 W1. MOUNTED BEFORE projectRoutes so the
  // deeper /v1/projects/:id/standup/* paths forward to the typed .NET vibe-api;
  // all other /v1/projects/* fall through to the projects proxy below.
  app.use('/v1/projects', standupProxyRoutes(appConfig));
  app.use('/v1/projects', projectRoutes(localEventBus, appConfig));
  app.use('/v1/documents', documentRoutes(documentStorage));
  // Team sync — soft-cached proxy of vibe-publicapi /v1/agentmail/agents?type=team.
  // Spec: idealvibe-phase1-acp-team-sync-spec-v1.md §6
  app.use('/v1/team', teamRoutes(appConfig));
  // Standing-team proxy (live-team model) — ACP-1 picker source + ACP-6 team
  // editor surface. Canonical prefix /v1/teams → cloud /v1/teams.
  app.use('/v1/teams', teamsRoutes(appConfig));
  // Agent profile lookup (minimal - full management in acp-api-noaccount)
  app.use('/v1/agents', agentRoutes(storage));

  // Autonomy supervisor — single instance shared with routes and lifecycle hooks
  const supervisor = new Supervisor(storage, appConfig);
  supervisor.link({ partyEngine, eventBus: localEventBus });
  app.use('/v1/autonomy', autonomyRoutes(supervisor));
  app.use('/v1/agents', registryRoutes(storage));
  app.use('/v1/notifications', notificationRoutes(storage));
  
  // CLI proxy routes - forward to IDP
  app.use(cliProxyRoutes(appConfig));

  // Lifecycle hooks — wire party engine, standup, and SSE events
  const lifecycleHooks = new LifecycleHooks({
    eventBus: localEventBus,
    storage,
    supervisor,
  });

  // Wire mail-sent callback now that hooks exist
  mailSentCallback = (from, subject, to) => {
    lifecycleHooks.onMailSent(from, subject, to).catch(() => {});
  };

  app.use((req, res) => {
    res.status(404).json(error('NOT_FOUND', `Route not found: ${req.method} ${req.path}`, 'unknown', req.requestId));
  });

  app.use(errorHandler);

  app._sessionManager = sessionManager;
  app._partyEngine = partyEngine;
  app._upstreamSse = upstreamSse;
  app._backoffManager = backoffManager;
  app._healthMonitor = healthMonitor;
  app._lifecycleHooks = lifecycleHooks;
  app._localEventBus = localEventBus;
  return app;
}

if (process.argv[1]?.endsWith('server.js')) {
  // Config validation before creating app
  const { ok, warnings } = await validateConfig(config);
  if (!ok) {
    logger.error('server', 'Config validation failed — exiting');
    process.exit(1);
  }

  const app = await createApp();
  const server = app.listen(config.port, config.host, () => {
    logger.info('server', `Server running on ${config.host}:${config.port}`, { storage: 'vibesql' });
    if (config.acpLocalSecret) {
      logger.info('server', 'Local auth enabled');
    }

    // Upstream SignalR subscriptions are data-driven from the renderer's SSE
    // connection (see sseStream.ts). Do not auto-start with a hardcoded roster.
    const agents = config.acpAgents;
    if (agents.length > 0) {
      app._upstreamSse.start(agents);
      console.log(`[ACP] SignalR upstream started for ${agents.length} agents`);
    } else {
      console.log('[ACP] SignalR upstream waiting for renderer agent list');
    }

    // Start health monitor for Electron callback server
    app._healthMonitor.start();

    // The config-gated boot auto-spawn loop was REMOVED (BAPert 1425; Aurum
    // 1413 greenfield-no-dead-code). It was a dead, competing autostart path:
    // ACP_AUTO_SPAWN defaulted OFF and no surface set it true, while the
    // CANONICAL autostart is the lifecycle-hub -> spawn-orchestrator (main
    // process). A second autostart authority here would be a hydra. Spawns
    // now come from the orchestrator or explicit /v1/lifecycle/agents/:name/spawn.

    // Register graceful shutdown handlers
    registerShutdownHandlers({
      cfg: config,
      partyEngine: app._partyEngine,
      upstreamSse: app._upstreamSse,
      healthMonitor: app._healthMonitor,
      backoffManager: app._backoffManager,
      server,
      callbackPort: config.acpCallbackPort,
    });
    logger.info('server', 'Shutdown handlers registered');
  });
}
