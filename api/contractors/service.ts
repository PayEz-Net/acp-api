import { readFile } from 'node:fs/promises';
import type { LocalEventBus } from '../sse/localEventBus.js';
import { ChatPersistence, VibeQueryClient } from '../../chat/persistence.js';
import type { Config } from '../../config.js';
import { signVibeRequest } from '../auth/vibeHmac.js';

interface PoolProfile {
  name: string;
  description: string;
  model: string;
  tools: string[];
  source: string; // 'custom' | 'builtin'
  sourcePath: string;
}

interface ResolveResult {
  action: 'passthrough' | 'rejected';
  agent?: any;
  error?: string;
}

interface HireRequest {
  profileName: string;
  assignment: string;
  assigner: string;
  timeoutHours?: number;
  autoSpawn?: boolean;
}

interface HireResult {
  agent: any;
  contract: any;
  conversation_id: string;
  session_status: 'spawned' | 'queued' | 'pending';
}

interface AssignMailboxResult {
  contractor: string;
  mailbox_slot: string;
  display_name: string;
  mail_address: string;
}

interface PromoteResult {
  agent: any;
  closed_contracts: any[];
}

function parseJsonb(val: any): any {
  if (val == null) return null;
  if (typeof val === 'object') return val;
  try { return JSON.parse(val); } catch { return null; }
}

/**
 * Compute session duration in seconds.
 * If session is still running (no end time), computes from start to now.
 */
function computeDuration(startedAt: string | null, endedAt: string | null): number | null {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = endedAt ? new Date(endedAt).getTime() : Date.now();
  return Math.round((end - start) / 1000);
}

/**
 * Transform a flat SQL JOIN row (camelCase) into the nested { agent, contract } shape
 * expected by the frontend. Output keys are snake_case to match wire format.
 */
function transformContractRow(row: any): { agent: any; contract: any } {
  return {
    agent: {
      id: row.contractorAgentId,
      name: row.contractorName,
      agent_type: 'contractor',
      display_name: row.contractorDisplayName || null,
      role: row.contractorRole || null,
      model: row.contractorModel || null,
      expertise_json: parseJsonb(row.contractorExpertise),
      is_active: row.status === 'active',
    },
    contract: {
      id: row.id,
      contractor_agent_id: row.contractorAgentId,
      hired_by_agent_id: row.hiredByAgentId,
      hired_by_name: row.hiredByName || null,
      contractor_name: row.contractorName,
      contract_subject: row.contractSubject || null,
      status: row.status,
      profile_source: row.profileSource || null,
      profile_snapshot: parseJsonb(row.profileSnapshot),
      timeout_hours: row.timeoutHours,
      created_at: row.createdAt,
      completed_at: row.completedAt || null,
      session_pid: row.sessionPid || null,
      session_started_at: row.sessionStartedAt || null,
      session_ended_at: row.sessionEndedAt || null,
      exit_code: row.exitCode ?? null,
      cancel_reason: row.cancelReason || null,
      session_duration_seconds: computeDuration(row.sessionStartedAt, row.sessionEndedAt),
    },
  };
}

export class ContractorService {
  private storage: any;
  private eventBus: LocalEventBus;
  private chat: ChatPersistence;
  private cfg: Config;

  constructor(storage: any, eventBus: LocalEventBus, cfg: Config) {
    this.storage = storage;
    this.eventBus = eventBus;
    this.cfg = cfg;
    const db = new VibeQueryClient({ vibesqlDirectUrl: cfg.vibesqlDirectUrl || 'http://localhost', vibesqlContainerSecret: cfg.vibesqlContainerSecret });
    this.chat = new ChatPersistence(db);
  }

  /**
   * List all available contractor profiles from both pool directories.
   * Custom pool takes precedence (overrides built-in with same name).
   */
  async listPool(): Promise<PoolProfile[]> {
    // Query contractor pool from VibeSQL
    const rows = await this.storage.listPoolProfiles();
    return rows.map((r: any) => ({
      name: r.name,
      description: r.description || '',
      model: r.model || 'sonnet',
      tools: Array.isArray(r.tools) ? r.tools : [],
      source: 'database' as const,
      sourcePath: r.sourcePath || '',
    }));
  }

  /**
   * Find a profile by name from the pool directories.
   */
  async findPoolProfile(name: string): Promise<{ profile: PoolProfile; content: string } | null> {
    const pool = await this.listPool();
    const match = pool.find(p => p.name === name);
    if (!match) return null;

    // If source_path exists on disk, read the full .md content for profile snapshot
    let content = `# ${match.name}\n\n${match.description}`;
    if (match.sourcePath) {
      try {
        content = await readFile(match.sourcePath, 'utf-8');
      } catch { /* file not available, use description */ }
    }

    return { profile: match, content };
  }

