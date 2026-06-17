import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';
import { ContractorService } from '../contractors/service.js';
import type { SessionManager } from '../contractors/sessionManager.js';

export default function contractRoutes(contractorService: ContractorService, sessionManager?: SessionManager): Router {
  const router = Router();

  // POST /v1/contracts/:contract_id/complete — mark contract complete
  // v2: side-effects — free mailbox slot, resolve conversation (AC-6, AC-15)
  router.post('/:contract_id/complete', async (req: Request, res: Response) => {
    try {
      const contractId = parseInt(req.params.contract_id as string, 10);
      if (isNaN(contractId)) {
        res.status(400).json(error('INVALID_REQUEST', 'contract_id must be an integer', 'contract_complete', (req as any).requestId));
        return;
      }

      // Get contract before completing (for side-effect data)
      const preContract = await contractorService.getContract(contractId);

      const contract = await contractorService.completeContract(contractId);
      if (!contract) {
        res.status(404).json(error('NOT_FOUND', 'Contract not found or not active', 'contract_complete', (req as any).requestId));
        return;
      }

      // v2 side-effects: free mailbox slot (AC-6) and resolve conversation (AC-15)
      if (preContract?.mailboxSlot) {
        try { await contractorService.freeMailboxSlot(contractId); } catch { /* non-fatal */ }
      }
      if (preContract?.conversationId) {
        try { await contractorService.resolveConversation(preContract.conversationId); } catch { /* non-fatal */ }
      }

      res.json(success(contract, 'contract_complete', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contract_complete', (req as any).requestId));
    }
  });

  // POST /v1/contracts/:contract_id/cancel — cancel a contract
  // Phase 2b: also kills the running session if one exists
  router.post('/:contract_id/cancel', async (req: Request, res: Response) => {
    try {
      const contractId = parseInt(req.params.contract_id as string, 10);
      if (isNaN(contractId)) {
        res.status(400).json(error('INVALID_REQUEST', 'contract_id must be an integer', 'contract_cancel', (req as any).requestId));
        return;
      }

      // Kill running session if exists (Phase 2b)
      if (sessionManager) {
        sessionManager.monitor.killSession(contractId);
      }

      const reason = req.body?.reason || null;
      const contract = await contractorService.cancelContract(contractId, reason);
      if (!contract) {
        res.status(404).json(error('NOT_FOUND', 'Contract not found or not active/queued', 'contract_cancel', (req as any).requestId));
        return;
      }

      res.json(success(contract, 'contract_cancel', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contract_cancel', (req as any).requestId));
    }
  });

  // GET /v1/contracts/:contract_id/output — session output ring buffer
  router.get('/:contract_id/output', async (req: Request, res: Response) => {
    try {
      const contractId = parseInt(req.params.contract_id as string, 10);
      if (isNaN(contractId)) {
        res.status(400).json(error('INVALID_REQUEST', 'contract_id must be an integer', 'contract_output', (req as any).requestId));
        return;
      }

      if (!sessionManager) {
        res.json(success({ lines: [], truncated: false }, 'contract_output', (req as any).requestId));
        return;
      }

      const output = sessionManager.monitor.getOutput(contractId);
      res.json(success(output, 'contract_output', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'contract_output', (req as any).requestId));
    }
  });

  return router;
}
