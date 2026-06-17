/**
 * Seed the Specialist Library (60 global agent templates) into prod docstore.
 *
 * Source: everything-claude-code/skills/
 * Target: vibe.documents (client_id=0, collection='vibe_agents', table_name='agent_profiles')
 * Model: type-aware canonical (BAPert ratified 2026-05-23, #37). is_canonical is deprecated
 *        but kept as false for backward-compat in existing doc-store reads.
 *
 * Usage:
 *   DRY RUN (prints SQL):
 *     node scripts/seed-specialist-library.js
 *
 *   EXECUTE against VibeSQL:
 *     VIBESQL_URL=https://prod-vibesql.example.com/v1/query \
 *     VIBESQL_SECRET=xxx \
 *     node scripts/seed-specialist-library.js --execute
 */

const fs = require('fs');
const path = require('path');

const SKILLS_DIR = process.env.SKILLS_DIR || path.resolve(__dirname, '../../everything-claude-code/skills');
const VIBESQL_URL = process.env.VIBESQL_URL || 'http://127.0.0.1:52411/v1/query';
const VIBESQL_SECRET = process.env.VIBESQL_SECRET || '';
const START_ID = parseInt(process.env.START_ID || '201', 10);
const TARGET_COUNT = parseInt(process.env.TARGET_COUNT || '60', 10);

const EXECUTE = process.argv.includes('--execute');

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const lines = match[1].split(/\r?\n/);
  const result = {};
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      result[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return result;
}