  /**
   * Resolve a mail recipient — validates the name exists as a team or contractor agent.
   * v2: No longer creates contracts. Unknown names return a rejected result directing
   * callers to use POST /v1/contractors/hire. (AC-11, AC-12)
   */
  async resolveRecipient(
    fromAgentName: string,
    toAgentName: string,
  ): Promise<ResolveResult> {
    // Ensure from_agent exists in local agents table
    await this.storage.upsertAgent({ name: fromAgentName, agentType: 'team' });

    const existingAgent = await this.storage.getAgentByName(toAgentName);

    if (existingAgent) {
      // Known agent (team or contractor) — normal mail delivery
      return { action: 'passthrough', agent: existingAgent };
    }

    // Unknown name — no longer creates contracts
    return {
      action: 'rejected',
      error: `Unknown recipient "${toAgentName}". Use POST /v1/contractors/hire to activate a contractor.`,
    };
  }

  /**
   * Hire a contractor from the pool. Creates agent, contract, and chat conversation.
   * (AC-1, AC-2, AC-3, AC-13)
   */
  async hire(request: HireRequest): Promise<HireResult> {
    const { profileName, assignment, assigner, timeoutHours, autoSpawn } = request;

    // Look up pool profile (AC-2: 404 if not found)
    const poolResult = await this.findPoolProfile(profileName);
    if (!poolResult) {
      const pool = await this.listPool();
      const available = pool.map(p => p.name);
      const err: any = new Error(`Profile "${profileName}" not found in contractor pool`);
      err.statusCode = 404;
      err.availableProfiles = available;
      throw err;
    }

    // Ensure assigner exists
    const assignerAgent = await this.storage.upsertAgent({ name: assigner, agentType: 'team' });

    // Check max 3 active contracts per assigner (AC-3 variant)
    const activeCount = await this.storage.countActiveContractsByHirer(assignerAgent.id);
    if (activeCount >= 3) {
      const err: any = new Error(`Max 3 active contracts per agent. Active: ${activeCount}`);
      err.statusCode = 409;
      throw err;
    }

    // Upsert contractor agent
    const contractorAgent = await this.storage.upsertAgent({
      name: profileName,
      displayName: poolResult.profile.name,
      role: poolResult.profile.description,
      model: poolResult.profile.model,
      expertiseJson: { tools: poolResult.profile.tools },
      agentType: 'contractor',
    });

    // Check duplicate active contract for same assigner+contractor (AC-3)
    const existing = await this.storage.findActiveContractByContractorAndHirer(contractorAgent.id, assignerAgent.id);
    if (existing) {
      const err: any = new Error(`Contractor "${profileName}" already has an active contract with ${assigner}`);
      err.statusCode = 409;
      throw err;
    }

    // Create chat conversation + participants + thread + subscriptions (AC-13)
    const displayName = poolResult.profile.name.replace(/-/g, ' ')
      .replace(/\b\w/g, c => c.toUpperCase());
    const titleShort = assignment.length > 60 ? assignment.slice(0, 57) + '...' : assignment;

    const conversation = await this.chat.createConversation({
      title: `${displayName} — ${titleShort}`,
      type: 'direct',
      state: 'active',
      metadata: { assigner, contractor: profileName },
    });

    await this.chat.addParticipant(conversation.id, {
      participantId: assigner,
      participantType: 'agent',
      displayName: assigner,
    });
    await this.chat.addParticipant(conversation.id, {
      participantId: profileName,
      participantType: 'agent',
      displayName,
    });

    const thread = await this.chat.createThread({
      conversationId: conversation.id,
      slug: 'main',
      subject: 'main',
    });

    await this.chat.setSubscription(thread.id, assigner, 'subscribed');
    await this.chat.setSubscription(thread.id, profileName, 'subscribed');

    // Create contract with conversation_id
    const contract = await this.storage.createContract({
      contractorAgentId: contractorAgent.id,
      hiredByAgentId: assignerAgent.id,
      contractSubject: assignment,
      profileSource: poolResult.profile.sourcePath,
      profileSnapshot: {
        name: poolResult.profile.name,
        description: poolResult.profile.description,
        model: poolResult.profile.model,
        tools: poolResult.profile.tools,
        source: poolResult.profile.source,
      },
      timeoutHours: timeoutHours ?? 72,
      conversationId: conversation.id,
    });

    this.eventBus.emit({
      event: 'contractor-hired',
      data: {
        agent: { id: contractorAgent.id, name: profileName },
        contract_id: contract.id,
        hired_by: assigner,
        has_profile: true,
        conversation_id: conversation.id,
      },
    });

    return {
      agent: {
        id: contractorAgent.id,
        name: profileName,
        agent_type: 'contractor',
        display_name: displayName,
      },
      contract: {
        id: contract.id,
        status: contract.status,
        assignment,
        assigner,
        conversation_id: conversation.id,
      },
      conversation_id: conversation.id,
      session_status: 'pending' as const,
    };
  }

