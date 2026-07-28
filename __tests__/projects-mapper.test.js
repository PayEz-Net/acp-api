/**
 * WO-KIMI-MODEL-OVERRIDE: GET /v1/projects/:id/team must carry
 * effort_override + model_override through to the wire un-narrowed —
 * the spawn boundary validates, the mapper must never strip a value
 * into a silent inherit.
 */
import { jest } from '@jest/globals';

let extractAndMapTeam, extractTeamMemberEcho, mapCloudProject;

beforeAll(async () => {
  const mod = await import('../api/projects/mapper.ts');
  extractAndMapTeam = mod.extractAndMapTeam;
  extractTeamMemberEcho = mod.extractTeamMemberEcho;
  mapCloudProject = mod.mapCloudProject;
});

const memberRow = {
  agent_id: 3,
  agent_name: 'NextPert',
  agent_display_name: 'NextPert',
  canonical_role: 'dev',
  role: 'dev',
  runtime_override: 'kimi',
  work_dir_override: null,
  effort_override: 'high',
  model_override: 'kimi-for-coding-highspeed',
  position_hint: 'top-left',
  is_lead: false,
  added_at: '2026-07-17T00:00:00Z',
  added_by: 1,
};

describe('projects/mapper team passthrough', () => {
  test('carries effort_override + model_override onto the wire', () => {
    const { team } = extractAndMapTeam({ data: { project_id: 7, team: [memberRow] } });
    expect(team).toHaveLength(1);
    expect(team[0].effort_override).toBe('high');
    expect(team[0].model_override).toBe('kimi-for-coding-highspeed');
  });

  test('preserves null overrides verbatim (null = inherit, distinct from absent)', () => {
    const { team } = extractAndMapTeam({
      data: { project_id: 7, team: [{ ...memberRow, effort_override: null, model_override: null }] },
    });
    expect(team[0].effort_override).toBeNull();
    expect(team[0].model_override).toBeNull();
  });

  test('does not narrow unknown model ids — fail-loud happens at spawn, not here', () => {
    const { team } = extractAndMapTeam({
      data: { project_id: 7, team: [{ ...memberRow, model_override: 'kimi-turbo-typo' }] },
    });
    expect(team[0].model_override).toBe('kimi-turbo-typo');
  });

  test('team-member writeback echo keeps the overrides', () => {
    const echo = extractTeamMemberEcho({ data: { team_member: memberRow } });
    expect(echo?.effort_override).toBe('high');
    expect(echo?.model_override).toBe('kimi-for-coding-highspeed');
  });
});

/**
 * Live-team merge (2026-07): ProjectDto carries engaged_team_id /
 * engaged_team_name / is_complete at first paint — the desktop renders the
 * "No team engaged" CTA off engaged_team_id == null, so the sidecar mapper
 * must pass them through (null fidelity, never dropped).
 */
describe('mapCloudProject engagement fields (live-team model)', () => {
  const baseDto = {
    id: 7,
    owner_user_id: 1,
    name: 'Proj',
    description: null,
    settings: null,
    is_active: true,
    created_at: '2026-07-24T00:00:00Z',
    updated_at: null,
    member_count: 1,
    team_member_count: 0,
    runtime: 'kimi',
    target_stack: null,
    auth_method: null,
    repo_path: null,
    goal_summary: null,
    app_type: null,
    signin_choice: null,
    runtime_choice: null,
    repo_layout: null,
    stack_topology: null,
    compliance: null,
    advisor_output: null,
  };

  test('engaged project carries team id/name + is_complete', () => {
    const p = mapCloudProject({
      ...baseDto,
      engaged_team_id: 12,
      engaged_team_name: 'Core Team',
      is_complete: true,
    });
    expect(p.engaged_team_id).toBe(12);
    expect(p.engaged_team_name).toBe('Core Team');
    expect(p.is_complete).toBe(true);
  });

  test('unengaged project maps to null id/name, is_complete false', () => {
    const p = mapCloudProject({
      ...baseDto,
      engaged_team_id: null,
      engaged_team_name: null,
      is_complete: false,
    });
    expect(p.engaged_team_id).toBeNull();
    expect(p.engaged_team_name).toBeNull();
    expect(p.is_complete).toBe(false);
  });

  test('older payload without the fields still maps (null/false defaults)', () => {
    const p = mapCloudProject({ ...baseDto });
    expect(p.engaged_team_id).toBeNull();
    expect(p.engaged_team_name).toBeNull();
    expect(p.is_complete).toBe(false);
  });
});
