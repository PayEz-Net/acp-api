import { randomUUID } from 'node:crypto';
import { computeRelevanceMatrix, shouldApproach, getInteractionType } from './relevance.js';

export class PartyEngine {
  constructor(storage, cfg = {}) {
    this._storage = storage;
    this._tickMs = cfg.partyTickMs || 5000;
    this._timer = null;
    this._running = false;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this.tick(), this._tickMs);
  }

  stop() {
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  get running() {
    return this._running;
  }

  async tick() {
    try {
      const signals = await this._storage.listSignals();
      if (signals.length < 2) return;

      const matrix = computeRelevanceMatrix(signals);

      const barAgents = signals.filter((s) => s.zone === 'bar' || s.zone === 'entrance');
      const activeMingles = await this._storage.listActiveMingles();
      const minglingAgents = new Set();
      for (const m of activeMingles) {
        minglingAgents.add(m.agentA || m.agent_a);
        minglingAgents.add(m.agentB || m.agent_b);
      }

      for (const agent of barAgents) {
        if (minglingAgents.has(agent.agentId)) continue;
        for (const other of signals) {
          if (agent.agentId === other.agentId) continue;
          if (minglingAgents.has(other.agentId)) continue;
          const score = matrix[agent.agentId]?.[other.agentId] || 0;
          if (shouldApproach(agent, other, score)) {
            const interactionType = getInteractionType(score);
            if (interactionType) {
              await this._initiateMingle(agent, other, interactionType, score);
              minglingAgents.add(agent.agentId);
              minglingAgents.add(other.agentId);
              break;
            }
          }
        }
      }

      await this._driftPositions(signals, matrix);
      await this._resolveCompletedMingles(activeMingles);
    } catch (err) {
      console.error('[PartyEngine] Tick error:', err.message);
    }
  }

  async _initiateMingle(agentA, agentB, interactionType, _score) {
    const mingle = {
      mingleId: `mingle_${randomUUID()}`,
      agentA: agentA.agentId,
      agentB: agentB.agentId,
      interactionType,
      topic: agentA.workingOn || agentB.workingOn || null,
      outcome: 'pending',
      startedAt: new Date().toISOString(),
    };
    await this._storage.createMingle(mingle);
    return mingle;
  }

  async _driftPositions(signals, matrix) {
    for (const agent of signals) {
      const scores = matrix[agent.agentId] || {};
      let bestTarget = null;
      let bestScore = 0;
      for (const [otherId, score] of Object.entries(scores)) {
        if (score > bestScore) {
          bestScore = score;
          bestTarget = otherId;
        }
      }
      if (bestTarget && bestScore >= 40) {
        const target = signals.find((s) => s.agentId === bestTarget);
        if (target) {
          const targetX = target.positionX ?? target.position_x ?? 50;
          const targetY = target.positionY ?? target.position_y ?? 50;
          const currentX = agent.positionX ?? agent.position_x ?? 50;
          const currentY = agent.positionY ?? agent.position_y ?? 50;
          const newX = currentX + (targetX - currentX) * 0.1;
          const newY = currentY + (targetY - currentY) * 0.1;
          await this._storage.upsertSignal({
            ...agent,
            agentId: agent.agentId || agent.agent_id,
            agentName: agent.agentName || agent.agent_name,
            positionX: newX,
            positionY: newY,
          });
        }
      }
    }
  }

  async _resolveCompletedMingles(mingles) {
    const now = Date.now();
    for (const mingle of mingles) {
      const startedAt = new Date(mingle.startedAt || mingle.started_at).getTime();
      const type = mingle.interactionType || mingle.interaction_type;
      let durationMs;
      if (type === 'gossip') durationMs = 10000;
      else if (type === 'chit_chat') durationMs = 60000;
      else durationMs = 600000;

      if (now - startedAt >= durationMs) {
        const id = mingle.mingleId || mingle.mingle_id;
        await this._storage.updateMingle(id, {
          outcome: 'completed',
          endedAt: new Date().toISOString(),
        });
      }
    }
  }
}
