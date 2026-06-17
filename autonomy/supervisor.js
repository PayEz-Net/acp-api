// sendMail/markRead removed — _sendPing uses direct fetch to local mail API

export class Supervisor {
  constructor(storage, cfg = {}) {
    this._storage = storage;
    this._cfg = cfg;
    this._maxRuntimeHours = cfg.autonomyMaxRuntimeHours || 4;
    this._notifyWebhook = cfg.notifyWebhook || null;
    this._partyEngine = null;
    this._eventBus = null;
    this.unattendedMode = false;
    // Nightly Kanban ping timer
    this._pingTimer = null;
    this._pingConfig = null; // { leadAgent, pingIntervalMinutes }
  }

  /** Inject party engine and event bus for unattended mode wiring. */
  link({ partyEngine, eventBus }) {
    this._partyEngine = partyEngine;
    this._eventBus = eventBus;
  }

  /**
   * Dead man's switch: if 0 SSE clients for deadManTimeoutMs (default 5 min)
   * while unattended mode is ON, auto-pause.
   * Called on party engine tick or its own interval.
   */
  _deadManZeroSince = null;
  _deadManTimeoutMs = 5 * 60 * 1000;
  _deadManTimer = null;

  startDeadManSwitch() {
    if (this._deadManTimer) return;
    this._deadManTimer = setInterval(() => this._checkDeadMan(), 10_000); // check every 10s
  }

  stopDeadManSwitch() {
    if (this._deadManTimer) {
      clearInterval(this._deadManTimer);
      this._deadManTimer = null;
    }
    this._deadManZeroSince = null;
  }

  async _checkDeadMan() {
    if (!this.unattendedMode || !this._eventBus) return;

    const clientCount = this._eventBus.sseClientCount;
    if (clientCount > 0) {
      // Clients connected — reset timer
      this._deadManZeroSince = null;
      return;
    }

    // No clients
    if (!this._deadManZeroSince) {
      this._deadManZeroSince = Date.now();
      return;
    }

    const elapsed = Date.now() - this._deadManZeroSince;
    if (elapsed >= this._deadManTimeoutMs) {
      console.warn('[Supervisor] Dead mans switch triggered — no SSE clients for 5 minutes');
      this._deadManZeroSince = null;
      await this.stopUnattended('dead_mans_switch');
    }
  }

  async start(opts = {}) {
    const state = await this.getState();
    if (state?.enabled) {
      const err = new Error('Autonomy is already running');
      err.code = 'INVALID_REQUEST';
      throw err;
    }
    const now = new Date().toISOString();
    await this._storage.updateAutonomyState({
      enabled: true,
      startedAt: now,
      stopCondition: opts.stopCondition || 'milestone',
      currentMilestone: opts.milestone || null,
      maxRuntimeHours: opts.maxRuntimeHours || this._maxRuntimeHours,
      notifyWebhook: opts.notifyWebhook || this._notifyWebhook,
      stoppedAt: null,
      stopReason: null,
    });
    return this.getState();
  }

  async stop(reason = 'manual') {
    const state = await this.getState();
    if (!state?.enabled) {
      const err = new Error('Autonomy is not running');
      err.code = 'INVALID_REQUEST';
      throw err;
    }
    await this._storage.updateAutonomyState({
      enabled: false,
      stoppedAt: new Date().toISOString(),
      stopReason: reason,
    });
    await this._notify(reason);
    return this.getState();
  }

