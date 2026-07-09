import type { Config } from '../../config.js';
import { ensureValidToken } from '../auth/tokenManager.js';
import * as signalR from '@microsoft/signalr';

export type AgentSseState = 'connected' | 'reconnecting' | 'failed' | 'stopped';

interface AgentConnection {
  agent: string;
  state: AgentSseState;
}

type MailEventHandler = (agent: string, data: Record<string, unknown>) => void;

/**
 * Upstream SignalR manager for cloud agent-mail push notifications.
 *
 * Replaces the legacy per-agent SSE upstream connections with a single
 * SignalR connection to /hubs/agentmail. SignalR + Redis backplane survives
 * multi-pod cloud deployments, which is why SSE push was silently dropping
 * events when the mail-send landed on a different pod than the SSE stream.
 *
 * The public interface mirrors UpstreamSseManager so server.js/shutdown can
 * swap it in without wider changes.
 */
export class UpstreamSignalRManager {
  private connection: signalR.HubConnection | null = null;
  private agents = new Set<string>();
  private states = new Map<string, AgentConnection>();
  private handlers: MailEventHandler[] = [];
  private cfg: Config;
  private running = false;
  private connecting = false;

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  onMailEvent(handler: MailEventHandler): void {
    this.handlers.push(handler);
  }

  private emit(agent: string, data: Record<string, unknown>): void {
    for (const handler of this.handlers) {
      try {
        handler(agent, data);
      } catch {
        // handler errors don't crash the manager
      }
    }
  }

  getStatus(): Record<string, AgentSseState> {
    const result: Record<string, AgentSseState> = {};
    for (const [agent, conn] of this.states) {
      result[agent] = conn.state;
    }
    return result;
  }

  start(agents: string[]): void {
    this.running = true;
    for (const agent of agents) {
      this.agents.add(agent);
      if (!this.states.has(agent)) {
        this.states.set(agent, { agent, state: 'reconnecting' });
      }
    }
    void this.ensureConnection();
  }

  stop(): void {
    this.running = false;
    for (const conn of this.states.values()) {
      conn.state = 'stopped';
    }
    if (this.connection) {
      this.connection.stop().catch((err) => {
        console.warn('[SignalR] stop error:', err);
      });
      this.connection = null;
    }
  }

  refresh(agents: string[]): void {
    console.log(`[SignalR] Refreshing upstream subscriptions for ${agents.length} agents`);
    this.stop();
    this.states.clear();
    this.agents.clear();
    this.start(agents);
  }

  private async buildConnection(): Promise<signalR.HubConnection> {
    const token = await ensureValidToken(this.cfg.idpUrl, 'ensureValidToken@signalr');
    if (!token) {
      throw new Error('NO_SESSION');
    }

    const url = `${this.cfg.vibeApiUrl}/hubs/agentmail`;
    const conn = new signalR.HubConnectionBuilder()
      .withUrl(url, {
        accessTokenFactory: async () => {
          const fresh = await ensureValidToken(this.cfg.idpUrl, 'ensureValidToken@signalr');
          return fresh || token;
        },
        transport: signalR.HttpTransportType.WebSockets
          | signalR.HttpTransportType.ServerSentEvents
          | signalR.HttpTransportType.LongPolling,
      })
      .withAutomaticReconnect({
        nextRetryDelayInMilliseconds: (retryContext) => {
          // Exponential backoff: 0ms, 2s, 4s, 8s ... cap at 30s
          const delay = Math.min(2000 * Math.pow(2, retryContext.previousRetryCount), 30000);
          return delay;
        },
      })
      .configureLogging(signalR.LogLevel.Warning)
      .build();

    conn.on('ReceiveNotification', (notification: Record<string, unknown>) => {
      const data = notification.data as Record<string, unknown> | undefined;
      console.log('[SignalR] ReceiveNotification:', {
        event_type: notification.event_type,
        message_id: data?.message_id,
        to_agent: data?.to_agent,
        from_agent: data?.from_agent,
      });
      this.handleNotification(notification);
    });

    conn.on('Subscribed', (result: { subscribed?: string[]; denied?: string[] }) => {
      console.log('[SignalR] Subscribed event:', result);
    });

    conn.onreconnecting((err) => {
      console.warn('[SignalR] reconnecting:', err?.message || 'connection lost');
      this.setAllStates('reconnecting');
    });

    conn.onreconnected(() => {
      console.log('[SignalR] reconnected');
      void this.subscribeAgents();
    });

    conn.onclose((err) => {
      if (this.running) {
        console.warn('[SignalR] closed unexpectedly:', err?.message || 'no error');
        this.setAllStates('reconnecting');
        // Automatic reconnect handles most cases; if it gives up, manually restart.
        setTimeout(() => this.ensureConnection(), 5000);
      }
    });

    return conn;
  }

  private async ensureConnection(): Promise<void> {
    if (!this.running || this.connecting || this.connection?.state === signalR.HubConnectionState.Connected) {
      return;
    }
    if (this.connection?.state === signalR.HubConnectionState.Connecting) {
      return;
    }

    this.connecting = true;
    try {
      if (this.connection) {
        await this.connection.stop();
      }
      this.connection = await this.buildConnection();
      await this.connection.start();
      console.log('[SignalR] connected to', this.cfg.vibeApiUrl);
      this.setAllStates('connected');
      await this.subscribeAgents();
    } catch (err: any) {
      console.warn('[SignalR] connection failed:', err.message);
      this.setAllStates('reconnecting');
      if (this.running) {
        setTimeout(() => this.ensureConnection(), 5000);
      }
    } finally {
      this.connecting = false;
    }
  }

  private async subscribeAgents(): Promise<void> {
    if (!this.connection || this.connection.state !== signalR.HubConnectionState.Connected) return;
    if (this.agents.size === 0) return;

    const agentList = Array.from(this.agents);
    try {
      const result = await this.connection.invoke<{ subscribed?: string[]; denied?: string[] }>(
        'SubscribeToAgents',
        agentList,
      );
      console.log('[SignalR] subscribed to agents:', result?.subscribed ?? agentList);
      if (result?.denied?.length) {
        console.warn('[SignalR] denied agents:', result.denied);
      }
    } catch (err: any) {
      console.warn('[SignalR] SubscribeToAgents failed:', err.message);
    }
  }

  private handleNotification(notification: Record<string, unknown>): void {
    const data = notification.data as Record<string, unknown> | undefined;
    const toAgent = data?.to_agent as string | undefined;
    const fromAgent = data?.from_agent as string | undefined;

    if (!toAgent) {
      console.warn('[SignalR] Dropping notification: missing to_agent. Cloud payload is not routing-ready.', {
        event_type: notification.event_type,
        message_id: data?.message_id,
        from_agent: fromAgent,
      });
      return;
    }

    if (!this.agents.has(toAgent)) {
      console.warn(`[SignalR] Dropping notification: recipient "${toAgent}" is not in the tracked agent set.`, {
        event_type: notification.event_type,
        message_id: data?.message_id,
        from_agent: fromAgent,
      });
      return;
    }

    this.emit(toAgent, notification);
  }

  private setAllStates(state: AgentSseState): void {
    for (const conn of this.states.values()) {
      conn.state = state;
    }
  }
}
