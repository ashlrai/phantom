import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentCheckpoint, buildCheckpointContext, CheckpointStore, checkpointsEnabled, normalizeCheckpoint } from '../src/core/run/checkpoints.js';
import { runTask } from '../src/core/run/agent-loop.js';
import { newUsage } from '../src/core/run/budget.js';
import type { ChatMessage, ProviderClient, RunTask } from '../src/core/types.js';

const draft = { objective: 'Fix the parser', verified_facts: [], open_hypotheses: ['Maybe an encoding issue'],
  failed_approaches: ['ASCII-only parsing failed'], next_actions: ['Run the Unicode regression'] };
let directory: string;
const options = () => ({ directory: join(directory, 'checkpoints'), key: 'run/task', repoRoot: process.cwd() });
beforeEach(() => { vi.stubEnv('PHANTOM_CHECKPOINTS', '1'); directory = mkdtempSync(join(realpathSync(tmpdir()), 'agent-checkpoints-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('Explicit checkpoints', () => {
  it('round trips every field, increments revisions, persists evidence and loads in a fresh process', () => {
    const store = new CheckpointStore(options());
    const event = store.recordToolEvent('read-1', 'read_file', 'parser supports UTF-8');
    const saved = store.save({ ...draft, verified_facts: [{ text: 'Parser supports UTF-8', evidence_ref: event.id }] });
    expect(JSON.parse(JSON.stringify(saved))).toEqual(saved);
    expect(new CheckpointStore(options()).load()).toEqual(saved);
    expect(statSync(store.path).mode & 0o777).toBe(0o600);
    expect(readFileSync(store.path, 'utf8')).not.toContain('parser supports UTF-8'); // result is hashed, not a transcript
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      "import {CheckpointStore} from './src/core/run/checkpoints.ts'; console.log(JSON.stringify(new CheckpointStore(JSON.parse(process.argv[1])).load()));",
      JSON.stringify(options())], { encoding: 'utf8', timeout: 15000 });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual(saved);
    expect(store.save(draft).revision).toBe(2);
  });

  it('downgrades missing, empty and unknown evidence to hypotheses; accepts only observed references', () => {
    const store = new CheckpointStore(options());
    const event = store.recordToolEvent('read-1', 'read_file', 'observed');
    const saved = store.save({ ...draft, verified_facts: [
      { text: 'Observed', evidence_ref: event.id }, { text: 'No citation' },
      { text: 'Empty citation', evidence_ref: '' }, { text: 'Invented citation', evidence_ref: 'fabricated-tool-event' },
    ] });
    expect(saved.verified_facts).toEqual([{ text: 'Observed', evidence_ref: event.id }]);
    expect(saved.open_hypotheses).toEqual([...draft.open_hypotheses, 'No citation', 'Empty citation', 'Invented citation']);
  });

  it('creates clean context exclusively from checkpoint, fresh state and host policy', () => {
    const saved = normalizeCheckpoint({ ...draft, verified_facts: [{ text: 'Observed Unicode behavior', evidence_ref: 'event-1' }] }, ['event-1'], 1);
    const messages = buildCheckpointContext(saved, 'CURRENT HEAD abc123; modified parser.ts', 'Fresh host policy');
    expect(messages.map(message => message.role)).toEqual(['system', 'user']);
    const context = JSON.stringify(messages);
    for (const required of [draft.objective, draft.failed_approaches[0], draft.next_actions[0], 'Observed Unicode behavior', 'CURRENT HEAD'])
      expect(context).toContain(required);
    expect(context).not.toContain('PRE_CHECKPOINT_TRANSCRIPT');
  });

  it('preserves all hypotheses when every fact at the array limit is downgraded', () => {
    const store = new CheckpointStore(options());
    const checkpoint = store.save({ ...draft,
      open_hypotheses: Array.from({ length: 128 }, (_, i) => `Hypothesis ${i}`),
      verified_facts: Array.from({ length: 128 }, (_, i) => ({ text: `Uncited fact ${i}` })),
    });
    expect(checkpoint.open_hypotheses).toHaveLength(256);
    expect(checkpoint.verified_facts).toEqual([]);
    expect(new CheckpointStore(options()).load()).toEqual(checkpoint);
  });

  it('fails closed on corruption, unsafe files, revision bounds and malformed drafts', () => {
    const store = new CheckpointStore(options());
    expect(() => store.save({ ...draft, extra: true })).toThrow();
    expect(() => normalizeCheckpoint(draft, [], 0)).toThrow();
    expect(() => normalizeCheckpoint(draft, [], 1.5)).toThrow();
    store.save(draft);
    writeFileSync(store.path, '{'); expect(() => store.load()).toThrow('invalid');
    rmSync(store.path); symlinkSync(join(directory, 'elsewhere'), store.path);
    expect(() => store.load()).toThrow('unreadable');
  });

  it('isolates checkpoint keys and repository roots', () => {
    const store = new CheckpointStore(options()); store.save(draft);
    expect(new CheckpointStore({ ...options(), key: '../another-task' }).load()).toBeNull();
    expect(new CheckpointStore({ ...options(), repoRoot: directory }).load()).toBeNull();
  });

  it.each([undefined, '', '0', 'true'])('stays disabled for flag %s with no filesystem writes', flag => {
    vi.stubEnv('PHANTOM_CHECKPOINTS', flag);
    expect(checkpointsEnabled()).toBe(false);
    expect(() => new CheckpointStore(options())).toThrow('PHANTOM_CHECKPOINTS=1');
  });
});