  /**
   * Start unattended mode: supervisor + party engine linked.
   * Agents work autonomously until a stop condition is met.
   */
  async startUnattended(config = {}) {
    // If already active (in-memory or DB), stop first then restart cleanly
    if (this.unattendedMode) {
      console.log('[Supervisor] Unattended already active in-memory — restarting');
      await this.stopUnattended('restart');
    }

    // If DB says enabled (stale from server restart), clear it first
    const dbState = await this.getState();
    if (dbState?.enabled) {
      console.log('[Supervisor] Stale autonomy state in DB — clearing before start');
      try { await this.stop('restart'); } catch { /* already handled */ }
    }

    // Start supervisor with config
    await this.start({
      stopCondition: config.stopCondition || 'milestone',
      maxRuntimeHours: config.maxRuntimeHours || this._maxRuntimeHours,
      milestone: config.milestone || null,
      notifyWebhook: config.notifyWebhook || this._notifyWebhook,
    });

    this.unattendedMode = true;

    // Persist unattended fields — include leadAgent so _getLeadAgent can
    // find it without a DB query. The underlying vibe.global_vibe_agents
    // write is also attempted below for parity with the legacy flow, but
    // the in-memory state is the dependable source of truth.
    await this._storage.updateAutonomyState({
      unattendedMode: true,
      escalationLevel: config.escalationLevel ?? 2,
      leadAgent: config.leadAgent || null,
    });

    // Nightly Kanban: ping the lead agent on interval via agent mail.
    // Party engine is NOT started for this profile (cocktail-only).
    this._pingConfig = {
      pingIntervalMinutes: config.pingIntervalMinutes || 10,
    };

    // Write lead agent designation to DB (config modal is input, DB is source of truth)
    if (config.leadAgent) {
      await this._setLeadAgent(config.leadAgent);
    }

    this._startPingTimer();

    // Start dead man's switch
    this.startDeadManSwitch();

    // Emit SSE event
    if (this._eventBus) {
      this._eventBus.emit({
        event: 'unattended-started',
        data: {
          mode: 'unattended',
          profile: 'nightly-kanban',
          lead_agent: config.leadAgent || null,
          ping_interval_minutes: this._pingConfig.pingIntervalMinutes,
          stop_condition: config.stopCondition || 'milestone',
          max_runtime_hours: config.maxRuntimeHours || this._maxRuntimeHours,
          escalation_level: config.escalationLevel ?? 2,
        },
      });
    }

    // Fire first ping immediately so lead agent gets notified on start.
    // The start notification arrives UNREAD (like interval pings) so the lead
    // actually SEES it — the previous auto read-all clobbered the just-sent
    // ping itself, leaving the lead with no visible start notification (#81).
    // isInitial is retained only as a log label now.
    this._sendPing(true).catch(err => console.error('[Supervisor] Initial ping failed:', err.message || err));

    return this.getState();
  }

  /**
   * Stop unattended mode: party engine stops, supervisor stops, human notified.
   */
  async stopUnattended(reason = 'manual') {
    const wasUnattended = this.unattendedMode;
    this.unattendedMode = false;

    // Stop ping timer and clear config (Nightly Kanban)
    this._stopPingTimer();
    this._pingConfig = null;

    // Stop dead man's switch
    this.stopDeadManSwitch();

    // Persist unattended off
    await this._storage.updateAutonomyState({
      unattendedMode: false,
    });

    // Stop supervisor (handles webhook notify)
    let state;
    try {
      state = await this.stop(reason);
    } catch {
      // Supervisor may not be running if stop conditions already triggered
      state = await this.getState();
    }

    // Emit SSE event
    if (this._eventBus) {
      this._eventBus.emit({
        event: 'unattended-paused',
        data: {
          reason,
          was_unattended: wasUnattended,
          runtime_minutes: state?.startedAt
            ? Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000)
            : 0,
        },
      });
    }

