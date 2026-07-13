import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { TerminalOutputBridge, AgentOutputLine } from '../terminalOutputBridge.js';
import { LocalEventBus } from '../../sse/localEventBus.js';

describe('TerminalOutputBridge', () => {
  let bus: LocalEventBus;
  let bridge: TerminalOutputBridge;
  let emitted: AgentOutputLine[];

  beforeEach(() => {
    bus = new LocalEventBus();
    bridge = new TerminalOutputBridge(bus);
    emitted = [];
    bus.onEvent((event) => {
      if (event.event === 'agent-output') {
        emitted.push(event.data as unknown as AgentOutputLine);
      }
    });
  });

  afterEach(() => {
    bridge.stopPeriodicFlush();
  });

  it('emits a plain line', () => {
    bridge.push('BAPert', 't1', 'hello world\n');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].agent).toBe('BAPert');
    expect(emitted[0].terminal_id).toBe('t1');
    expect(emitted[0].line).toBe('hello world');
    expect(emitted[0].ts).toBeTruthy();
  });

  it('uses the provider passed to push', () => {
    bridge.push('BAPert', 't1', 'hello\n', 'claude');
    expect(emitted[0].provider).toBe('claude');
  });

  it('includes project_id in the internal event when provided', () => {
    bridge.push('BAPert', 't1', 'hello\n', 'claude', 'proj-25');
    expect(emitted[0].project_id).toBe('proj-25');
  });

  it('strips ANSI escape sequences', () => {
    bridge.push('BAPert', 't1', '\x1b[31mred\x1b[0m text\n');
    expect(emitted[0].line).toBe('red text');
  });

  it('normalizes carriage returns', () => {
    bridge.push('BAPert', 't1', 'line1\r\nline2\rline3\n');
    expect(emitted.map((e) => e.line)).toEqual(['line1', 'line2', 'line3']);
  });

  it('buffers partial lines across chunks', () => {
    bridge.push('BAPert', 't1', 'first half ');
    expect(emitted).toHaveLength(0);
    bridge.push('BAPert', 't1', 'second half\n');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].line).toBe('first half second half');
  });

  it('does not emit empty lines', () => {
    bridge.push('BAPert', 't1', '\n\nhello\n\n');
    expect(emitted.map((e) => e.line)).toEqual(['hello']);
  });

  it('keeps whitespace-only lines', () => {
    bridge.push('BAPert', 't1', '   \nhello\n  \n');
    expect(emitted.map((e) => e.line)).toEqual(['   ', 'hello', '  ']);
  });

  it('buffers per terminal independently', () => {
    bridge.push('BAPert', 't1', 'a');
    bridge.push('DotNetPert', 't2', 'b\n');
    expect(emitted.map((e) => `${e.agent}:${e.line}`)).toEqual(['DotNetPert:b']);
    bridge.push('BAPert', 't1', 'c\n');
    expect(emitted.map((e) => `${e.agent}:${e.line}`)).toEqual(['DotNetPert:b', 'BAPert:ac']);
  });

  it('flushes remaining partial line on flush()', () => {
    bridge.push('BAPert', 't1', 'no newline');
    expect(emitted).toHaveLength(0);
    bridge.flush('t1', 'BAPert');
    expect(emitted).toHaveLength(1);
    expect(emitted[0].line).toBe('no newline');
  });

  it('drops buffer on drop()', () => {
    bridge.push('BAPert', 't1', 'no newline');
    bridge.drop('t1');
    bridge.flush('t1', 'BAPert');
    expect(emitted).toHaveLength(0);
  });

  it('flushes stale partial lines when periodic flush runs', () => {
    jest.useFakeTimers();
    bridge.startPeriodicFlush(100);
    bridge.push('BAPert', 't1', 'stale');
    expect(emitted).toHaveLength(0);
    jest.advanceTimersByTime(30_100);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].line).toBe('stale');
    bridge.stopPeriodicFlush();
    jest.useRealTimers();
  });

  it('counts malformed input requests', () => {
    bridge.recordInvalidInput();
    bridge.recordInvalidInput();
    expect(bridge.getInvalidInputCount()).toBe(2);
  });

  it('throttles per-agent output to a 25-line burst then drops overflow', () => {
    // Emit 30 lines in one push (each newline-terminated line is a complete line).
    const input = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') + '\n';
    bridge.push('BAPert', 't1', input);
    expect(emitted).toHaveLength(25);
    expect(emitted[0].line).toBe('line-0');
    expect(emitted[24].line).toBe('line-24');
  });

  it('refills the per-agent token bucket over time', () => {
    jest.useFakeTimers();
    const input = Array.from({ length: 25 }, (_, i) => `line-${i}`).join('\n') + '\n';
    bridge.push('BAPert', 't1', input);
    expect(emitted).toHaveLength(25);

    // Advance 100ms -> bucket refills by 1 token (10/sec).
    jest.advanceTimersByTime(100);
    bridge.push('BAPert', 't1', 'extra\n');
    expect(emitted).toHaveLength(26);
    expect(emitted[25].line).toBe('extra');

    jest.useRealTimers();
  });

  it('throttles agents independently', () => {
    const input = Array.from({ length: 30 }, (_, i) => `line-${i}`).join('\n') + '\n';
    bridge.push('BAPert', 't1', input);
    bridge.push('DotNetPert', 't2', input);
    expect(emitted.filter((e) => e.agent === 'BAPert')).toHaveLength(25);
    expect(emitted.filter((e) => e.agent === 'DotNetPert')).toHaveLength(25);
  });
});
