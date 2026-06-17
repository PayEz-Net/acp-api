/**
 * [AuthRC] — Auth Refresh Cycle structured observability (WO-1 Deliverable D).
 *
 * One stable, greppable `[AuthRC]` prefix per event. Backs both the captured
 * main log AND a queryable ring-buffer surface (sidecar diag endpoint) so we
 * never have to "relaunch and hope it's not stale".
 *
 * Pure module: no express, no fetch, no token values. Everything here is
 * redacted-by-construction (presence/shape only) and unit-testable in
 * isolation. tokenManager writes; authDiag route reads.
 *
 * Repeat-aggregation (spec §5.5; extended in WO-2A): identical failing
 * OUTCOMEs (same IDP code) AND identical SHORT-CIRCUITs (same dead-state
 * code) collapse into a single rolling counter, namespaced by phase
 * ("short-circuited:INVALID_REFRESH_TOKEN x47 in 50s"), flushed on
 * code-change, terminal-dead, or buffer read. Keeps the terminal sequence
 * < 10 lines (acceptance §6.1) and bounds the post-dead storm to FIRST
 * occurrence + rolling summary (WO-2A acceptance).
 */

export type AuthRcPhase =
  | 'attempt'        // a refresh was initiated (trigger + cid)
  | 'dedup'          // single-flight: awaiting an in-flight refresh
  | 'token-state'    // redacted snapshot (exp, presence/shape only)
  | 'outbound'       // the actual IDP request line + status (layer-2 closure)
  | 'outcome'        // refreshed | failed | terminal-dead | short-circuited
  | 'short-circuit'  // session already terminal — zero IDP call
  | 'reset';         // terminal flag cleared (fresh login / external-session)

export interface AuthRcEntry {
  ts: string;
  phase: AuthRcPhase;
  cid?: string;
  trigger?: string;
  detail: Record<string, unknown>;
}

const RING_MAX = 200;
const ring: AuthRcEntry[] = [];

// Rolling aggregation of identical repeated events.
// [WO-2A] aggKey is the phase-namespaced collapse key:
//   'outcome:<code>'        (existing — failing IDP outcomes)
//   'short-circuit:<code>'  (new — dead-state short-circuits)
// Namespacing prevents a transient HTTP_503 outcome storm and a
// post-dead INVALID_REFRESH_TOKEN short-circuit storm from colliding
// into a single ambiguous aggregate.
let aggKey: string | null = null;
let aggCount = 0;
let aggFirstMs = 0;
let aggLastTrigger: string | undefined;

function pushRing(entry: AuthRcEntry): void {
  ring.push(entry);
  if (ring.length > RING_MAX) ring.shift();
}

function fmt(e: AuthRcEntry): string {
  const head = `${e.ts} ${e.phase}${e.cid ? ` cid=${e.cid}` : ''}${e.trigger ? ` trig=${e.trigger}` : ''}`;
  let body = '';
  try {
    body = JSON.stringify(e.detail);
  } catch {
    body = '{unserializable}';
  }
  return `[AuthRC] ${head} ${body}`;
}

