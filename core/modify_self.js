function validateFunctions(customFunctions) {
  for (const [name, def] of Object.entries(customFunctions)) {
    if (def === null) continue;
    if (!def || typeof def !== 'object') {
      const err = new Error(`Invalid function definition for "${name}": must be { params: [], body: "" }`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    if (!Array.isArray(def.params)) {
      const err = new Error(`Invalid params for "${name}": must be an array of strings`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    if (typeof def.body !== 'string') {
      const err = new Error(`Invalid body for "${name}": must be a string`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
    try {
      new Function(...def.params, def.body);
    } catch (e) {
      const err = new Error(`SyntaxError in function "${name}": ${e.message}`);
      err.code = 'VALIDATION_ERROR';
      throw err;
    }
  }
}

function filterNulls(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

function mergeModifications(session, modifications) {
  const changes = [];

  if (modifications.customFunctions !== undefined) {
    session.customFunctions = filterNulls({
      ...session.customFunctions,
      ...modifications.customFunctions,
    });
    changes.push('customFunctions');
  }

  if (modifications.preferences !== undefined) {
    session.preferences = filterNulls({
      ...session.preferences,
      ...modifications.preferences,
    });
    changes.push('preferences');
  }

  if (modifications.memory !== undefined) {
    session.memory = filterNulls({
      ...session.memory,
      ...modifications.memory,
    });
    changes.push('memory');
  }

  if (modifications.character !== undefined) {
    session.character = modifications.character;
    changes.push('character');
  }

  return changes;
}

export async function modifySelf(sessionManager, agentName, modifications) {
  const loaded = await sessionManager.load(agentName);
  if (!loaded) {
    const err = new Error(`Session not found for agent "${agentName}"`);
    err.code = 'SESSION_NOT_FOUND';
    throw err;
  }

  const { session } = loaded;

  if (modifications.customFunctions) {
    validateFunctions(modifications.customFunctions);
  }

  const changes = mergeModifications(session, modifications);

  session.version += 1;
  session.updatedAt = new Date().toISOString();

  await sessionManager.save(session);

  return { session, changes };
}
