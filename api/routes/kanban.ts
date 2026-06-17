import { Router, type Request, type Response } from 'express';
import { success } from '../response.js';
import { createTask, getTask, listTasks, moveTask, assignTask, editTask, addComment, listComments, listActivity, archiveTask } from '../../kanban/board.js';
import { reviewTask, autoMailOnStatusChange } from '../../kanban/review.js';
import { makeApiMailSender } from '../../collaboration/mail.js';
import type { LocalEventBus } from '../sse/localEventBus.js';

export default function kanbanRoutes(storage: any, localEventBus?: LocalEventBus): Router {
  const router = Router();

  // #64 GAP 4: transition notifications go through the LIVE mail API (/v1/mail/send),
  // not the orphaned storage.createMessage path. See collaboration/mail.js.
  const notifyMail = makeApiMailSender();

  router.post('/tasks', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_create';
      // Archived project guard
      const activeProjectId = await storage.getActiveProjectId();
      if (activeProjectId) {
        const project = await storage.getProject(activeProjectId);
        if (project?.status === 'archived') {
          res.status(403).json({ success: false, message: 'Project is archived', error: { code: 'PROJECT_ARCHIVED' } });
          return;
        }
      }
      // AC-6: set createdBy from auth context if not explicitly provided
      if (!req.body.createdBy && (req as any).agentName) {
        req.body.createdBy = (req as any).agentName;
      }
      const projectId = await storage.getActiveProjectId();
      const id = await createTask(storage, req.body, projectId);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'created', task_id: id },
      });
      res.json(success({ id }, 'kanban_create', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_list';
      const filter: any = {};
      if (req.query.status) filter.status = (req.query.status as string).split(',');
      if (req.query.assignedTo) filter.assignedTo = req.query.assignedTo;
      if (req.query.milestone) filter.milestone = req.query.milestone;
      if (req.query.priority) filter.priority = req.query.priority;
      // #152: archived tasks are excluded by default. ?archived=true -> archived view only;
      // ?includeArchived=true -> both active and archived.
      if (req.query.archived === 'true') filter.archived = true;
      if (req.query.includeArchived === 'true') filter.includeArchived = true;
      // #64: project-scoped board.
      const projectId = await storage.getActiveProjectId();
      const tasks = await listTasks(storage, filter, projectId);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(tasks, 'kanban_list', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.get('/tasks/:id', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_get';
      const projectId = await storage.getActiveProjectId();
      const task = await getTask(storage, parseInt(req.params.id as string, 10), projectId);
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_get', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/status', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_status';
      const { status, force } = req.body || {};
      if (!status) {
        const err = new Error('Status is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      // #64 G2: `force` (off-graph move) is HUMAN-ONLY. The desktop authenticates
      // with the ACP_LOCAL_SECRET Bearer (authMethod='bearer'); agents (X-ACP-Agent)
      // are DENIED — an agent token + force is privilege-escalation (spec §4.2).
      if (force === true && (req as any).authMethod !== 'bearer') {
        res.status(403).json({ success: false, message: 'force-move is human-only (agents must follow legal transitions)', error: { code: 'FORBIDDEN' } });
        return;
      }
      const actor = (req as any).agentName;
      const projectId = await storage.getActiveProjectId();
      const task = await moveTask(storage, parseInt(req.params.id as string, 10), status, { force: force === true, actor }, projectId);
      // #64 GAP 4: notify via the LIVE mail API (notifyMail), not the orphaned
      // storage.createMessage path that silently stranded ->review/->done cards
      // (#59/#61/#63/#65). The notify must still NEVER fail the transition, but a
      // failure on a real transition is now an anomaly — log it LOUDLY (error), don't
      // normalize it as "expected/skipped".
      try {
        await autoMailOnStatusChange(storage, notifyMail, task, status);
      } catch (mailErr: any) {
        console.error(`[kanban] status-change notification FAILED for task ${req.params.id} -> ${status} (transition still applied): ${mailErr?.message || mailErr}`);
      }
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'status_changed', task_id: req.params.id, status },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_status', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  router.put('/tasks/:id/assign', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_assign';
      const { agent } = req.body || {};
      if (!agent) {
        const err = new Error('Agent is required') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const requireUnassigned = req.body.requireUnassigned === true;
      const projectId = await storage.getActiveProjectId();
      const task = await assignTask(storage, parseInt(req.params.id as string, 10), agent, { requireUnassigned, actor: (req as any).agentName }, projectId);
      // #109 + #64: board.assignTask PERSISTS the assigned/reassigned distinction via
      // recordActivity; here we ALSO emit the live SSE re-light. from=<prevAssignee> only on a
      // TRUE reassignment (task already had a different owner) so the renderer re-lights
      // 'reassigned' on action==='assigned' && from. First-assign or re-assign to the same
      // agent stay a plain 'assigned'.
      const reassigned = task.previousAssignee && task.previousAssignee !== agent;
      localEventBus?.emit({
        event: 'kanban-update',
        data: reassigned
          ? { action: 'assigned', task_id: req.params.id, agent, from: task.previousAssignee, to: agent }
          : { action: 'assigned', task_id: req.params.id, agent },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_assign', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err: any) {
      if (err.code === 'CONFLICT') {
        res.status(409).json({ success: false, message: err.message, error: { code: 'CONFLICT' } });
        return;
      }
      next(err);
    }
  });

  // RECONCILE NOTE (#152 vs #64 G5): #152 added PUT /archive + PUT /unarchive using a 2-arg
  // archiveTask + a separate unarchiveTask. The running build (#64 G5, wo1) instead exposes
  // POST /archive + POST /unarchive over the parametrized archiveTask(storage,id,archived,actor,
  // projectId) with activity-recording + project scope (see below, ~line 230). Same capability,
  // one canonical surface — the #152 PUT pair is dropped to match the live build and the unified
  // board.js signature (a 2-arg archiveTask would now mean archived=undefined=false). The
  // default-board-excludes-archived intent of #152 is preserved by the NULL-safe filter in
  // session_manager.listTasks.

  router.put('/tasks/:id/review', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_review';
      const { action, notes, reviewer } = req.body || {};
      if (!action) {
        const err = new Error('Review action is required (approve, reject, comment)') as Error & { code?: string };
        err.code = 'INVALID_REQUEST';
        throw err;
      }
      const projectId = await storage.getActiveProjectId();
      const task = await reviewTask(storage, notifyMail, parseInt(req.params.id as string, 10), action, { notes, reviewer }, projectId);
      localEventBus?.emit({
        event: 'kanban-update',
        data: { action: 'reviewed', task_id: req.params.id, review_action: action },
      });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_review', (req as any).requestId, {
        performance: { response_time_ms: elapsed },
      }));
    } catch (err) {
      next(err);
    }
  });

  // #64 G1: PATCH /tasks/:id — edit FREE-FORM fields (title/description/priority/
  // milestone/blockers/specPath/filesChanged). status/assignee rejected (guarded).
  router.patch('/tasks/:id', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_edit';
      const projectId = await storage.getActiveProjectId();
      const task = await editTask(storage, parseInt(req.params.id as string, 10), req.body || {}, (req as any).agentName, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'edited', task_id: req.params.id } });
      const elapsed = Math.round(performance.now() - (req as any).startTime);
      res.json(success(task, 'kanban_edit', (req as any).requestId, { performance: { response_time_ms: elapsed } }));
    } catch (err) { next(err); }
  });

  // #64 G3: comment thread
  router.post('/tasks/:id/comments', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_comment_add';
      const projectId = await storage.getActiveProjectId();
      const comment = await addComment(storage, parseInt(req.params.id as string, 10),
        { body_md: req.body?.body_md, author: req.body?.author || (req as any).agentName }, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'commented', task_id: req.params.id } });
      res.json(success(comment, 'kanban_comment_add', (req as any).requestId));
    } catch (err) { next(err); }
  });
  router.get('/tasks/:id/comments', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_comment_list';
      const projectId = await storage.getActiveProjectId();
      const comments = await listComments(storage, parseInt(req.params.id as string, 10), projectId);
      res.json(success(comments, 'kanban_comment_list', (req as any).requestId));
    } catch (err) { next(err); }
  });

  // #64 G4: activity / audit trail
  router.get('/tasks/:id/activity', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_activity';
      const projectId = await storage.getActiveProjectId();
      const activity = await listActivity(storage, parseInt(req.params.id as string, 10), projectId);
      res.json(success(activity, 'kanban_activity', (req as any).requestId));
    } catch (err) { next(err); }
  });

  // #64 G5: soft-archive / unarchive
  router.post('/tasks/:id/archive', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_archive';
      const projectId = await storage.getActiveProjectId();
      const task = await archiveTask(storage, parseInt(req.params.id as string, 10), true, (req as any).agentName, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'archived', task_id: req.params.id } });
      res.json(success(task, 'kanban_archive', (req as any).requestId));
    } catch (err) { next(err); }
  });
  router.post('/tasks/:id/unarchive', async (req: Request, res: Response, next) => {
    try {
      (req as any).operationCode = 'kanban_unarchive';
      const projectId = await storage.getActiveProjectId();
      const task = await archiveTask(storage, parseInt(req.params.id as string, 10), false, (req as any).agentName, projectId);
      localEventBus?.emit({ event: 'kanban-update', data: { action: 'unarchived', task_id: req.params.id } });
      res.json(success(task, 'kanban_unarchive', (req as any).requestId));
    } catch (err) { next(err); }
  });

  return router;
}