/** Flush the rolling identical-event aggregate as one summary entry/line. */
function flushAggregate(reason: 'code-change' | 'terminal' | 'read'): void {
  if (aggCount <= 0 || aggKey == null) return;
  // [WO-2A] Split phase-namespaced key. indexOf(':') (not split) so a code
  // that ever contains ':' isn't truncated. detail.result stays
  // 'failed-aggregate' for parser back-compat; detail.code is the bare
  // IDP code; detail.phase_source is the new structured discriminator
  // (BAPert Q3 ruling).
  const sep = aggKey.indexOf(':');
  const phaseSource = aggKey.slice(0, sep) as 'outcome' | 'short-circuit';
  const code = aggKey.slice(sep + 1);
  const windowSec = Math.round((Date.now() - aggFirstMs) / 1000);
  const halted = reason === 'terminal';
  const noteVerb = phaseSource === 'short-circuit' ? 'short-circuited:' : '';
  const entry: AuthRcEntry = {
    ts: new Date().toISOString(),
    phase: 'outcome',
    trigger: aggLastTrigger,
    detail: {
      result: 'failed-aggregate',
      code,
      phase_source: phaseSource,
      repeats: aggCount,
      window_sec: windowSec,
      note: `${noteVerb}${code} x${aggCount} in ${windowSec}s${halted ? ' — HALTED' : ''}`,
    },
  };
  pushRing(entry);
  // Aggregate is an error-class summary regardless of source phase
  // (BAPert Q1 ruling: preserve existing channel split — first occurrence
  // routes per its source phase, aggregate stays on console.error).
  console.error(fmt(entry));
  aggKey = null;
  aggCount = 0;
  aggFirstMs = 0;
  aggLastTrigger = undefined;
}

/**
 * Record one [AuthRC] event. Repeated identical failing outcomes AND
 * repeated identical short-circuits are aggregated (phase-namespaced)
 * rather than logged line-by-line. WO-2A: extends the aggregator from
 * outcome-only to (outcome|short-circuit) × code.
 */
export function authRc(entry: Omit<AuthRcEntry, 'ts'>): void {
  // [WO-2A] Repeatable iff (outcome+failed+code) OR (short-circuit+code).
  // The key namespace stops a transient HTTP_503 outcome run and a
  // post-dead INVALID_REFRESH_TOKEN short-circuit run from being collapsed
  // into one ambiguous aggregate.
  const repeatableKey: string | null =
    (entry.phase === 'outcome' && entry.detail?.result === 'failed' && typeof entry.detail?.code === 'string')
      ? `outcome:${entry.detail.code as string}`
    : (entry.phase === 'short-circuit' && typeof entry.detail?.code === 'string')
      ? `short-circuit:${entry.detail.code as string}`
    : null;

  if (repeatableKey) {
    if (aggKey === repeatableKey) {
      aggCount += 1;
      aggLastTrigger = entry.trigger ?? aggLastTrigger;
      return; // collapse — do not emit a line per repeat
    }
    // a different key (or first occurrence) — flush any prior run, start new
    flushAggregate('code-change');
    aggKey = repeatableKey;
    aggCount = 1;
    aggFirstMs = Date.now();
    aggLastTrigger = entry.trigger;
    // fall through: emit the FIRST occurrence so the storm's onset is visible
  } else if (aggCount > 0 && entry.phase === 'outcome') {
    // a non-failed outcome ends an in-flight run — summarize what came before
    flushAggregate('code-change');
  }

  const full: AuthRcEntry = { ts: new Date().toISOString(), ...entry };
  pushRing(full);

  // terminal-dead / short-circuit / reset are errors-worth-surfacing;
  // refreshed is normal; everything else informational.
  const line = fmt(full);
  if (
    full.phase === 'outcome' &&
    (full.detail?.result === 'terminal-dead' || full.detail?.result === 'failed')
  ) {
    console.error(line);
  } else if (full.phase === 'short-circuit') {
    console.warn(line);
  } else {
    console.log(line);
  }

  // Terminal-dead closes the storm: flush the aggregate with HALTED.
  if (full.phase === 'outcome' && full.detail?.result === 'terminal-dead') {
    flushAggregate('terminal');
  }
}

/** Recent ring-buffer for the sidecar diag endpoint (Deliverable D §5.6). */
export function getAuthRc(limit = 50): AuthRcEntry[] {
  flushAggregate('read'); // make any in-progress storm visible to the query
  const n = Math.max(1, Math.min(limit, RING_MAX));
  return ring.slice(-n);
}

/** Test/diagnostic helper — clears ring + aggregation state. */
export function _resetAuthRc(): void {
  ring.length = 0;
  aggKey = null;
  aggCount = 0;
  aggFirstMs = 0;
  aggLastTrigger = undefined;
}
