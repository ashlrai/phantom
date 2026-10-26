import { describe, expect, it } from 'vitest';
import { decodeReplay, MAX_RECORDING_BYTES, parseReplayJson, replayFromEvents, seekReplay } from './replay-model.js';
import { fixtureRecording } from './fixture.test-support.js';

function decoded() {
  const result = decodeReplay(fixtureRecording());
  if (!result.ok) throw new Error(result.error);
  return result.recording;
}

describe('deterministic recorded replay', () => {
  it('replays the finished fixture in sequence with messages, commands, diffs and results', () => {
    const recording = decoded();
    expect(recording.steps.map((s) => s.kind)).toEqual(['message', 'status', 'diff', 'output', 'command', 'output', 'message', 'status']);
    expect(recording.steps[2]!.text).toContain("+export const hello = 'Hello';");
    expect(recording.steps[4]!.text).toBe('npm test -- hello.test.ts');
    expect(recording.steps.at(-1)!.label).toBe('Run completed');
    expect(recording.steps.filter((s) => s.label === 'Agent')).toHaveLength(1);
    expect(Object.isFrozen(recording.steps)).toBe(true);
  });
  it('gives byte-identical snapshots for reversed input order and repeated playback', () => {
    const fixture = fixtureRecording();
    const first = decoded();
    const reversed = decodeReplay({ ...fixture, events: fixture.events.reverse() });
    expect(reversed).toEqual({ ok: true, recording: first });
    const play = () => Array.from({ length: first.steps.length + 1 }, (_, n) => JSON.stringify(seekReplay(first, n)));
    expect(play()).toEqual(play());
    expect(seekReplay(first, 3)).toEqual(seekReplay(first, 3));
  });
  it('never reveals a future result or assistant message before its event', () => {
    const recording = decoded();
    const early = JSON.stringify(seekReplay(recording, 5));
    expect(early).not.toContain('1 test passed');
    expect(early).not.toContain('Updated the greeting.');
    expect(recording.steps[2]!.label).toBe('Proposed changes');
  });
  it('seeks backward and restarts without changing the recording', () => {
    const recording = decoded();
    const original = JSON.stringify(recording);
    expect(seekReplay(recording, 100)).toHaveLength(8);
    expect(seekReplay(recording, 2.8)).toHaveLength(2);
    expect(seekReplay(recording, -1)).toEqual([]);
    expect(seekReplay(recording, NaN)).toEqual([]);
    expect(seekReplay(recording, 0)).toEqual([]);
    expect(JSON.stringify(recording)).toBe(original);
  });
  it('accepts a cancelled finished run and reports failures honestly', () => {
    const fixture = fixtureRecording();
    fixture.events[8] = { ...fixture.events[8], type: 'cancelled' };
    const cancelled = decodeReplay(fixture);
    expect(cancelled.ok && cancelled.recording.steps.at(-1)!.label).toBe('Run cancelled');
    fixture.events[8] = { ...fixture.events[8], type: 'turn-done', ok: false };
    const failed = decodeReplay(fixture);
    expect(failed.ok && failed.recording.steps.at(-1)!.label).toBe('Run failed');
  });
  it.each(['unfinished', 'duplicate', 'mixed-turn', 'bad-time', 'bad-seq', 'unknown-event', 'orphan-result', 'missing-start', 'unsettled-tool'])('rejects %s with a fixed safe error', (mode) => {
    const fixture = fixtureRecording();
    if (mode === 'unfinished') fixture.events.pop();
    if (mode === 'duplicate') fixture.events.push(fixture.events[0]!);
    if (mode === 'mixed-turn') fixture.events[3]!.turnId = 'other';
    if (mode === 'bad-time') fixture.events[0]!.at = 'credential-value';
    if (mode === 'bad-seq') fixture.events[0]!.seq = Infinity;
    if (mode === 'unknown-event') fixture.events[3]!.type = 'secret-event';
    if (mode === 'orphan-result') fixture.events[3]!.toolUseId = 'missing';
    if (mode === 'missing-start') fixture.events = fixture.events.filter((e) => e.type !== 'turn-started');
    if (mode === 'unsettled-tool') fixture.events = fixture.events.filter((e) => e.seq !== 6);
    expect(decodeReplay(fixture)).toEqual({ ok: false, error: 'Choose a complete, valid run recording (up to 2 MB).' });
  });
  it('caps JSON bytes, event count, strings and nesting without echoing the source', () => {
    expect(parseReplayJson('x'.repeat(MAX_RECORDING_BYTES + 1)).ok).toBe(false);
    expect(parseReplayJson('{ bad json secret-value').ok).toBe(false);
    expect(decodeReplay({ ...fixtureRecording(), events: Array(5001).fill({}) }).ok).toBe(false);
    const fixture = fixtureRecording();
    fixture.events[0]!.text = 'a'.repeat(32_001);
    expect(decodeReplay(fixture).ok).toBe(false);
    fixture.events[0]!.text = 'Hello';
    let nested: unknown = {};
    for (let i = 0; i < 25; i++) nested = { nested };
    fixture.events[2]!.input = nested;
    expect(decodeReplay(fixture).ok).toBe(false);
  });
  it('snapshots the latest finished turn and excludes subsequent running events', () => {
    const events = fixtureRecording().events as { type: string; turnId: string; seq: number }[];
    const result = replayFromEvents([...events, { type: 'turn-started', turnId: 'new', seq: 10 }]);
    expect(result.ok && result.recording.steps).toHaveLength(8);
    expect(replayFromEvents([{ type: 'error', turnId: 'new', seq: 1 }]).ok).toBe(false);
  });
  it('imports native VerseSessionDetail recorded data without a custom export endpoint', () => {
    const fixture = fixtureRecording();
    const result = parseReplayJson(JSON.stringify({ session: { title: 'Recorded chat' }, events: fixture.events }));
    expect(result.ok && result.recording.title).toBe('Recorded chat');
    expect(result.ok && result.recording.steps).toEqual(decoded().steps);
  });
  it('labels explicit command exit failure even when the provider omits isError', () => {
    const fixture = fixtureRecording();
    fixture.events[5]!.output = 'Exit code: 1';
    const result = decodeReplay(fixture);
    expect(result.ok && result.recording.steps[5]!.label).toBe('Tool failed');
  });
  it.each(['duplicate-start', 'command-before-start', 'local-time'])('rejects ambiguous lifecycle or timezone: %s', (mode) => {
    const fixture = fixtureRecording();
    if (mode === 'duplicate-start') fixture.events[6]!.type = 'turn-started';
    if (mode === 'command-before-start') {
      fixture.events[1]!.seq = 3;
      fixture.events[2]!.seq = 2;
    }
    if (mode === 'local-time') fixture.events[0]!.at = '2026-10-26T06:00:00';
    expect(decodeReplay(fixture).ok).toBe(false);
  });
});

