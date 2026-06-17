import { Router, type Request, type Response } from 'express';
import { success, error } from '../response.js';

export default function documentRoutes(storage: any): Router {
  const router = Router();

  // GET /v1/documents — list agent documents (optionally filter by project_id)
  router.get('/', async (req: Request, res: Response) => {
    try {
      const filter: any = {};
      if (req.query.project_id !== undefined) {
        const pid = parseInt(req.query.project_id as string, 10);
        if (!isNaN(pid)) filter.project_id = pid;
      }
      const docs = await storage.listDocuments(filter);
      res.json(success(docs, 'documents_list', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'documents_list', (req as any).requestId));
    }
  });

  // POST /v1/documents — create a new document
  router.post('/', async (req: Request, res: Response) => {
    try {
      const { project_id, title, content_md, type, version } = req.body;
      if (!title || !content_md) {
        res.status(400).json(error('VALIDATION_ERROR', 'title and content_md are required', 'document_create', (req as any).requestId));
        return;
      }
      const doc = await storage.createDocument({ project_id, title, content_md, type, version });
      res.status(201).json(success(doc, 'document_create', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_create', (req as any).requestId));
    }
  });

  // GET /v1/documents/:id — get single document
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_get', (req as any).requestId));
        return;
      }
      const doc = await storage.getDocument(id);
      if (!doc) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_get', (req as any).requestId));
        return;
      }
      res.json(success(doc, 'document_get', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_get', (req as any).requestId));
    }
  });

  // PUT /v1/documents/:id — update a document
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_update', (req as any).requestId));
        return;
      }
      const { title, content_md, document_type, version } = req.body;
      if (!title && !content_md && !document_type && version === undefined) {
        res.status(400).json(error('VALIDATION_ERROR', 'No update fields provided', 'document_update', (req as any).requestId));
        return;
      }
      const doc = await storage.updateDocument(id, { title, content_md, document_type, version });
      if (!doc) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_update', (req as any).requestId));
        return;
      }
      res.json(success(doc, 'document_update', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_update', (req as any).requestId));
    }
  });

  // DELETE /v1/documents/:id — delete a document
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (isNaN(id)) {
        res.status(400).json(error('VALIDATION_ERROR', 'Invalid document ID', 'document_delete', (req as any).requestId));
        return;
      }
      const deleted = await storage.deleteDocument(id);
      if (!deleted) {
        res.status(404).json(error('NOT_FOUND', 'Document not found', 'document_delete', (req as any).requestId));
        return;
      }
      res.json(success({ id, deleted: true }, 'document_delete', (req as any).requestId));
    } catch (err: any) {
      res.status(500).json(error('INTERNAL_ERROR', err.message, 'document_delete', (req as any).requestId));
    }
  });

  return router;
}
