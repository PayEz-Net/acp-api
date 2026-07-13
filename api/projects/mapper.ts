/**
 * Wave 2 + post-rename + Wave A.1 enriched: cloud `ProjectDto` → wire shape.
 *
 * Three-state focus-pointer enum is `stored | unset | empty` (per spec §5.4):
 *   stored — developer_current_project row exists, project loaded normally.
 *   unset  — no row, but developer has ≥1 project — picker prompts.
 *   empty  — developer has zero projects — create-CTA pointing at idealvibe.
 * Cloud no longer returns a first-project hint when the row is absent — it
 * returns null + state='unset' and the FE prompts the user to pick. Memory
 * rule `feedback_no_unjustified_fallback` enforces.
 *
 * Wave A.1 (DotNetPert msg 1018, cloud image 6f57e773398c): ProjectDto now
 * carries 12 enriched attribute fields total — Wave A's 5 (runtime,
 * target_stack, auth_method, repo_path, goal_summary) + Wave A.1's 7
 * (app_type, signin_choice, runtime_choice, repo_layout, stack_topology,
 * compliance, advisor_output) — plus team_member_count alongside member_count.
 *
 * Mapper preserves null/undefined fidelity:
 *   - `description: null` from cloud → `undefined` on wire (FE expects optional)
 *   - `updated_at: null` → falls back to `created_at` (FE type non-optional)
 *   - All Wave A/A.1 nullable fields → null preserved on wire (FE renders "—"
 *     placeholders per Wave B settings panel spec §4.2 — distinct from "absent
 *     in payload" which would be a cloud bug)
 *   - `runtime` is NOT NULL at DB (CHECK-constrained); pass through directly
 *   - `runtime_choice` is the user-team-runtime preference (Wave A.1 nullable)
 *     vs `runtime` the project default (Wave A NOT NULL). Memory rule
 *     `feedback_runtime_choice_vs_platform_llm` keeps these distinct.
 */

export type CurrentProjectState = 'stored' | 'unset' | 'empty';
export type RuntimeId = 'claude' | 'kimi';

export interface CloudProjectDto {
  id: number;
  owner_user_id: number;
  name: string;
  description: string | null;
  settings: unknown | null;
  is_active: boolean;
  created_at: string;
  updated_at: string | null;
  member_count: number;
  team_member_count: number;
  // Wave A enriched
  runtime: RuntimeId;
  target_stack: string | null;
  auth_method: string | null;
  repo_path: string | null;
  goal_summary: string | null;
  // Wave A.1 enriched
  app_type: string | null;
  signin_choice: string | null;
  runtime_choice: RuntimeId | null;
  repo_layout: string | null;
  stack_topology: string | null;
  compliance: unknown[] | null;
  advisor_output: unknown | null;
}

export interface CloudProjectMemberDto {
  id: number;
  project_id: number;
  user_id: number;
  role: 'owner' | 'admin' | 'member' | 'viewer';
  invited_by: number | null;
  joined_at: string;
  is_active: boolean;
}

/**
 * Cloud `ProjectTeamMemberDto` (Wave A `vibe_projects.project_team_members`,
 * joined with `vibe_agents.agents` on agent_id) — per-project agent record
 * with override fields. Distinct from `CloudProjectMemberDto` which is
 * people-membership; this is the agent-team record.
 */
export interface CloudProjectTeamMemberDto {
  agent_id: number;
  agent_name: string;
  agent_display_name: string | null;
  canonical_role: string | null;
  role: string | null;
  runtime_override: RuntimeId | null;
  work_dir_override: string | null;
  position_hint: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | null;
  is_lead: boolean;
  added_at: string;
  added_by: number | null;
}

/**
 * Wire shape for `GET /v1/projects/:id/team`. Pass-through of cloud DTO —
 * no field renames or null-collapsing. FE settings panel + Wave C
 * instantiation lifecycle both consume this shape directly.
 */
export type MappedProjectTeamMember = CloudProjectTeamMemberDto;

export interface MappedProject {
  id: number;
  owner_user_id: number;
  name: string;
  description?: string;
  status: 'active' | 'archived';
  is_active: boolean;
  created_at: string;
  updated_at: string;
  member_count: number;
  team_member_count: number;
  // Wave A enriched
  runtime: RuntimeId;
  target_stack: string | null;
  auth_method: string | null;
  repo_path: string | null;
  goal_summary: string | null;
  // Wave A.1 enriched
  app_type: string | null;
  signin_choice: string | null;
  runtime_choice: RuntimeId | null;
  repo_layout: string | null;
  stack_topology: string | null;
  compliance: unknown[] | null;
  advisor_output: unknown | null;
}

