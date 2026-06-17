import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { ContractorService } from '../contractors/service.js';
import type { SessionManager } from '../contractors/sessionManager.js';
import type { Config } from '../../config.js';
import { signVibeRequest } from '../auth/vibeHmac.js';
import { resolveCliPath, cliMissingEnvelope } from '../contractors/cliResolver.js';

const AGENTMAIL_BASE = '/v1/agentmail';
const PROXY_TIMEOUT_MS = 10_000;

/**
 * Fetch inbox for an agent from the cloud mail API.
 * Returns the messages array from the response.
 */
async function fetchCloudInbox(cfg: Config, agentName: string): Promise<any[]> {
  const path = `${AGENTMAIL_BASE}/inbox/${encodeURIComponent(agentName)}`;
  const url = `${cfg.vibeApiUrl}${path}?page_size=100`;
  const hmac = signVibeRequest('GET', path, {
    clientId: cfg.vibeClientId,
    signingKey: cfg.vibeHmacKey,
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        ...hmac,
        'X-Vibe-Via': 'idp-proxy',
      },
      signal: controller.signal,
    });
    const data = await res.json();
    return data?.data?.messages || [];
  } finally {
    clearTimeout(timeout);
  }
}

export default function contractorRoutes(contractorService: ContractorService, cfg?: Config, sessionManager?: SessionManager): Router {
  const router = Router();

  // GET /v1/contractors/pool — list available profiles from pool directories
  router.get('/pool', async (req: Request, res: Response) => {
    try {
      const profiles = await contractorService.listPool();
      res.json(success(profiles, 'contractors_pool', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contractors_pool', (req as any).requestId));
    }
  });

  // POST /v1/contractors/hire — activate a contractor from the pool (AC-1, AC-2, AC-3)
  router.post('/hire', async (req: Request, res: Response) => {
    try {
      const { profile_name, assignment, assigner, timeout_hours, auto_spawn } = req.body || {};
      if (!profile_name || !assignment || !assigner) {
        res.status(400).json(error('INVALID_REQUEST', 'profile_name, assignment, and assigner are required', 'contractor_hire', (req as any).requestId));
        return;
      }

      // AC-1 (BAPert msg 283): pre-hire CLI discovery. If auto_spawn is enabled
      // and the vendor CLI is not on PATH, fail loud BEFORE creating a contract
      // row or conversation. Do NOT persist state we can't spawn.
      if (auto_spawn !== false && process.env.ACP_SKIP_CLI_CHECK !== '1') {
        const expectedCmd = process.env.ACP_CONTRACTOR_CMD || 'claude';
        if (!resolveCliPath(expectedCmd)) {
          const envelope = cliMissingEnvelope(expectedCmd);
          res.status(400).json(error(
            'onboarding.cli_missing',
            `CLI not on PATH: ${expectedCmd}`,
            'contractor_hire',
            (req as any).requestId,
            envelope.details,
          ));
          return;
        }
      }

      const result = await contractorService.hire({
        profileName: profile_name,
        assignment,
        assigner,
        timeoutHours: timeout_hours,
        autoSpawn: auto_spawn,
      });

      // Auto-spawn if requested (default true)
      if (auto_spawn !== false && sessionManager) {
        try {
          const spawnStatus = await sessionManager.trySpawnOrQueue({
            contractId: result.contract.id,
            agentName: profile_name,
            hiredByName: assigner,
            assignment,
            conversationId: result.conversation_id,
            profilePath: null,
          });
          result.session_status = spawnStatus;
        } catch { /* non-fatal — contract exists, spawn failure is recoverable */ }
      }

      res.status(201).json(success(result, 'contractor_hire', (req as any).requestId));
    } catch (err: any) {
      const status = err.statusCode || 500;
      const code = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR';
      const response: any = error(code, err.message, 'contractor_hire', (req as any).requestId);
      if (err.availableProfiles) response.data = { available_profiles: err.availableProfiles };
      if (err.activeContracts) response.data = { active_contracts: err.activeContracts };
      res.status(status).json(response);
    }
  });

  // POST /v1/contractors/:name/assign-mailbox — assign a shared mailbox slot (AC-4, AC-5)
  router.post('/:name/assign-mailbox', async (req: Request, res: Response) => {
    try {
      const contractorName = req.params.name as string;
      const { slot, contract_id } = req.body || {};
      if (!slot) {
        res.status(400).json(error('INVALID_REQUEST', 'slot is required (e.g., "contractor-1")', 'contractor_assign_mailbox', (req as any).requestId));
        return;
      }

      const result = await contractorService.assignMailbox(contractorName, slot, contract_id);
      res.json(success(result, 'contractor_assign_mailbox', (req as any).requestId));
    } catch (err: any) {
      const status = err.statusCode || 500;
      const code = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR';
      const response: any = error(code, err.message, 'contractor_assign_mailbox', (req as any).requestId);
      if (err.currentOccupant) response.data = { current_occupant: err.currentOccupant };
      if (err.activeContracts) response.data = { active_contracts: err.activeContracts };
      res.status(status).json(response);
    }
  });

  // POST /v1/contractors/:name/promote — promote contractor to team agent (AC-7 through AC-10)
  router.post('/:name/promote', async (req: Request, res: Response) => {
    try {
      const contractorName = req.params.name as string;
      const { promoted_by } = req.body || {};
      if (!promoted_by) {
        res.status(400).json(error('INVALID_REQUEST', 'promoted_by is required', 'contractor_promote', (req as any).requestId));
        return;
      }

      const result = await contractorService.promote(contractorName, promoted_by);
      res.json(success(result, 'contractor_promote', (req as any).requestId));
    } catch (err: any) {
      const status = err.statusCode || 500;
      const code = status === 404 ? 'NOT_FOUND' : status === 409 ? 'CONFLICT' : 'INTERNAL_ERROR';
      res.status(status).json(error(code, err.message, 'contractor_promote', (req as any).requestId));
    }
  });

  // GET /v1/contractors/active — list contracts with agent profile data
  // ?status=active (default) | completed | all
  router.get('/active', async (req: Request, res: Response) => {
    try {
      const status = (req.query.status as string) || 'active';
      if (!['active', 'completed', 'all'].includes(status)) {
        res.status(400).json(error('VALIDATION_ERROR', 'status must be active, completed, or all', 'contractors_active', (req as any).requestId));
        return;
      }
      const killSession = sessionManager ? (id: number) => sessionManager.monitor.killSession(id) : undefined;
      const contracts = await contractorService.listContracts(status as 'active' | 'completed' | 'all', killSession);
      res.json(success(contracts, 'contractors_active', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contractors_active', (req as any).requestId));
    }
  });

  // GET /v1/contractors/:agent_name/mail?contract_id={id}
  // Returns filtered mail thread between contractor and hiring agent for a contract
  router.get('/:agent_name/mail', async (req: Request, res: Response) => {
    if (!cfg) {
      res.status(500).json(error('INTERNAL_ERROR', 'Mail proxy config not available', 'contractor_mail', (req as any).requestId));
      return;
    }
    try {
      const agentName = req.params.agent_name as string;
      const contractId = parseInt(req.query.contract_id as string, 10);
      if (isNaN(contractId)) {
        res.status(400).json(error('VALIDATION_ERROR', 'contract_id query param required (integer)', 'contractor_mail', (req as any).requestId));
        return;
      }

      // Get contract to determine hiring agent and timeframe
      const contract = await (contractorService as any).storage.getContract(contractId);
      if (!contract) {
        res.status(404).json(error('NOT_FOUND', 'Contract not found', 'contractor_mail', (req as any).requestId));
        return;
      }

      // Get hiring agent name
      const hiringAgent = await (contractorService as any).storage.getAgentById(contract.hiredByAgentId);
      if (!hiringAgent) {
        res.status(404).json(error('NOT_FOUND', 'Hiring agent not found', 'contractor_mail', (req as any).requestId));
        return;
      }

      // Fetch inboxes for both agents and merge
      const [contractorMail, hirerMail] = await Promise.all([
        fetchCloudInbox(cfg, agentName),
        fetchCloudInbox(cfg, hiringAgent.name),
      ]);

      const contractStart = new Date(contract.createdAt).getTime();
      const contractEnd = contract.completedAt
        ? new Date(contract.completedAt).getTime()
        : Date.now();

      // Filter: messages between these two agents within contract timeframe
      const isRelevant = (msg: any) => {
        const msgTime = new Date(msg.created_at).getTime();
        if (msgTime < contractStart || msgTime > contractEnd) return false;
        const from = msg.from_agent;
        const subject = msg.subject || '';
        // Messages from contractor to hirer, or from hirer to contractor
        if (from === agentName && subject) return true;
        if (from === hiringAgent.name && subject) return true;
        return false;
      };

      // Deduplicate by message_id, merge both inboxes
      const seen = new Set<number>();
      const thread: any[] = [];
      for (const msg of [...contractorMail, ...hirerMail]) {
        const id = msg.message_id || msg.id;
        if (seen.has(id)) continue;
        if (!isRelevant(msg)) continue;
        seen.add(id);
        thread.push({
          id,
          from_agent: msg.from_agent,
          to: msg.to || [],
          subject: msg.subject,
          body: msg.body,
          created_at: msg.created_at,
        });
      }

      // Sort chronological, limit 50
      thread.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
      const limited = thread.slice(0, 50);

      res.json(success(limited, 'contractor_mail', (req as any).requestId));
    } catch (err: any) {
      const msg = err.name === 'AbortError' ? 'Upstream timeout (10s)' : err.message;
      res.status(502).json(error('PROXY_ERROR', `Mail fetch failed: ${msg}`, 'contractor_mail', (req as any).requestId));
    }
  });

  return router;
}