    return state;
  }

  async getState() {
    const state = await this._storage.getAutonomyState();
    if (state) {
      state.unattendedMode = this.unattendedMode;
      state.partyEngineActive = this._partyEngine?.running ?? false;
    }
    return state;
  }

  /**
   * Emergency hard stop — immediate kill, no graceful shutdown.
   * Stops party engine, stops supervisor, returns kill list for caller to terminate PTYs.
   */
  async emergencyStop() {
    // Check both in-memory flag AND DB state — server restart clears in-memory
    // but DB may still have enabled: true (stale session)
    const dbState = await this.getState();
    if (!this.unattendedMode && !dbState?.enabled) return { stopped: false, reason: 'not_running' };
    this.unattendedMode = false;
    this._stopPingTimer();
    this._pingConfig = null;
    this.stopDeadManSwitch();

    await this._storage.updateAutonomyState({
      enabled: false,
      unattendedMode: false,
      stoppedAt: new Date().toISOString(),
      stopReason: 'emergency',
    });

    if (this._eventBus) {
      this._eventBus.emit({
        event: 'unattended-paused',
        data: { reason: 'emergency', was_unattended: true, hard_stop: true },
      });
    }

    return { stopped: true, reason: 'emergency' };
  }

  /**
   * Check process memory usage. Returns 'memory' stop reason if RSS exceeds threshold.
   * @param maxRssMb - RSS threshold in MB (default 2048 = 2GB)
   */
  checkMemory(maxRssMb = 2048) {
    const usage = process.memoryUsage();
    const rssMb = Math.round(usage.rss / 1024 / 1024);
    if (rssMb > maxRssMb) {
      return { exceeded: true, rssMb, maxRssMb };
    }
    return { exceeded: false, rssMb, maxRssMb };
  }

  async checkStopConditions(tasks = []) {
    const state = await this.getState();
    if (!state?.enabled) return null;

    // #82: review_queue (review>=3) and blocker (blocked>=2) are NO LONGER terminal stops.
    // A board with cards in review or blocked is a NORMAL, actively-worked state — not a
    // "halt and wait" one. Auto-stopping there killed the keep-alive on basically every real
    // board immediately after the init ping (live board has 21 in review). Jon directive:
    // keep the pings coming while there's active work. These are now FYI-only signals surfaced
    // in the ping body (see _sendPing). Hard-stops stay reserved for milestone-complete,
    // max_runtime, and the memory guardrail below.
    if (state.currentMilestone) {
      const milestoneTasks = tasks.filter((t) => t.milestone === state.currentMilestone);
      if (milestoneTasks.length > 0 && milestoneTasks.every((t) => t.status === 'done')) {
        return 'milestone';
      }
    }

    if (state.startedAt) {
      const elapsed = (Date.now() - new Date(state.startedAt).getTime()) / 3600000;
      if (elapsed >= (state.maxRuntimeHours || this._maxRuntimeHours)) {
        return 'max_runtime';
      }
    }

    // F-2: Memory guardrail
    const mem = this.checkMemory();
    if (mem.exceeded) return 'memory';

    return null;
  }

  async addStandupEntry(entry) {
    return this._storage.createStandupEntry({
      agentName: entry.agentName,
      entryType: entry.type || entry.entryType,
      summary: entry.summary,
      taskId: entry.taskId || null,
    });
  }

  async getStandup() {
    return this._storage.listStandupEntries();
  }

  async _notify(reason) {
    const state = await this.getState();
    const webhook = state?.notifyWebhook || this._notifyWebhook;
    if (!webhook) return;
    try {
      await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: 'autonomy_stopped', reason, timestamp: new Date().toISOString() }),
      });
    } catch {
      console.warn('[Supervisor] Webhook notification failed');
    }
  }

  // ── Nightly Kanban Ping ─────────────────────────────────

  _startPingTimer() {
    this._stopPingTimer();
    const intervalMs = (this._pingConfig?.pingIntervalMinutes || 10) * 60 * 1000;
    this._pingTimer = setInterval(() => {
      this._sendPing().catch(err => {
        console.error('[Supervisor] Ping failed:', err.message || err);
      });
    }, intervalMs);
    console.log(`[Supervisor] Nightly Kanban ping started: every ${this._pingConfig?.pingIntervalMinutes || 10}m (lead from DB)`);
  }

  _stopPingTimer() {
    if (this._pingTimer) {
      clearInterval(this._pingTimer);
      this._pingTimer = null;
    }
    // Note: _pingConfig is cleared in stopUnattended, NOT here.
    // _startPingTimer calls _stopPingTimer to clear the old interval
    // before setting a new one, and nulling config here would crash
    // the SSE emit that reads _pingConfig after _startPingTimer returns.
  }

  async _sendPing(isInitial = false) {
    if (!this.unattendedMode || !this._pingConfig) return;

    // Read lead agent from DB (source of truth — written by config modal on start)
    const leadAgent = await this._getLeadAgent();
    if (!leadAgent) {
      console.warn('[Supervisor] No team-lead found in vibe.global_vibe_agents, skipping ping');
      return;
    }

    const state = await this.getState();
    const elapsedMin = state?.startedAt
      ? Math.round((Date.now() - new Date(state.startedAt).getTime()) / 60000)
      : 0;

    // Gather kanban summary + headlines for lead agent
    let taskSummary = '';
    let headlines = '';
    try {
      const activeProjectId = await this._storage.getActiveProjectId();
      const tasks = await this._storage.listTasks(activeProjectId != null ? { projectId: activeProjectId } : {});
      const byStatus = {};
      for (const t of tasks) {
        byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      }
      const parts = Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`);
      taskSummary = parts.length > 0 ? parts.join(', ') : 'no tasks';

      // Headlines: backlog + in_progress tasks for this agent or unassigned
      const actionable = tasks.filter(t =>
        (t.status === 'backlog' || t.status === 'in_progress') &&
        (!t.assignedTo || t.assignedTo === leadAgent)
      );
      if (actionable.length > 0) {
        const lines = actionable.map(t => {
          const tag = t.status === 'in_progress' ? '[WIP]' : '[BACKLOG]';
          const title = t.title.length > 60 ? t.title.slice(0, 57) + '...' : t.title;
          const assignee = t.assignedTo ? '' : ' (unassigned)';
          return `  ${tag} #${t.id} ${title}${assignee}`;
        });
        const hasBacklog = actionable.some(t => t.status === 'backlog');
        headlines = '\n\nYour work queue:\n' + lines.join('\n');
        if (hasBacklog) {
          headlines += '\n\nClaim a task: PUT /v1/kanban/tasks/{id} {"status":"in_progress","assignedTo":"YourName"}';
        }
      }

      // #82: review/blocked are FYI signals now (NOT stop triggers — see checkStopConditions).
      // Surface the counts so the lead sees board state without the keep-alive self-terminating
      // on a healthy board. byStatus is already computed above.
      const reviewN = byStatus['review'] || 0;
      const blockedN = byStatus['blocked'] || 0;
      if (reviewN >= 3 || blockedN >= 2) {
        headlines += `\n\nBoard signals (FYI — not a stop): ${reviewN} in review, ${blockedN} blocked. Keep working; triage the review queue / unblock as you go.`;
      }

      // Stop condition check moved to AFTER mail send — checking here caused an
      // early return that swallowed the initial startup notification entirely.
      // The post-send check below now only fires the REMAINING terminal stops
      // (milestone / max_runtime / memory) — never review_queue/blocker (#82).
    } catch {
      taskSummary = '(could not fetch kanban)';
    }

    // Send ping via local mail (avoids HMAC cloud dependency).
    const body = `UNATTENDED MODE — Nightly Kanban Ping\n\nElapsed: ${elapsedMin} minutes\nKanban: ${taskSummary}\nMax runtime: ${state?.maxRuntimeHours || this._maxRuntimeHours}h${headlines}\n\nCheck kanban, check mail, report status, keep working.`;

    try {
      const port = this._cfg?.port || 3001;
      const mailRes = await fetch(`http://127.0.0.1:${port}/v1/mail/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-ACP-Agent': leadAgent,
        },
        body: JSON.stringify({
          from_agent: leadAgent,
          to: [leadAgent],
          subject: `UNATTENDED PING: Check kanban and mail (${elapsedMin}m elapsed)`,
          body,
          importance: 'normal',
        }),
      });
      if (!mailRes.ok) throw new Error(`Mail send failed: ${mailRes.status}`);
      await mailRes.json().catch(() => {}); // consume the response body

      // #81: the start ping (and interval pings) intentionally arrive UNREAD —
      // the ping IS the lead's "you're up / check in now" trigger, so it must be
      // visible. The previous isInitial read-all cleared the inbox AFTER sending,
      // which marked the just-sent ping read and left the lead with no visible
      // start notification. Removed — no auto read-all on any ping.

      console.log(`[Supervisor] Ping sent to ${leadAgent} (${elapsedMin}m elapsed, isInitial=${isInitial})`);
    } catch (err) {
      console.error(`[Supervisor] Failed to send ping mail:`, err.message || err);
    }

    // Check stop conditions AFTER the mail has been sent. This ensures the lead
    // agent always receives the startup notification even when the kanban is
    // already in a stop-eligible state (e.g. review_queue full on day-start).
    try {
      const activeProjectId = await this._storage.getActiveProjectId();
      const tasks = await this._storage.listTasks(activeProjectId != null ? { projectId: activeProjectId } : {});
      const stopReason = await this.checkStopConditions(tasks);
      if (stopReason) {
        console.log(`[Supervisor] Stop condition met: ${stopReason}`);
        await this.stopUnattended(stopReason);
      }
    } catch {
      // Non-fatal — unattended continues if stop-condition check fails
    }
  }

  // ── Lead Agent DB Operations ─────────────────────────────

  /**
   * Mirror lead agent designation to vibe.global_vibe_agents when the
   * storage backend supports raw SQL. In Phase 1 the in-memory
   * SessionManager doesn't expose _query, and the authoritative lead is
   * already in autonomy state (written by startUnattended before this
   * runs), so we short-circuit silently instead of logging a scary
   * "Failed to set lead agent in DB" error on every start.
   */
  async _setLeadAgent(agentName) {
    if (typeof this._storage._query !== 'function') {
      // In-memory stub: lead is kept in autonomy state, no DB mirror needed.
      return;
    }
    try {
      await this._storage._query(
        `UPDATE vibe.global_vibe_agents SET role = NULL WHERE role = 'team-lead'`
      );
      await this._storage._query(
        `UPDATE vibe.global_vibe_agents SET role = 'team-lead' WHERE name = '${agentName.replace(/'/g, "''")}'`
      );
      console.log(`[Supervisor] Lead agent set to ${agentName} in vibe.global_vibe_agents`);
    } catch (err) {
      console.error(`[Supervisor] Failed to set lead agent in DB:`, err.message || err);
    }
  }

  /**
   * Read lead agent. Prefers in-memory autonomy state (written at
   * startUnattended), falls back to vibe.global_vibe_agents when the
   * storage backend supports raw SQL (it doesn't in the Phase 1 stub).
   */
  async _getLeadAgent() {
    // In-memory state is the authoritative Phase 1 source — leadAgent was
    // stored by startUnattended. This avoids the _storage._query dependency
    // that the in-memory SessionManager doesn't implement.
    try {
      const state = await this._storage.getAutonomyState();
      if (state?.leadAgent) return state.leadAgent;
    } catch { /* fall through to DB path */ }

    try {
      if (typeof this._storage._query !== 'function') return null;
      const result = await this._storage._query(
        `SELECT name FROM vibe.global_vibe_agents WHERE role = 'team-lead' AND is_active = TRUE LIMIT 1`
      );
      return result.rows?.[0]?.name || null;
    } catch (err) {
      console.error(`[Supervisor] Failed to query lead agent:`, err.message || err);
      return null;
    }
  }
}
