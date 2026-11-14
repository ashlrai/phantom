import { describe, expect, it } from 'vitest';
import { decodeReplay, parseReplayJson, seekReplay } from './replay-model.js';
import { fixtureRecording } from './fixture.test-support.js';

function turn(turnId: string, offset: number) {
  return fixtureRecording().events.map((event) => ({ ...event, turnId, seq: (event.seq as number) + offset }));
}

describe('replay redaction regressions', () => {
  it('removes free-text assigned values from unlabelled echoes throughout the recording', () => {
    const fixture = fixtureRecording();
    fixture.events[0]!.text = "Use password='reed' and --capability opal.";
    fixture.events[5]!.output = 'The supplied values were reed and opal.';
    fixture.events[7]!.text = 'Received reed and opal.';
    fixture.title = 'Values reed and opal';
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    const rendered = JSON.stringify(result);
    expect(rendered).toContain('[REDACTED]');
    expect(rendered).not.toContain('reed');
    expect(rendered).not.toContain('opal');
  });

  it('removes short structured authentication values and unlabelled echoes', () => {
    const fixture = fixtureRecording();
    fixture.events[2]!.input = { file_path: 'hello.ts', auth: 'fern' };
    fixture.events[5]!.output = 'Received fern.';
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('fern');
    expect(JSON.stringify(result)).toContain('[REDACTED]');
  });

  it('honors supplied sensitive values in native session imports', () => {
    const events = turn('latest', 0);
    events[0]!.text = 'Received an opaque native-value.';
    const result = parseReplayJson(JSON.stringify({
      session: { title: 'Native native-value' }, events, sensitiveValues: ['native-value'],
    }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('native-value');
  });

  it('uses sensitive values from earlier turns when selecting the latest finished run', () => {
    const earlier = turn('earlier', 0);
    earlier[2]!.input = { token: 'prior-value' };
    const latest = turn('latest', 9);
    latest[0]!.text = 'The previous value was prior-value.';
    latest[5]!.output = 'Echoed prior-value.';
    const result = parseReplayJson(JSON.stringify({ session: { title: 'Recorded chat' }, events: [...earlier, ...latest] }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('prior-value');
    expect(result.ok && result.recording.steps[0]!.seq).toBe(10);
  });

  it('redacts overlapping known values identically regardless of event arrival order', () => {
    const fixture = fixtureRecording();
    fixture.events[0]!.text = 'An ababa overlap';
    fixture.events[2]!.input = { token: 'aba' };
    fixture.events[4]!.input = { secret: 'bab' };
    const first = decodeReplay(fixture);
    const reversed = decodeReplay({ ...fixture, events: [...fixture.events].reverse() });
    expect(first.ok).toBe(true);
    expect(reversed).toEqual(first);
  });

  it('redacts overlapping supplied values identically regardless of supplied order', () => {
    const fixture = fixtureRecording();
    fixture.events[0]!.text = 'An ababa overlap';
    const first = decodeReplay({ ...fixture, sensitiveValues: ['aba', 'bab'] });
    const reversed = decodeReplay({ ...fixture, sensitiveValues: ['bab', 'aba'] });
    expect(first.ok).toBe(true);
    expect(reversed).toEqual(first);
  });
});

describe('native recording and terminal run regressions', () => {
  it('rejects duplicate sequence numbers across turns before selecting a finished run', () => {
    const events = [...turn('earlier', 0), ...turn('latest', 8)];
    const native = { session: { title: 'Recorded chat' }, events };
    const first = parseReplayJson(JSON.stringify(native));
    const reversed = parseReplayJson(JSON.stringify({ ...native, events: [...events].reverse() }));
    expect(first.ok).toBe(false);
    expect(reversed).toEqual(first);
  });

  it('accepts persisted remote status and PR events in a finished provider run', () => {
    const fixture = fixtureRecording();
    fixture.events = fixture.events.map((event) => ({ ...event, seq: (event.seq as number) * 10 }));
    const base = { at: '2026-10-26T06:00:00.000Z', turnId: 'turn-fixture', provider: 'devin' };
    fixture.events.push(
      { ...base, seq: 65, type: 'remote-status', state: 'finished', message: 'Remote work finished.', url: null, acusConsumed: null, acuCap: null },
      { ...base, seq: 66, type: 'remote-pr', url: 'https://github.com/example/repo/pull/1', state: 'open' },
    );
    const result = parseReplayJson(JSON.stringify({ session: { title: 'Recorded provider run' }, events: fixture.events }));
    expect(result.ok).toBe(true);
    expect(result.ok && result.recording.steps.at(-1)!.label).toBe('Run completed');
  });

  it.each(['cancelled', 'failed'])('preserves a partial assistant stream in a %s run without a final message', (mode) => {
    const fixture = fixtureRecording();
    fixture.events = fixture.events.filter((event) => event.type !== 'assistant-message');
    fixture.events.find((event) => event.type === 'text-delta')!.text = 'Partial response from the agent.';
    fixture.events[fixture.events.length - 1] = {
      ...fixture.events.at(-1), type: mode === 'cancelled' ? 'cancelled' : 'turn-done', ok: false,
    };
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const partial = result.recording.steps.find((step) => step.kind === 'message' && step.text.includes('Partial response'));
    expect(partial).toBeDefined();
    expect(partial!.seq).toBe(7);
    const beforePartial = result.recording.steps.findIndex((step) => step === partial);
    expect(JSON.stringify(seekReplay(result.recording, beforePartial))).not.toContain('Partial response');
    expect(result.recording.steps.at(-1)!.label).toBe(mode === 'cancelled' ? 'Run cancelled' : 'Run failed');
  });
});
