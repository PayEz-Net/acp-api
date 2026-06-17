/**
 * Cloud agent → normalized shape that the renderer consumes.
 *
 * Cloud carries identity (name, display_name, role_preset, is_coordinator,
 * expertise_tags, startup_order, is_active). The renderer's agentReconcile()
 * layers local UI prefs (position, color, workDir, provider) on top of this —
 * the mapper just normalizes snake_case → camelCase and drops fields the grid
 * doesn't render (identity_prompt, role_md, etc.).
 *
 * v1.5 — extended for ACP dynamic team loading (BAPert spec §3.4):
 * preserves role_preset / is_coordinator / startup_order / expertise_tags
 * so the renderer can surface chip rendering + grid ordering correctly.
 */

export interface CloudAgent {
  id: number;
  name: string;
  display_name?: string;
  description?: string;
  is_active?: boolean;
  agent_type?: string;
  tenant_id?: string;
  created_at?: string;

  // §3.4 — canonical agent_profiles document fields
  role_preset?: string;
  is_coordinator?: boolean;
  startup_order?: number;
  expertise_tags?: string[];

  // additional profile fields ignored
}

export interface NormalizedAgent {
  id: number;
  name: string;
  displayName: string;
  description?: string;
  isActive: boolean;
  agentType?: string;

  // §3.4 — propagated to renderer for grid + chip rendering
  rolePreset?: string;
  isCoordinator?: boolean;
  startupOrder?: number;
  expertiseTags?: string[];
}

export function normalizeAgent(a: CloudAgent): NormalizedAgent {
  return {
    id: a.id,
    name: a.name,
    displayName: a.display_name || a.name,
    description: a.description,
    isActive: a.is_active !== false,
    agentType: a.agent_type,
    rolePreset: a.role_preset,
    isCoordinator: a.is_coordinator === true,
    startupOrder: a.startup_order,
    expertiseTags: Array.isArray(a.expertise_tags) ? a.expertise_tags : undefined,
  };
}

export function normalizeAgents(agents: CloudAgent[] | undefined | null): NormalizedAgent[] {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((a): a is CloudAgent => a != null && typeof a.name === 'string')
    .map(normalizeAgent);
}
