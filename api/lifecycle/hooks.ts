import type { LocalEventBus } from '../sse/localEventBus.js';

interface HookDeps {
  eventBus: LocalEventBus;
  storage: any; // Storage adapter
  supervisor: any; // Autonomy supervisor
}

/**
 * Lifecycle hooks — wires agent lifecycle, mail, and party events
 * to standup entries and SSE events.
 */
export class LifecycleHooks {
  private eventBus: LocalEventBus;
  private storage: any;
  private supervisor: any;

  constructor(deps: HookDeps) {
    this.eventBus = deps.eventBus;
    this.storage = deps.storage;
    this.supervisor = deps.supervisor;
  }

  /**
   * Called when an agent is spawned. Signals party engine and logs standup.
   */
  async onAgentSpawned(agentName: string): Promise<void> {
    // Party engine: auto-signal with zone entrance, status available
    try {
      await this.storage.upsertSignal({
        agentId: `agent:${agentName}`,
        agentName,
        zone: 'entrance',
        status: 'available',
        needs: [],
        offers: [],
        keywords: [],
        workingOn: null,
        positionX: 50 + Math.random() * 20 - 10,
        positionY: 50 + Math.random() * 20 - 10,
      });
    } catch {
      // Storage failure is non-fatal
    }

    // Standup entry: lifecycle
    await this.addStandupEntry(agentName, 'lifecycle', `${agentName} spawned`);

    // SSE: party + agent status
    this.eventBus.emitPartyUpdate({
      type: 'agent_joined',
      agent: agentName,
      zone: 'entrance',
      status: 'available',
    });
    this.eventBus.emitAgentStatus({ agent: agentName, status: 'ready' });
  }

  /**
   * Called when an agent exits. Removes party signal and logs standup.
   */
  async onAgentExited(agentName: string, exitCode: number): Promise<void> {
    // Party engine: remove signal
    try {
      await this.storage.deleteSignal(`agent:${agentName}`);
    } catch {
      // Storage failure is non-fatal
    }

    const reason = exitCode === 0 ? 'clean exit' : `crash (code ${exitCode})`;
    await this.addStandupEntry(agentName, 'lifecycle', `${agentName} exited: ${reason}`);

    this.eventBus.emitPartyUpdate({
      type: 'agent_left',
      agent: agentName,
    });
    this.eventBus.emitAgentStatus({
      agent: agentName,
      status: exitCode === 0 ? 'stopped' : 'error',
      exit_code: exitCode,
    });
  }

  /**
   * Called when mail proxy sends a message. Logs standup and updates party keywords.
   */
  async onMailSent(fromAgent: string, subject: string, toAgents: string[]): Promise<void> {
    // Standup entry: communication
    const summary = `Sent mail to ${toAgents.join(', ')}: "${subject}"`;
    await this.addStandupEntry(fromAgent, 'communication', summary);

    // Party engine: extract keywords from subject for needs/offers matching
    const keywords = subject
      .toLowerCase()
      .split(/[\s:,\-—]+/)
      .filter(w => w.length > 3)
      .slice(0, 5);

    if (keywords.length > 0) {
      try {
        const signals = await this.storage.listSignals();
        const agentSignal = signals.find((s: any) =>
          (s.agentId || s.agent_id) === `agent:${fromAgent}`
        );
        if (agentSignal) {
          await this.storage.upsertSignal({
            ...agentSignal,
            agentId: agentSignal.agentId || agentSignal.agent_id,
            agentName: agentSignal.agentName || agentSignal.agent_name,
            keywords,
            workingOn: subject.substring(0, 100),
          });
        }
      } catch {
        // Non-fatal
      }
    }
  }

  /**
   * Called when agent status changes (busy/idle based on PTY activity).
   */
  async onAgentBusy(agentName: string): Promise<void> {
    try {
      await this.updateSignalStatus(agentName, 'busy');
    } catch { /* non-fatal */ }

    this.eventBus.emitPartyUpdate({
      type: 'status_change',
      agent: agentName,
      status: 'busy',
    });
  }

  async onAgentIdle(agentName: string): Promise<void> {
    try {
      await this.updateSignalStatus(agentName, 'idle');
    } catch { /* non-fatal */ }

    this.eventBus.emitPartyUpdate({
      type: 'status_change',
      agent: agentName,
      status: 'idle',
    });
  }

  /**
   * Called when autonomy stops. Logs standup and emits SSE.
   */
  async onAutonomyStop(reason: string): Promise<void> {
    await this.addStandupEntry('system', 'autonomy_stop', `Autonomy stopped: ${reason}`);
    this.eventBus.emitAutonomyUpdate({
      type: 'stopped',
      reason,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Called when autonomy starts. Emits SSE.
   */
  async onAutonomyStart(): Promise<void> {
    await this.addStandupEntry('system', 'lifecycle', 'Autonomy started');
    this.eventBus.emitAutonomyUpdate({
      type: 'started',
      timestamp: new Date().toISOString(),
    });
  }

  private async addStandupEntry(agentName: string, type: string, summary: string): Promise<void> {
    try {
      await this.supervisor.addStandupEntry({ agentName, type, summary });
      this.eventBus.emitStandupEntry({ agent: agentName, type, summary });
    } catch {
      // Storage failure is non-fatal for hooks
    }
  }

  private async updateSignalStatus(agentName: string, status: string): Promise<void> {
    const signals = await this.storage.listSignals();
    const agentSignal = signals.find((s: any) =>
      (s.agentId || s.agent_id) === `agent:${agentName}`
    );
    if (agentSignal) {
      await this.storage.upsertSignal({
        ...agentSignal,
        agentId: agentSignal.agentId || agentSignal.agent_id,
        agentName: agentSignal.agentName || agentSignal.agent_name,
        status,
      });
    }
  }
}
