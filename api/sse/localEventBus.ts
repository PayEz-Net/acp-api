/**
 * Local event bus for party/autonomy SSE events.
 * These events are generated locally (not from cloud upstream).
 * Downstream SSE clients subscribe and receive them alongside mail events.
 */

export type LocalEventType = 'party-update' | 'autonomy-update' | 'standup-entry' | 'agent-status' | 'kanban-update' | 'chat-message' | 'contractor-hired' | 'contractor-completed' | 'contractor-expired' | 'contractor-cancelled' | 'contractor-queued' | 'contractor-mailbox-assigned' | 'contractor-promoted' | 'session-started' | 'session-output' | 'session-exited' | 'project-switched' | 'unattended-started' | 'unattended-paused' | 'auth-session-dead' | 'agent-output';

export interface LocalEvent {
  event: LocalEventType;
  data: Record<string, unknown>;
}

type LocalEventHandler = (event: LocalEvent) => void;

export class LocalEventBus {
  private handlers: LocalEventHandler[] = [];
  /** Current downstream SSE client count — updated by sseStream on connect/disconnect. */
  sseClientCount: number = 0;

  onEvent(handler: LocalEventHandler): void {
    this.handlers.push(handler);
  }

  emit(event: LocalEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch {
        // handler errors don't crash the bus
      }
    }
  }

  // Convenience emitters

  emitPartyUpdate(data: Record<string, unknown>): void {
    this.emit({ event: 'party-update', data });
  }

  emitAutonomyUpdate(data: Record<string, unknown>): void {
    this.emit({ event: 'autonomy-update', data });
  }

  emitStandupEntry(data: Record<string, unknown>): void {
    this.emit({ event: 'standup-entry', data });
  }

  emitAgentStatus(data: Record<string, unknown>): void {
    this.emit({ event: 'agent-status', data });
  }

  emitAgentOutput(data: Record<string, unknown>): void {
    this.emit({ event: 'agent-output', data });
  }

  // WO-1 Deliverable C: sidecar is the SOLE authority for terminal-dead.
  // One-shot — tokenManager guards idempotency before this is ever called.
  emitAuthSessionDead(data: Record<string, unknown>): void {
    this.emit({ event: 'auth-session-dead', data });
  }
}
