/**
 * WO-KIMI-MODEL-OVERRIDE: GET /v1/projects/:id/team must carry
 * effort_override + model_override through to the wire un-narrowed —
 * the spawn boundary validates, the mapper must never strip a value
 * into a silent inherit.
 */
import { jest } from '@jest/globals';

let extractAndMapTeam, extractTeamMemberEcho;

beforeAll(async () => {
  const mod = await import('../api/projects/mapper.ts');
  extractAndMapTeam = mod.extractAndMapTeam;
  extractTeamMemberEcho = mod.extractTeamMemberEcho;
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
