/**
 * Wave 2 + post-rename + Wave B Ship B: in-memory soft cache for project
 * sync surface. Three slots:
 *   - `list`    — full project list per developer (keyed by user_id)
 *   - `current` — current-project pointer per developer (keyed by user_id)
 *   - `team`    — per-project team roster (keyed by user_id:project_id —
 *                  cloud auth-checks owner/member, so per-(user, project)
 *                  caching avoids cross-user cache leaks even though the
 *                  underlying team is project-scoped not user-scoped)
 *
 *   getFresh()  honors TTL — returns null past 60s.
 *   getStale()  ignores TTL — used as the cloud-unreachable fallback.
 *
 * Cache invalidation:
 *   - PUT /v1/projects/current writeback → clear `current` for user
 *   - PUT /v1/projects/:id (project attrs) → clear `list` for user (if
 *     name/description/is_active changed; mapper-shape changed too) +
 *     `current` for user (if focused project) + `team` for user:projectId
 *     (defensive — team_member_count may have changed)
 *   - PUT /v1/projects/:id/team/:agent_id (team-member overrides) →
 *     clear `team` for user:projectId
 */

import type {
  MappedProject,
  CurrentProjectState,
  MappedProjectTeamMember,
} from './mapper.js';

const TTL_MS = 0;

export interface ProjectListEntry {
  projects: MappedProject[];
  fetchedAt: string;
}

export interface CurrentProjectEntry {
  current_project_id: number | null;
  project: MappedProject | null;
  current_project_state: CurrentProjectState;
  fetchedAt: string;
}

const listStore = new Map<string, ProjectListEntry & { fetchedAtMs: number }>();
const currentStore = new Map<string, CurrentProjectEntry & { fetchedAtMs: number }>();

function freshGet<T extends { fetchedAtMs: number }>(
  store: Map<string, T>,
  userId: string,
): T | null {
  const entry = store.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAtMs > TTL_MS) return null;
  return entry;
}

function staleGet<T>(store: Map<string, T>, userId: string): T | null {
  return store.get(userId) ?? null;
}

export const list = {
  getFresh(userId: string): ProjectListEntry | null {
    const entry = freshGet(listStore, userId);
    if (!entry) return null;
    return { projects: entry.projects, fetchedAt: entry.fetchedAt };
  },
  getStale(userId: string): ProjectListEntry | null {
    const entry = staleGet(listStore, userId);
    if (!entry) return null;
    return { projects: entry.projects, fetchedAt: entry.fetchedAt };
  },
  set(userId: string, projects: MappedProject[]): ProjectListEntry {
    const now = Date.now();
    const entry = {
      projects,
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
    };
    listStore.set(userId, entry);
    return { projects: entry.projects, fetchedAt: entry.fetchedAt };
  },
  clear(userId?: string): void {
    if (userId) listStore.delete(userId);
    else listStore.clear();
  },
};

export interface ProjectTeamEntry {
  project_id: number;
  team: MappedProjectTeamMember[];
  fetchedAt: string;
}

const teamStore = new Map<string, ProjectTeamEntry & { fetchedAtMs: number }>();

function teamKey(userId: string, projectId: number): string {
  return `${userId}:${projectId}`;
}

export const team = {
  getFresh(userId: string, projectId: number): ProjectTeamEntry | null {
    const entry = freshGet(teamStore, teamKey(userId, projectId));
    if (!entry) return null;
    return {
      project_id: entry.project_id,
      team: entry.team,
      fetchedAt: entry.fetchedAt,
    };
  },
  getStale(userId: string, projectId: number): ProjectTeamEntry | null {
    const entry = staleGet(teamStore, teamKey(userId, projectId));
    if (!entry) return null;
    return {
      project_id: entry.project_id,
      team: entry.team,
      fetchedAt: entry.fetchedAt,
    };
  },
  set(
    userId: string,
    projectId: number,
    teamRoster: MappedProjectTeamMember[],
  ): ProjectTeamEntry {
    const now = Date.now();
    const entry = {
      project_id: projectId,
      team: teamRoster,
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
    };
    teamStore.set(teamKey(userId, projectId), entry);
    return {
      project_id: entry.project_id,
      team: entry.team,
      fetchedAt: entry.fetchedAt,
    };
  },
  /**
   * Clear scoped to (user, project). Pass projectId only to clear all users
   * (used by PUT /v1/projects/:id when project attrs change — every user's
   * cached team for that project is suspect).
   */
  clear(userId?: string, projectId?: number): void {
    if (userId !== undefined && projectId !== undefined) {
      teamStore.delete(teamKey(userId, projectId));
      return;
    }
    if (projectId !== undefined) {
      const suffix = `:${projectId}`;
      for (const key of teamStore.keys()) {
        if (key.endsWith(suffix)) teamStore.delete(key);
      }
      return;
    }
    teamStore.clear();
  },
};

export const current = {
  getFresh(userId: string): CurrentProjectEntry | null {
    const entry = freshGet(currentStore, userId);
    if (!entry) return null;
    return {
      current_project_id: entry.current_project_id,
      project: entry.project,
      current_project_state: entry.current_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  getStale(userId: string): CurrentProjectEntry | null {
    const entry = staleGet(currentStore, userId);
    if (!entry) return null;
    return {
      current_project_id: entry.current_project_id,
      project: entry.project,
      current_project_state: entry.current_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  set(
    userId: string,
    payload: {
      current_project_id: number | null;
      project: MappedProject | null;
      current_project_state: CurrentProjectState;
    },
  ): CurrentProjectEntry {
    const now = Date.now();
    const entry = {
      ...payload,
      fetchedAt: new Date(now).toISOString(),
      fetchedAtMs: now,
    };
    currentStore.set(userId, entry);
    return {
      current_project_id: entry.current_project_id,
      project: entry.project,
      current_project_state: entry.current_project_state,
      fetchedAt: entry.fetchedAt,
    };
  },
  clear(userId?: string): void {
    if (userId) currentStore.delete(userId);
    else currentStore.clear();
  },
};