function task(): RunTask { return { id: 'task', goal: 'ORIGINAL_TASK_TRANSCRIPT', deps: [], status: 'pending' }; }
function context(checkpoint = options()) {
  return { checkpoint, budget: { maxTokens: 100000, maxSteps: 20, allowCloud: false }, usage: newUsage(), onStep: () => {} };
}

describe('Agent checkpoint integration', () => {
  it('lets the agent checkpoint a completed tool fact, discards the transcript, then restarts from disk', async () => {
    const requests: ChatMessage[][] = [];
    let checkpoint: AgentCheckpoint | null = null;
    const client: ProviderClient = { id: 'scripted', supportsTools: true, chat: async messages => {
      requests.push(structuredClone(messages));
      const n = requests.length;
      if (n === 1) return { content: 'PRE_CHECKPOINT_TRANSCRIPT', toolCalls: [{ id: 'read-1', name: 'read_file', arguments: {} }], usage: { tokensIn: 10, tokensOut: 1 } };
      if (n === 2) {
        const event = /evidence_ref: ([a-f0-9-]+)/.exec(messages.at(-1)!.content)![1];
        return { content: '', toolCalls: [{ id: 'checkpoint-1', name: 'phantom_checkpoint', arguments:
          { ...draft, verified_facts: [{ text: 'Observed Unicode behavior', evidence_ref: event }] } }], usage: { tokensIn: 20, tokensOut: 1 } };
      }
      checkpoint = new CheckpointStore(options()).load();
      return { content: 'Done', usage: { tokensIn: 30, tokensOut: 1 } };
    } };
    const result = await runTask(task(), client, { ...context(), memory: 'OLD_MEMORY_TRANSCRIPT', systemPrefix: 'OLD_PREFIX_TRANSCRIPT',
      tools: [{ name: 'read_file', safety: 'read', fn: async () => 'RAW_TOOL_TRANSCRIPT' }] });
    expect(result.status).toBe('done'); expect(result.usage?.tokensIn).toBe(60);
    expect(checkpoint!.verified_facts).toHaveLength(1);
    const resumed = JSON.stringify(requests[2]);
    for (const forbidden of ['ORIGINAL_TASK_TRANSCRIPT', 'PRE_CHECKPOINT_TRANSCRIPT', 'RAW_TOOL_TRANSCRIPT', 'OLD_MEMORY_TRANSCRIPT', 'OLD_PREFIX_TRANSCRIPT'])
      expect(resumed).not.toContain(forbidden);
    for (const required of ['Observed Unicode behavior', draft.objective, draft.failed_approaches[0], draft.next_actions[0], 'Fresh repository state', 'head'])
      expect(resumed).toContain(required);
    let restart: ChatMessage[] = [];
    await runTask(task(), { id: 'restart', supportsTools: false, chat: async messages => {
      restart = structuredClone(messages); return { content: 'Restarted', usage: { tokensIn: 1, tokensOut: 1 } };
    } }, context({ ...options(), resume: true }));
    expect(JSON.stringify(restart)).toContain('Observed Unicode behavior');
    expect(JSON.stringify(restart)).not.toContain('ORIGINAL_TASK_TRANSCRIPT');
  });

  it('keeps legacy requests byte-identical when disabled, ignoring requested resume', async () => {
    vi.stubEnv('PHANTOM_CHECKPOINTS', '0');
    let seen: ChatMessage[] = [];
    const chat = vi.fn(async (messages: ChatMessage[]) => {
      seen = structuredClone(messages);
      return { content: 'Done', usage: { tokensIn: 1, tokensOut: 1 } };
    });
    await runTask(task(), { id: 'off', supportsTools: true, chat }, context({ ...options(), resume: true }));
    expect(seen).toEqual([{ role: 'system', content: 'You are an Ashlr sub-agent. Be concise and focused. Complete the given task directly. Do not request tools — respond with a final textual answer only.' },
      { role: 'user', content: 'ORIGINAL_TASK_TRANSCRIPT' }]);
    expect(chat.mock.calls[0]).toHaveLength(4);
  });

  it('refuses missing restart state before contacting a provider', async () => {
    const chat = vi.fn(); const result = await runTask(task(), { id: 'missing', supportsTools: true, chat }, context({ ...options(), resume: true }));
    expect(result.status).toBe('failed'); expect(chat).not.toHaveBeenCalled();
  });

  it('rejects mixed checkpoint batches without dropping subsequent tool effects', async () => {
    let calls = 0;
    const read = vi.fn(async () => 'Observed');
    const client: ProviderClient = { id: 'mixed', supportsTools: true, chat: async messages => {
      if (++calls === 1) return { content: 'RETAIN_THIS', toolCalls: [
        { id: 'cp', name: 'phantom_checkpoint', arguments: draft }, { id: 'read', name: 'read_file', arguments: {} },
      ], usage: { tokensIn: 1, tokensOut: 1 } };
      expect(JSON.stringify(messages)).toContain('RETAIN_THIS');
      expect(JSON.stringify(messages)).toContain('only tool call');
      return { content: 'Done', usage: { tokensIn: 1, tokensOut: 1 } };
    } };
    const result = await runTask(task(), client, { ...context(), tools: [{ name: 'read_file', safety: 'read', fn: read }] });
    expect(result.status).toBe('done'); expect(read).toHaveBeenCalledOnce(); expect(new CheckpointStore(options()).load()).toBeNull();
  });

  it('does not issue evidence references for unavailable or throwing tools', async () => {
    let calls = 0;
    const client: ProviderClient = { id: 'failed-tool', supportsTools: true, chat: async messages => {
      if (++calls === 1) return { content: '', toolCalls: [
        { id: 'failed', name: 'read_file', arguments: {} }, { id: 'unavailable', name: 'missing_tool', arguments: {} },
      ], usage: { tokensIn: 1, tokensOut: 1 } };
      expect(messages.filter(message => message.role === 'tool')).toHaveLength(2);
      expect(JSON.stringify(messages)).not.toContain('evidence_ref:');
      return { content: 'Done', usage: { tokensIn: 1, tokensOut: 1 } };
    } };
    const result = await runTask(task(), client, { ...context(), tools: [
      { name: 'read_file', safety: 'read', fn: async () => { throw new Error('synthetic read failure'); } },
    ] });
    expect(result.status).toBe('done');
    const store = new CheckpointStore(options());
    expect(store.save({ ...draft, verified_facts: [{ text: 'Fake observation', evidence_ref: 'failed' }] }).verified_facts).toEqual([]);
    expect(JSON.parse(readFileSync(store.path, 'utf8')).events).toEqual([]);
  });
});
