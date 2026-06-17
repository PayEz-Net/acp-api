/**
 * In-memory soft cache for /v1/team/sync.
 *
 * Keyed by (userId, projectId) — the IDP-issued userId from the active session
 * plus the project the team belongs to. Holds the last successful cloud fetch
 * for the TTL window so repeated boots / project switches inside a minute
 * don't re-hit the cloud.
 *
 * Doubles as the cloud-down fallback: when the cloud call fails we serve the
 * last entry regardless of TTL and tag the response with `warning`.
 *
 * v1.5 — re-keyed from `userId` to `(userId, projectId)` per BAPert spec §3.3.
 * A user with multiple projects gets independent cache entries; project-switch
 * doesn't invalidate the prior project's roster.
 */
import type { NormalizedAgent } from './mapper.js';

interface CacheEntry {
  agents: NormalizedAgent[];
  fetchedAt: string;
  fetchedAtMs: number;
}

const TTL_MS = 60_000;

const entries = new Map<string, CacheEntry>();

function key(userId: string, projectId: number): string {
  return `${userId}:${projectId}`;
}

export function getFresh(userId: string, projectId: number): CacheEntry | undefined {
  const e = entries.get(key(userId, projectId));
  if (!e) return undefined;
  if (Date.now() - e.fetchedAtMs > TTL_MS) return undefined;
  return e;
}

export function getStale(userId: string, projectId: number): CacheEntry | undefined {
  return entries.get(key(userId, projectId));
}

export function set(userId: string, projectId: number, agents: NormalizedAgent[]): CacheEntry {
  const now = Date.now();
  const entry: CacheEntry = {
    agents,
    fetchedAt: new Date(now).toISOString(),
    fetchedAtMs: now,
  };
  entries.set(key(userId, projectId), entry);
  return entry;
}

export function clear(userId?: string, projectId?: number): void {
  if (userId !== undefined && projectId !== undefined) {
    entries.delete(key(userId, projectId));
  } else if (userId !== undefined) {
    // Clear all entries for this user (any project)
    const prefix = `${userId}:`;
    for (const k of entries.keys()) {
      if (k.startsWith(prefix)) entries.delete(k);
    }
  } else {
    entries.clear();
  }
}