function humanize(name) {
  return name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function deriveCategory(dir) {
  const n = dir.toLowerCase();
  if (n.includes('test') || n.includes('qa') || n.includes('e2e') || n.includes('harness') || n.includes('eval')) return 'testing';
  if (n.includes('security') || n.includes('compliance') || n.includes('hipaa') || n.includes('phi')) return 'security';
  if (n.includes('frontend') || n.includes('react') || n.includes('nextjs') || n.includes('ui') || n.includes('css') || n.includes('vue') || n.includes('angular') || n.includes('tailwind') || n.includes('electron')) return 'frontend';
  if (n.includes('backend') || n.includes('api') || n.includes('database') || n.includes('postgres') || n.includes('redis') || n.includes('django') || n.includes('fastapi') || n.includes('nestjs') || n.includes('spring')) return 'backend';
  if (n.includes('dotnet') || n.includes('csharp') || n.includes('.net')) return 'dotnet';
  if (n.includes('python') || n.includes('django')) return 'python';
  if (n.includes('go') || n.includes('golang')) return 'golang';
  if (n.includes('rust')) return 'rust';
  if (n.includes('kotlin') || n.includes('android')) return 'kotlin';
  if (n.includes('swift') || n.includes('ios')) return 'swift';
  if (n.includes('java') || n.includes('spring')) return 'java';
  if (n.includes('docker') || n.includes('k8s') || n.includes('deploy') || n.includes('devops') || n.includes('ci')) return 'devops';
  if (n.includes('design') || n.includes('ux') || n.includes('product')) return 'design';
  if (n.includes('doc') || n.includes('content') || n.includes('article') || n.includes('writing')) return 'content';
  if (n.includes('research') || n.includes('market')) return 'research';
  if (n.includes('ops') || n.includes('billing') || n.includes('logistics') || n.includes('inventory')) return 'operations';
  if (n.includes('agent') || n.includes('ai') || n.includes('llm')) return 'ai-ops';
  if (n.includes('code') || n.includes('review') || n.includes('refactor') || n.includes('build')) return 'engineering';
  return 'general';
}

function buildExpertiseTags(category, dir, description) {
  const tags = [category, dir.replace(/-/g, ' ')];
  if (description) {
    const words = description.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    tags.push(...[...new Set(words)].slice(0, 3));
  }
  return [...new Set(tags)].slice(0, 6);
}

function buildAgentProfile(dir, id) {
  const skillPath = path.join(SKILLS_DIR, dir, 'SKILL.md');
  let description = '';
  try {
    const fm = parseFrontmatter(fs.readFileSync(skillPath, 'utf-8'));
    description = fm.description || '';
  } catch {
    /* no SKILL.md */
  }

  const category = deriveCategory(dir);
  const expertiseTags = buildExpertiseTags(category, dir, description);

  return {
    id,
    slug: dir,
    name: dir,
    display_name: humanize(dir),
    description: description || `Specialist agent for ${humanize(dir)}`,
    category,
    expertise_tags: expertiseTags,
    base_prompt: description || `You are a specialist agent for ${humanize(dir)}. Help the user with tasks in this domain.`,
    model_hint: 'claude-sonnet-4-6',
    is_canonical: false,
    is_active: true,
    is_template: true,
    owner_user_id: null,
    team_id: null,
    project_id: null,
    status: 'active',
    role_preset: 'custom'
  };
}

function escapeSqlJson(obj) {
  return JSON.stringify(obj).replace(/'/g, "''");
}

function buildInsertSql(agent) {
  const json = escapeSqlJson(agent);
  return `INSERT INTO vibe.documents (client_id, user_id, collection, table_name, data, created_at, created_by)
VALUES (0, NULL, 'vibe_agents', 'agent_profiles', '${json}'::jsonb, CURRENT_TIMESTAMP, 0);`;
}

async function queryVibeSql(sql) {
  const res = await fetch(VIBESQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Secret ${VIBESQL_SECRET}`
    },
    body: JSON.stringify({ sql })
  });
  const data = await res.json().catch(() => ({ success: false }));
  return data;
}

async function main() {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`SKILLS_DIR not found: ${SKILLS_DIR}`);
    process.exit(1);
  }

  const skillDirs = fs.readdirSync(SKILLS_DIR)
    .filter(d => fs.statSync(path.join(SKILLS_DIR, d)).isDirectory())
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  console.log(`Found ${skillDirs.length} skills in ${SKILLS_DIR}`);

  // On prod we expect no agent_profiles yet, but be defensive: skip names already present.
  let existingNames = new Set();
  if (EXECUTE) {
    if (!VIBESQL_SECRET) {
      console.error('VIBESQL_SECRET is required for --execute');
      process.exit(1);
    }
    const existing = await queryVibeSql(
      `SELECT data->>'name' as name FROM vibe.documents WHERE client_id=0 AND collection='vibe_agents' AND table_name='agent_profiles'`
    );
    existingNames = new Set((existing.data || []).map(r => r.name?.toLowerCase()).filter(Boolean));
    console.log(`Existing agent_profiles on target: ${existingNames.size}`);
  }

  const selected = [];
  for (const dir of skillDirs) {
    if (existingNames.has(dir.toLowerCase())) {
      console.log('  SKIP (exists):', dir);
      continue;
    }
    selected.push(dir);
    if (selected.length >= TARGET_COUNT) break;
  }

  console.log(`Selected ${selected.length} specialists for seeding (IDs ${START_ID}–${START_ID + selected.length - 1})`);

  let nextId = START_ID;
  const agents = selected.map(dir => buildAgentProfile(dir, nextId++));

  const sqlStatements = agents.map(buildInsertSql);

  if (!EXECUTE) {
    console.log('\n-- === Specialist Library Seed SQL ===');
    console.log('-- Run this against prod VibeSQL (or set VIBESQL_URL / VIBESQL_SECRET and use --execute)');
    console.log('-- Count:', agents.length);
    console.log();
    console.log(sqlStatements.join('\n'));
    console.log('\n-- === End Seed SQL ===');
    return;
  }

  console.log('\nExecuting inserts against', VIBESQL_URL);
  for (const agent of agents) {
    const sql = buildInsertSql(agent);
    const result = await queryVibeSql(sql);
    if (!result.success) {
      console.error(`  ✗ ${agent.id} — ${agent.name}:`, JSON.stringify(result.error));
    } else {
      console.log(`  ✓ ${agent.id} — ${agent.name}`);
    }
  }

  // Verification
  const countRes = await queryVibeSql(
    `SELECT COUNT(*) as count FROM vibe.documents WHERE client_id=0 AND collection='vibe_agents' AND table_name='agent_profiles' AND data->>'is_canonical' = 'false'`
  );
  console.log('\nVerification — non-canonical count:', countRes.data?.[0]?.count);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
