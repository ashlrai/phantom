/** Chat acceptance through durable background completion, without a provider or real process. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { adapterFor } from '../src/core/verse/adapters/index.js';
import { createVerseEngine, type VerseEngineHandle, type VerseEngineOptions, type VerseSeatLaunch } from '../src/core/verse/session-engine.js';
import { createVerseSessionStore } from '../src/core/verse/session-store.js';
import type { VerseEvent, VerseSeat } from '../src/core/verse/types.js';
import { buildSidebar } from '../src/web-ui/routes/verse/chat/sidebar-model.js';
import { buildTranscript } from '../src/web-ui/routes/verse/verse-transcript.js';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  readonly pid = undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    if (this.exitCode !== null || this.signalCode !== null) return false;
    this.signalCode = signal;
    setImmediate(() => this.emit('close', null));
    return true;
  }
  unref(): void {}
  async finish(code: number, lines: unknown[] = []): Promise<void> {
    for (const line of lines) this.stdout.write(`${JSON.stringify(line)}\n`);
    await new Promise<void>(resolve => setImmediate(() => {
      this.exitCode = code;
      this.emit('close', code);
      setImmediate(resolve);
    }));
  }
}

const SEAT: VerseSeat = {
  id: 'claude-a', engine: 'claude', label: 'Claude', accountId: 'claude-a',
  contextWindow: 200_000, cliVersion: '2.1.280',
  health: { state: 'unknown', summary: null, windows: [], observedAt: null },
  models: [{ id: 'claude-opus-5-5', label: 'Opus', contextWindow: 200_000 }],
};
const launch: VerseSeatLaunch = {
  seat: SEAT, launcher: ['/usr/local/bin/node', '/nowhere/native-profiles/claude-a/launcher.mjs'],
  ollamaBaseUrl: 'http://127.0.0.1:11434',
};
const answer = (text: string) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const delta = (text: string) => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const statuses = (events: VerseEvent[]) => events.filter((event): event is Extract<VerseEvent, { type: 'assistant-status' }> => event.type === 'assistant-status');
const assistantTexts = (events: VerseEvent[]) => buildTranscript(events).items.flatMap(item => item.kind === 'assistant' ? [item.text] : []);

let tmp: string;
let root: string;
let project: string;
let children: FakeChild[];
let engines: VerseEngineHandle[];
let engine: VerseEngineHandle;
let id: string;

function makeEngine(over: VerseEngineOptions = {}): VerseEngineHandle {
  const created = createVerseEngine({
    root, readiness: null, reasoningTap: null, preflight: null, processRegistry: false,
    loadConfig: () => undefined, log: () => {},
    spawn: (() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    }) as unknown as typeof import('node:child_process').spawn,
    ...over,
  });
  engines.push(created);
  return created;
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'verse-turn-status-'));
  root = join(tmp, 'verse');
  project = join(tmp, 'project');
  mkdirSync(project);
  children = [];
  engines = [];
  engine = makeEngine();
  id = engine.createSession({ seatId: SEAT.id, projectPath: project }, launch).id;
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const instance of engines) instance.close();
  await new Promise<void>(resolve => setImmediate(resolve));
  rmSync(tmp, { recursive: true, force: true });
});

describe('chat turn assistant status integration', () => {
  it('acknowledges acceptance immediately and reports a durable result in an unread background row', async () => {
    const streamed: VerseEvent[] = [];
    const off = engine.subscribe(id, 0, event => streamed.push(event));
    const accepted = engine.sendTurn(id, 'Fix the parser');
    expect(accepted.session.status).toBe('running');
    expect(statuses(streamed)).toEqual([expect.objectContaining({
      phase: 'acknowledgement', turnId: accepted.turnId, text: 'I’m working on: Fix the parser',
    })]);
    expect(engine.getSession(id)?.lastResult).toBeUndefined();

    await children[0]!.finish(0, [answer('Parser fixed; 12 checks passed.')]);
    off();
    const events = engine.getEvents(id);
    const pair = statuses(events);
    expect(pair.map(event => event.phase)).toEqual(['acknowledgement', 'result']);
    expect(pair.every(event => event.turnId === accepted.turnId)).toBe(true);
    const result = pair[1]!.text;
    expect(result).toBe('Result for Fix the parser: Parser fixed; 12 checks passed.');
    expect(events.findIndex(event => event === pair[1])).toBeLessThan(events.findIndex(event => event.type === 'turn-done'));
    expect(assistantTexts(events)).toEqual([pair[0]!.text, 'Parser fixed; 12 checks passed.', result]);

    const completed = engine.getSession(id)!;
    const sidebar = (selectedId: string | null, seen: number) => buildSidebar({
      sessions: [completed], projects: [], query: '', filter: 'all', activity: null,
      meta: { sessions: {} }, localSeen: new Map([[id, seen]]), selectedId,
    }).groups.flatMap(group => group.rows)[0]!;
    expect(sidebar('another-chat', 0).status).toEqual({ kind: 'unread', newTurns: 1 });
    expect(sidebar('another-chat', 0).live?.text).toBe(result);
    expect(sidebar(id, 0).live).toBeNull();
    expect(sidebar(null, 1).live).toBeNull();

    engine.close();
    const disk = createVerseSessionStore(root);
    expect(disk.get(id)?.lastResult).toBe(result);
    expect(assistantTexts(disk.readEvents(id))).toEqual(assistantTexts(events));
    disk.close();
    const restarted = makeEngine();
    expect(restarted.getSession(id)?.lastResult).toBe(result);
    expect(statuses(restarted.getEvents(id))).toEqual(pair);
  });

  it('does not acknowledge invalid, refused, or busy requests', () => {
    expect(() => engine.sendTurn(id, '  ')).toThrow('text is required');
    expect(statuses(engine.getEvents(id))).toHaveLength(0);
    engine.sendTurn(id, 'First task');
    expect(() => engine.sendTurn(id, 'Second task')).toThrow('already running');
    expect(statuses(engine.getEvents(id))).toHaveLength(1);
    const refused = makeEngine({
      root: join(tmp, 'refused'),
      readiness: () => ({ seatId: SEAT.id, ready: false, reason: 'Seat unavailable', alternatives: [] }),
    });
    const refusedId = refused.createSession({ seatId: SEAT.id, projectPath: project }, launch).id;
    expect(() => refused.sendTurn(refusedId, 'Refused task')).toThrow('Seat unavailable');
    expect(refused.getEvents(refusedId)).toEqual([]);
  });

  it.each(['build', 'spawn'] as const)('reports an accepted %s failure without claiming success', kind => {
    if (kind === 'build') vi.spyOn(adapterFor('claude'), 'buildLaunch').mockImplementationOnce(() => { throw new Error('launch unavailable'); });
    else {
      engine.close();
      engine = makeEngine({ spawn: (() => { throw new Error('spawn unavailable'); }) as unknown as typeof import('node:child_process').spawn });
    }
    const accepted = engine.sendTurn(id, 'Check the parser');
    expect(accepted.session.status).toBe('error');
    expect(statuses(engine.getEvents(id)).map(event => [event.phase, event.text])).toEqual([
      ['acknowledgement', 'I’m working on: Check the parser'], ['result', 'Turn failed: Check the parser'],
    ]);
    expect(children).toHaveLength(0);
    expect(engine.getSession(id)?.turnCount).toBe(0);
  });

  it('records a stopped result for cancellation', async () => {
    engine.sendTurn(id, 'Review the parser');
    expect(engine.cancelTurn(id)).toBe(true);
    await vi.waitFor(() => expect(engine.getSession(id)?.status).toBe('idle'));
    expect(statuses(engine.getEvents(id)).map(event => event.text)).toEqual([
      'I’m working on: Review the parser', 'Stopped: Review the parser',
    ]);
  });

  it('keeps one acknowledgement/result pair when a missing native conversation retries', async () => {
    const accepted = engine.sendTurn(id, 'Review the parser');
    await children[0]!.finish(1, [{ type: 'result', subtype: 'error_during_execution', is_error: true,
      errors: ['No conversation found with session ID: missing'] }]);
    expect(children).toHaveLength(2);
    expect(statuses(engine.getEvents(id)).map(event => event.phase)).toEqual(['acknowledgement']);
    await children[1]!.finish(0, [answer('Reviewed the parser.')]);
    expect(engine.getEvents(id).some(event => event.type === 'recovered')).toBe(true);
    expect(statuses(engine.getEvents(id)).map(event => [event.phase, event.turnId])).toEqual([
      ['acknowledgement', accepted.turnId], ['result', accepted.turnId],
    ]);
  });

  it('preserves partial provider text around the result through compaction and reload', async () => {
    engine.sendTurn(id, 'Inspect the parser');
    await children[0]!.finish(0, [delta('Partial '), delta('answer')]);
    const events = engine.getEvents(id);
    expect(assistantTexts(events)).toContain('Partial answer');
    expect(statuses(events)[1]?.text).toContain('Partial answer');
    engine.close();
    const disk = createVerseSessionStore(root);
    expect(assistantTexts(disk.readEvents(id))).toEqual(assistantTexts(events));
    disk.close();
  });

  it('scrubs a synthetic credential split across provider chunks before producing result copy', async () => {
    const credential = `sk-${'fixture'.repeat(4)}`;
    engine.sendTurn(id, 'Inspect the parser');
    await children[0]!.finish(0, [delta(`Found ${credential.slice(0, 11)}`), delta(`${credential.slice(11)} in fixture.`)]);
    const result = statuses(engine.getEvents(id))[1]!.text;
    expect(result.includes(credential)).toBe(false);
    expect(result).toContain('[REDACTED]');
    expect(engine.getSession(id)?.lastResult).toBe(result);
  });

  it('replaces the prior result and does not reuse its answer when the next turn returns no text', async () => {
    engine.sendTurn(id, 'First task');
    await children[0]!.finish(0, [answer('First task completed.')]);
    const second = engine.sendTurn(id, 'Second task');
    await children[1]!.finish(0);
    const pair = statuses(engine.getEvents(id)).filter(event => event.turnId === second.turnId);
    expect(pair.map(event => event.phase)).toEqual(['acknowledgement', 'result']);
    expect(pair[1]!.text).toBe('Turn finished: Second task. No response text was returned.');
    expect(engine.getSession(id)?.lastResult).toBe(pair[1]!.text);
  });

  it('does not treat an acknowledgement as native engagement after interruption', () => {
    engine.close();
    const disk = createVerseSessionStore(root);
    const interrupted = disk.get(id)!;
    interrupted.status = 'running';
    disk.save(interrupted);
    disk.appendEvent(id, { type: 'user-message', turnId: 'interrupted', text: 'Inspect the parser' }, '2026-10-26T00:00:00Z');
    disk.appendEvent(id, { type: 'assistant-status', turnId: 'interrupted', phase: 'acknowledgement', text: 'I’m working on: Inspect the parser' }, '2026-10-26T00:00:01Z');
    disk.close();
    const restarted = makeEngine();
    expect(restarted.getSession(id)?.status).toBe('error');
    expect(restarted.getSession(id)?.turnCount).toBe(0);
    expect(restarted.getEvents(id).some(event => event.type === 'turn-done' && event.turnId === 'interrupted')).toBe(true);
    expect(statuses(restarted.getEvents(id)).map(event => [event.phase, event.text])).toEqual([
      ['acknowledgement', 'I’m working on: Inspect the parser'], ['result', 'Turn failed: Inspect the parser'],
    ]);
    expect(restarted.getSession(id)?.lastResult).toBe('Turn failed: Inspect the parser');
  });

  it('does not append an acknowledgement or recreate a chat deleted by a user-message subscriber', () => {
    engine.subscribe(id, 0, event => {
      if (event.type === 'user-message') engine.deleteSession(id);
    });
    expect(() => engine.sendTurn(id, 'Inspect the parser')).toThrow('session was deleted');
    expect(engine.getSession(id)).toBeNull();
    expect(existsSync(join(root, 'sessions', `${id}.json`))).toBe(false);
    expect(existsSync(join(root, 'sessions', `${id}.events.jsonl`))).toBe(false);
    expect(children).toHaveLength(0);
  });

  it.each(['acknowledgement', 'result'] as const)('does not recreate a chat deleted by its %s subscriber', async phase => {
    engine.subscribe(id, 0, event => {
      if (event.type === 'assistant-status' && event.phase === phase) engine.deleteSession(id);
    });
    if (phase === 'acknowledgement') expect(() => engine.sendTurn(id, 'Inspect the parser')).toThrow('session was deleted');
    else {
      engine.sendTurn(id, 'Inspect the parser');
      await children[0]!.finish(0, [answer('Inspected.')]);
    }
    expect(engine.getSession(id)).toBeNull();
    expect(existsSync(join(root, 'sessions', `${id}.json`))).toBe(false);
    expect(existsSync(join(root, 'sessions', `${id}.events.jsonl`))).toBe(false);
    if (phase === 'acknowledgement') expect(children).toHaveLength(0);
  });

  it.each(['acknowledgement', 'result'] as const)('refuses reentrant sends from its %s subscriber', async phase => {
    const failures: unknown[] = [];
    engine.subscribe(id, 0, event => {
      if (event.type !== 'assistant-status' || event.phase !== phase) return;
      try { engine.sendTurn(id, 'Reentrant task'); } catch (error) { failures.push(error); }
    });
    engine.sendTurn(id, 'Inspect the parser');
    await children[0]!.finish(0, [answer('Inspected.')]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ code: 'VERSE_SESSION_BUSY' });
    expect(children).toHaveLength(1);
    expect(statuses(engine.getEvents(id)).map(event => event.phase)).toEqual(['acknowledgement', 'result']);
  });

  it('does not recreate a chat deleted by a result subscriber during early launch failure', () => {
    vi.spyOn(adapterFor('claude'), 'buildLaunch').mockImplementationOnce(() => { throw new Error('launch unavailable'); });
    engine.subscribe(id, 0, event => {
      if (event.type === 'assistant-status' && event.phase === 'result') engine.deleteSession(id);
    });
    engine.sendTurn(id, 'Inspect the parser');
    expect(engine.getSession(id)).toBeNull();
    expect(existsSync(join(root, 'sessions', `${id}.json`))).toBe(false);
    expect(existsSync(join(root, 'sessions', `${id}.events.jsonl`))).toBe(false);
    expect(children).toHaveLength(0);
  });

  it.each(['finished', 'cancelled'] as const)('retains a storage failure when its %s result cannot be appended', async outcome => {
    const path = join(root, 'sessions', `${id}.events.jsonl`);
    const backup = `${path}.backup`;
    let obstructed = false;
    const streamed: VerseEvent[] = [];
    engine.subscribe(id, 0, event => {
      streamed.push(event);
      if (event.type !== 'assistant-message') return;
      // Replace only this temporary log path after the provider answer. The
      // next append (the result) then fails even with a cached append fd.
      renameSync(path, backup);
      mkdirSync(path);
      obstructed = true;
    });
    engine.sendTurn(id, 'Inspect the parser');
    try {
      if (outcome === 'finished') await children[0]!.finish(0, [answer('Inspected.')]);
      else {
        children[0]!.stdout.write(`${JSON.stringify(answer('Inspected.'))}\n`);
        engine.cancelTurn(id);
        await vi.waitFor(() => expect(engine.turnEndsSince?.(0).ends).toHaveLength(1));
      }
      expect(obstructed).toBe(true);
      expect(engine.getSession(id)?.status).toBe('error');
      expect(engine.getSession(id)?.lastResult).toBeUndefined();
      expect(engine.getSession(id)?.lastError).toContain('storage error');
      expect(statuses(streamed).map(event => event.phase)).toEqual(['acknowledgement']);
      expect(streamed.some(event => event.type === 'turn-done')).toBe(false);
      expect(engine.turnEndsSince?.(0).ends.at(-1)?.outcome).toBe('failed');
    } finally {
      if (obstructed) {
        rmSync(path, { recursive: true });
        renameSync(backup, path);
      }
    }
  });
});