describe('replay redaction boundary', () => {
  it('redacts credentials split across stream frames and their later echoes', () => {
    const fixture = fixtureRecording();
    fixture.events = fixture.events.filter((event) => event.type !== 'assistant-message');
    fixture.events.find((event) => event.type === 'text-delta')!.text = 'to';
    fixture.events.push({ seq: 8, at: '2026-10-26T06:00:00.000Z', turnId: 'turn-fixture', type: 'text-delta', text: 'ken=stream-opaque' });
    fixture.events[5]!.output = 'Echo stream-opaque';
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('stream-opaque');
  });
  it('collects credentials from prefixed nested JSON before redacting later echoes', () => {
    const fixture = fixtureRecording();
    fixture.events[0]!.text = 'response: {"auth":{"value":"nested-opaque"}}';
    fixture.events[5]!.output = 'Received nested-opaque';
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('nested-opaque');
    fixture.events[0]!.text = 'response: {"auth": {value: ambiguous}}';
    expect(decodeReplay(fixture).ok).toBe(false);
  });
  it('collects native metadata and other turns for redaction before selecting finished events', () => {
    const fixture = fixtureRecording();
    fixture.events[0]!.text = 'Echo metadata-credential and earlier-credential and future-credential';
    const source = {
      session: { title: 'metadata-credential', token: 'metadata-credential' },
      events: [
        { seq: 0, type: 'tool-use', turnId: 'older', input: { token: 'earlier-credential' } },
        ...fixture.events,
        { seq: 10, type: 'tool-use', turnId: 'running', input: { capability: 'future-credential' } },
      ],
    };
    const result = parseReplayJson(JSON.stringify(source));
    expect(result.ok).toBe(true);
    const output = JSON.stringify(result);
    for (const value of ['metadata-credential', 'earlier-credential', 'future-credential']) expect(output).not.toContain(value);
    expect(result.ok && result.recording.steps).toHaveLength(8);
  });
  it.each(['password="a\nb"', 'capability = "line one\nline two"', 'Authorization: "a\nb"', 'Cookie: "a\nb"', 'capability: {"grant": "first"}', 'Cookie: sid=first; session=second', "curl -H 'Cookie: sid=first; session=second'"])(
    'redacts the entire multiline assignment or header: %s', (text) => {
      const fixture = fixtureRecording();
      fixture.events[0]!.text = text;
      const result = decodeReplay(fixture);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const output = result.recording.steps[0]!.text;
      expect(output).toContain('[REDACTED]');
      for (const value of ['a\nb', 'line one', 'line two', 'first', 'second']) expect(output).not.toContain(value);
    });
  it('redacts numeric sensitive-value echoes and rejects excessive secret counts', () => {
    const fixture = fixtureRecording();
    fixture.events[2]!.input = { capability: 12345 };
    fixture.events[0]!.text = 'Recorded value: 12345';
    expect(JSON.stringify(decodeReplay(fixture))).not.toContain('12345');
    fixture.events[2]!.input = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`token${i}`, `opaque${i}`]));
    expect(decodeReplay(fixture).ok).toBe(false);
  });
  it('removes sensitive nested values and their unlabelled echoes from every output surface', () => {
    const fixture = fixtureRecording();
    const secrets = ['tiny', 'cap-value-7', 's3cret-short', 'env-value-9'];
    fixture.title = secrets.join(' ');
    fixture.events[2]!.input = { file_path: `src/${secrets[1]}.ts`, old_string: secrets.join(' '), new_string: secrets.join(' '), token: secrets[0], nested: { capability: secrets[1], password: secrets[2] }, env: { CUSTOM: secrets[3] } };
    fixture.events[5]!.output = `${secrets.join(' ')} ${encodeURIComponent(secrets[1]!)}`;
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify(result);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain('[REDACTED]');
  });
  it('redacts short text assignments, command flags, URL capabilities and recognized provider keys', () => {
    const fixture = fixtureRecording();
    const secret = 'sk-' + 'Abc123'.repeat(6);
    fixture.events[0]!.text = `token=x password='hi' --capability zzz https://localhost/?capability=abcd ${secret} Authorization: Bearer xyz`;
    const result = decodeReplay(fixture);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = result.recording.steps[0]!.text;
    expect(text).not.toContain(secret);
    for (const value of ['=x', "'hi'", 'zzz', '=abcd', 'xyz']) expect(text).not.toContain(value);
  });
  it('supports supplied sensitive values for otherwise unrecognizable credentials', () => {
    const fixture = { ...fixtureRecording(), sensitiveValues: ['opaque-value-3'] };
    fixture.events[0]!.text = 'An unlabelled opaque-value-3';
    const result = decodeReplay(fixture);
    expect(JSON.stringify(result)).not.toContain('opaque-value-3');
  });
});