  /**
   * Assign a shared mailbox slot to a contractor. (AC-4, AC-5)
   */
  async assignMailbox(
    contractorName: string,
    slot: string,
    contractId?: number,
  ): Promise<AssignMailboxResult> {
    const agent = await this.storage.getAgentByName(contractorName);
    if (!agent || agent.agentType !== 'contractor') {
      const err: any = new Error(`Contractor "${contractorName}" not found`);
      err.statusCode = 404;
      throw err;
    }

    // Resolve which contract to assign the slot to
    let targetContractId = contractId;
    if (!targetContractId) {
      const activeContracts = await this.storage.listActiveContractsByContractor(agent.id);
      if (activeContracts.length === 0) {
        const err: any = new Error(`No active contract for "${contractorName}"`);
        err.statusCode = 404;
        throw err;
      }
      if (activeContracts.length > 1) {
        const err: any = new Error(`Multiple active contracts for "${contractorName}". Provide contract_id to disambiguate.`);
        err.statusCode = 409;
        err.activeContracts = activeContracts.map((c: any) => ({ id: c.id, subject: c.contractSubject }));
        throw err;
      }
      targetContractId = activeContracts[0].id;
    }

    // Check slot not occupied (AC-5)
    const occupant = await this.storage.isMailboxSlotOccupied(slot);
    if (occupant) {
      const err: any = new Error(`Slot "${slot}" already assigned to ${occupant.contractorName}`);
      err.statusCode = 409;
      err.currentOccupant = occupant;
      throw err;
    }

    // Assign slot
    await this.storage.assignMailboxSlot(targetContractId, slot);

    // Update cloud agent_mail_agents display_name for the slot (AC-4)
    const displayName = agent.displayName || contractorName;
    await this.updateCloudSlotDisplayName(slot, displayName);

    this.eventBus.emit({
      event: 'contractor-mailbox-assigned',
      data: { contract_id: targetContractId, agent_name: contractorName, slot },
    });

    return {
      contractor: contractorName,
      mailbox_slot: slot,
      display_name: displayName,
      mail_address: slot,
    };
  }

  /**
   * Promote a contractor to permanent team agent. (AC-7 through AC-10)
   */
  async promote(contractorName: string, promotedBy: string): Promise<PromoteResult> {
    const agent = await this.storage.getAgentByName(contractorName);
    if (!agent) {
      const err: any = new Error(`Agent "${contractorName}" not found`);
      err.statusCode = 404;
      throw err;
    }
    if (agent.agentType === 'team') {
      const err: any = new Error(`Agent "${contractorName}" is already a team agent`);
      err.statusCode = 409;
      throw err;
    }

    // Close all active contracts with status 'promoted', free mailbox slots (AC-9, AC-10)
    const closedContracts = await this.storage.promoteAgent(agent.id);

    // Free cloud display_name for any mailbox slots
    for (const c of closedContracts) {
      if (c.mailboxSlot) {
        const slotNum = c.mailboxSlot.replace('contractor-', '');
        await this.updateCloudSlotDisplayName(c.mailboxSlot, `Contractor Slot ${slotNum}`);
      }
      // Resolve conversation if exists
      if (c.conversationId) {
        try { await this.resolveConversation(c.conversationId); } catch { /* non-fatal */ }
      }
    }

    // Refresh agent after promotion
    const updatedAgent = await this.storage.getAgentByName(contractorName);

    this.eventBus.emit({
      event: 'contractor-promoted',
      data: {
        agent_id: agent.id,
        agent_name: contractorName,
        closed_contract_ids: closedContracts.map((c: any) => c.id),
      },
    });

    return {
      agent: {
        id: updatedAgent.id,
        name: contractorName,
        agent_type: 'team',
      },
      closed_contracts: closedContracts.map((c: any) => ({ id: c.id, status: 'promoted' })),
    };
  }

