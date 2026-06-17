import { randomUUID } from 'node:crypto';
import { error, statusForCode } from './response.js';

const AGENT_NAME_REGEX = /^[a-zA-Z0-9_-]{1,100}$/;

export function cors(origins) {
  return (req, res, next) => {
    res.header('Access-Control-Allow-Origin', origins);
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-Request-ID, Authorization');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  };
}

export function requestId(req, _res, next) {
  req.requestId = req.headers['x-request-id'] || randomUUID();
  next();
}

export function timing(req, _res, next) {
  req.startTime = performance.now();
  next();
}

export function validateAgentName(req, res, next) {
  const name = req.params.name;
  if (!name || !AGENT_NAME_REGEX.test(name)) {
    return res.status(400).json(
      error('INVALID_REQUEST', `Invalid agent name "${name}". Must match ${AGENT_NAME_REGEX}`, 'validation', req.requestId)
    );
  }
  next();
}

export function errorHandler(err, req, res, _next) {
  const code = err.code || 'INTERNAL_ERROR';
  const status = statusForCode(code);
  const opCode = req.operationCode || 'unknown';
  res.status(status).json(error(code, err.message, opCode, req.requestId));
}
