import vm from 'node:vm';
import { config as defaultConfig } from '../config.js';

function deserializeCustomFunctions(customFunctions) {
  const fns = {};
  for (const [name, def] of Object.entries(customFunctions || {})) {
    try {
      fns[name] = new Function(...(def.params || []), def.body);
    } catch {
      // skip invalid functions at execution time
    }
  }
  return fns;
}

function createAgentContext(session) {
  const sandbox = {
    ...deserializeCustomFunctions(session.customFunctions),
    preferences: structuredClone(session.preferences || {}),
    memory: structuredClone(session.memory || {}),
    agentName: session.agentName,
    console: {
      log: (...args) => console.log(`[Agent:${session.agentName}]`, ...args),
      warn: (...args) => console.warn(`[Agent:${session.agentName}]`, ...args),
      error: (...args) => console.error(`[Agent:${session.agentName}]`, ...args),
    },
    JSON: { parse: JSON.parse, stringify: JSON.stringify },
    Math, Date, Array, Object, String, Number, Boolean,
    Map, Set, RegExp, Error, Promise,
    parseInt, parseFloat, isNaN, isFinite,
    encodeURIComponent, decodeURIComponent,
  };
  return vm.createContext(sandbox);
}

export async function execWithAgent(sessionManager, agentName, code, cfg) {
  const loaded = await sessionManager.load(agentName);
  if (!loaded) {
    const err = new Error(`Session not found for agent "${agentName}"`);
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }

  const { session } = loaded;
  const timeoutMs = (cfg || defaultConfig).execTimeoutMs;
  const context = createAgentContext(session);

  const start = performance.now();
  let result;
  try {
    const script = new vm.Script(`(function() { ${code} })()`);
    result = script.runInContext(context, {
      timeout: timeoutMs,
      breakOnSigint: true,
    });
  } catch (e) {
    if (e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT') {
      const err = new Error(`Execution timed out after ${timeoutMs}ms`);
      err.code = 'EXECUTION_TIMEOUT';
      throw err;
    }
    const err = new Error(`Execution error: ${e.message}`);
    err.code = 'EXECUTION_ERROR';
    throw err;
  }
  const executionTimeMs = Math.round(performance.now() - start);

  return { result, executionTimeMs };
}