  /**
   * Update display_name on a cloud agent_mail_agents slot.
   */
  private async updateCloudSlotDisplayName(slot: string, displayName: string): Promise<void> {
    try {
      const path = `/v1/agentmail/agents/${encodeURIComponent(slot)}`;
      const url = `${this.cfg.vibeApiUrl}${path}`;
      const hmac = signVibeRequest('PATCH', path, {
        clientId: this.cfg.vibeClientId,
        signingKey: this.cfg.vibeHmacKey,
      });
      await fetch(url, {
        method: 'PATCH',
        headers: {
          ...hmac,
          'X-Vibe-Via': 'idp-proxy',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ display_name: displayName }),
      });
    } catch { /* non-fatal — cloud update is best-effort */ }
  }

  /**
   * Get contract with conversation_id for completion side-effects.
   */
  async getContract(contractId: number): Promise<any> {
    return this.storage.getContract(contractId);
  }

  /**
   * Free a mailbox slot and reset cloud display_name (AC-6, AC-15).
   */
  async freeMailboxSlot(contractId: number): Promise<void> {
    const contract = await this.storage.getContract(contractId);
    if (!contract?.mailboxSlot) return;

    await this.storage.freeMailboxSlot(contractId);
    const slotNum = contract.mailboxSlot.replace('contractor-', '');
    await this.updateCloudSlotDisplayName(contract.mailboxSlot, `Contractor Slot ${slotNum}`);
  }

  /**
   * Resolve a conversation state to 'resolved' (AC-15).
   */
  async resolveConversation(conversationId: string): Promise<void> {
    if (!conversationId) return;
    try {
      await this.storage._query(
        `UPDATE acp_conversations SET state = 'resolved', updated_at = NOW()
         WHERE id = '${conversationId.replace(/'/g, "''")}'`
      );
    } catch { /* non-fatal */ }
  }

  /**
   * List contracts with agent data. Runs on-read expiry check when fetching active or all.
   * @param status - 'active' (default), 'completed', or 'all'
   * @param onExpire - optional callback to kill running sessions for expired contracts (F-1 fix)
   */
  async listContracts(
    status: 'active' | 'completed' | 'all' = 'active',
    onExpire?: (contractId: number) => void,
  ): Promise<any[]> {
    // On-read expiry check — expire timed-out contracts (only relevant when viewing active)
    if (status === 'active' || status === 'all') {
      const expired = await this.storage.expireContracts();
      for (const c of expired) {
        this.eventBus.emit({
          event: 'contractor-expired',
          data: { contract_id: c.id, contractor_agent_id: c.contractorAgentId },
        });
        // F-1 fix: kill running session if contract had one
        if (onExpire && c.sessionPid) {
          try { onExpire(c.id); } catch { /* non-fatal */ }
        }
      }
    }

    const rows = await this.storage.listContracts(status);
    return rows.map(transformContractRow);
  }

  /**
   * Mark a contract complete by contract ID.
   */
  async completeContract(contractId: number): Promise<any> {
    const contract = await this.storage.completeContract(contractId);
    if (!contract) return null;
    this.eventBus.emit({
      event: 'contractor-completed',
      data: { contract_id: contract.id, contractor_agent_id: contract.contractorAgentId },
    });
    return contract;
  }

  /**
   * Cancel a contract by contract ID. Sets status to 'cancelled'.
   * Session kill deferred to Phase 2b (when sessions exist).
   */
  async cancelContract(contractId: number, reason?: string): Promise<any> {
    const contract = await this.storage.cancelContract(contractId, reason || null);
    if (!contract) return null;
    this.eventBus.emit({
      event: 'contractor-cancelled',
      data: {
        contract_id: contract.id,
        contractor_agent_id: contract.contractorAgentId,
        status: 'cancelled',
        reason: reason || null,
      },
    });
    return contract;
  }

  /**
   * DONE: auto-completion hook. Called during mail send.
   * Detects DONE: prefix in subject, matches contract by contractor + hiring agent.
   * Returns the completed contract, or null if no match.
   */
  async checkDoneAutoComplete(fromAgentName: string, subject: string, toAgentNames: string[]): Promise<any | null> {
    if (!subject.trim().match(/^done:/i)) return null;

    // Sender is the contractor. Look up their agent ID.
    const fromAgent = await this.storage.getAgentByName(fromAgentName);
    if (!fromAgent || fromAgent.agentType !== 'contractor') return null;

    // Match contract by contractor + hiring agent (TO field)
    for (const toName of toAgentNames) {
      const toAgent = await this.storage.getAgentByName(toName);
      if (!toAgent) continue;

      const contract = await this.storage.findActiveContractByContractorAndHirer(
        fromAgent.id,
        toAgent.id,
      );
      if (contract) {
        return this.completeContract(contract.id);
      }
    }

    return null; // No matching active contract — deliver mail normally
  }
}