export function mapCloudProject(p: CloudProjectDto): MappedProject {
  return {
    id: p.id,
    owner_user_id: p.owner_user_id,
    name: p.name,
    ...(p.description ? { description: p.description } : {}),
    status: p.is_active ? 'active' : 'archived',
    is_active: p.is_active,
    created_at: p.created_at,
    updated_at: p.updated_at ?? p.created_at,
    member_count: p.member_count,
    team_member_count: p.team_member_count,
    // Wave A
    runtime: p.runtime,
    target_stack: p.target_stack ?? null,
    auth_method: p.auth_method ?? null,
    repo_path: p.repo_path ?? null,
    goal_summary: p.goal_summary ?? null,
    // Wave A.1
    app_type: p.app_type ?? null,
    signin_choice: p.signin_choice ?? null,
    runtime_choice: p.runtime_choice ?? null,
    repo_layout: p.repo_layout ?? null,
    stack_topology: p.stack_topology ?? null,
    compliance: Array.isArray(p.compliance) ? p.compliance : null,
    advisor_output: p.advisor_output ?? null,
  };
}

/**
 * Pull `data.projects` out of the cloud envelope and map.
 */
export function extractAndMapList(cloudPayload: unknown): MappedProject[] {
  const data = (cloudPayload as any)?.data;
  const projects = data?.projects;
  if (!Array.isArray(projects)) return [];
  return projects.map(mapCloudProject);
}

/**
 * Pull `data.{current_project_id, project, current_project_state}` out of
 * the cloud envelope (`/v1/users/me/current-project`).
 *
 * `current_project_id` is forced to null when state is 'unset' or 'empty' —
 * the FE first-boot-prompt branch depends on the absence of a project_id
 * to render the picker. We do NOT pass through any cloud-supplied
 * fallback-first hint per `feedback_no_unjustified_fallback`.
 */
export function extractAndMapCurrent(cloudPayload: unknown): {
  current_project_id: number | null;
  project: MappedProject | null;
  current_project_state: CurrentProjectState;
} {
  const data = (cloudPayload as any)?.data ?? {};

  const stateRaw =
    typeof data.current_project_state === 'string' ? data.current_project_state : '';
  const current_project_state: CurrentProjectState =
    stateRaw === 'stored' ? 'stored'
    : stateRaw === 'empty' ? 'empty'
    : 'unset';

  const project =
    current_project_state === 'stored' && data.project ? mapCloudProject(data.project) : null;
  const current_project_id =
    current_project_state === 'stored' && typeof data.current_project_id === 'number'
      ? data.current_project_id
      : null;

  return { current_project_id, project, current_project_state };
}

/**
 * For `GET /v1/projects/:id` — returns the project + its members. Members
 * pass through with no shape change (FE may consume directly).
 */
export function extractAndMapDetail(cloudPayload: unknown): {
  project: MappedProject | null;
  members: CloudProjectMemberDto[];
} {
  const data = (cloudPayload as any)?.data ?? {};
  const project = data.project ? mapCloudProject(data.project) : null;
  const members = Array.isArray(data.members) ? data.members : [];
  return { project, members };
}

/**
 * For `GET /v1/projects/:id/team` — returns the agent-team roster ordered
 * by `is_lead DESC, agent_name ASC` (server-side per DotNetPert msg 987).
 * Pass-through — null fields preserved on the wire so FE settings panel
 * can render "inherits ..." italic for null override slots.
 */
export function extractAndMapTeam(cloudPayload: unknown): {
  project_id: number | null;
  team: MappedProjectTeamMember[];
} {
  const data = (cloudPayload as any)?.data ?? {};
  const project_id = typeof data.project_id === 'number' ? data.project_id : null;
  const team = Array.isArray(data.team) ? (data.team as MappedProjectTeamMember[]) : [];
  return { project_id, team };
}

/**
 * For `PUT /v1/projects/:id/team/:agent_id` writeback — extracts the
 * single team_member echo. Cloud returns `{ team_member: ProjectTeamMemberDto }`.
 */
export function extractTeamMemberEcho(cloudPayload: unknown): MappedProjectTeamMember | null {
  const data = (cloudPayload as any)?.data ?? {};
  const tm = data.team_member;
  return tm && typeof tm === 'object' ? (tm as MappedProjectTeamMember) : null;
}
