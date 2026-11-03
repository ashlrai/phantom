import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runBusCli, type BusCliIo } from '../src/cli/bus.js';
import { busAck, busRead, busSend } from '../src/core/bus/ops.js';
import {
  BUS_KINDS, BUS_VENDORS, busMessageIssues, busTopicOf, type BusMessage,
} from '../src/core/bus/message.js';
import { callNativeTool } from '../src/core/mcp-native.js';

const root = process.cwd();
const schema = JSON.parse(readFileSync(join(root, 'docs/bus/bus.message.v1.schema.json'), 'utf8'));

function sample(over: Partial<BusMessage> = {}): BusMessage {
  return {
    schema: 'bus.message.v1', id: 'bus-1', thread: 'bus-1',
    from: { agent: 'job-1', vendor: 'codex', node: 'mac-1' }, to: { agent: 'lead' },
    kind: 'note', body: 'hello **world**', refs: ['pr:123'], createdAt: '2026-11-02T19:00:00.000Z', ...over,
  };
}

let dir: string;
let saved: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'phm-bus-'));
  saved = process.env['PHM_BUS_DIR'];
  process.env['PHM_BUS_DIR'] = dir;
});
afterEach(() => {
  if (saved === undefined) delete process.env['PHM_BUS_DIR']; else process.env['PHM_BUS_DIR'] = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe('bus.message.v1 schema', () => {
  it('keeps the JSON Schema enums and required keys in step with the TypeScript types', () => {
    expect(schema.properties.from.properties.vendor.enum).toEqual([...BUS_VENDORS]);
    expect(schema.properties.kind.enum).toEqual([...BUS_KINDS]);
    expect(schema.required.slice().sort()).toEqual(Object.keys(sample()).sort());
    expect(schema.properties.schema.const).toBe('bus.message.v1');
  });

  it('accepts a valid message for every vendor and kind', () => {
    for (const vendor of BUS_VENDORS) for (const kind of BUS_KINDS) {
      expect(busMessageIssues(sample({ from: { agent: 'a', vendor, node: 'n' }, kind }))).toEqual([]);
    }
  });

  it.each([
    ['unknown vendor', { from: { agent: 'a', vendor: 'gemini', node: 'n' } }],
    ['unknown kind', { kind: 'shout' }],
    ['empty body', { body: '' }],
    ['oversized body', { body: 'x'.repeat(16_385) }],
    ['empty recipient', { to: {} }],
    ['path-like topic', { to: { topic: '../etc' } }],
    ['bad timestamp', { createdAt: 'yesterday' }],
    ['wrong schema tag', { schema: 'bus.message.v2' }],
    ['too many refs', { refs: Array.from({ length: 33 }, (_, i) => `r${i}`) }],
    ['extra field', { extra: true }],
    ['bad id', { id: 'has space' }],
  ])('rejects %s', (_name, over) => {
    expect(busMessageIssues({ ...sample(), ...over }).length).toBeGreaterThan(0);
  });

  it('rejects non-objects and missing fields', () => {
    expect(busMessageIssues(null)).toEqual(['message must be an object']);
    expect(busMessageIssues({}).length).toBeGreaterThan(5);
  });

  it('derives the storage topic from the recipient', () => {
    expect(busTopicOf({ topic: 'Ops' })).toBe('ops');
    expect(busTopicOf({ agent: 'Lead' })).toBe('agent-lead');
    expect(busTopicOf({ role: 'reviewer' })).toBe('role-reviewer');
  });
});

describe('round trip across vendors', () => {
  it('a codex message is read by claude and local readers unchanged', () => {
    const sent = busSend({ agent: 'codex-job', vendor: 'codex', node: 'mac-1', to: { agent: 'lead' }, kind: 'ask', body: 'Which branch?', refs: ['issue:7'] });
    expect(sent).toMatchObject({ ok: true, status: 'posted', topic: 'agent-lead' });
    const seen = ['claude', 'local'].map(vendor => busRead({ agent: `${vendor}-reader`, vendor, for: 'lead' }));
    for (const r of seen) {
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      expect(r.messages).toHaveLength(1);
      expect(r.messages[0]).toMatchObject({ kind: 'ask', body: 'Which branch?', refs: ['issue:7'], from: { agent: 'codex-job', vendor: 'codex', node: 'mac-1' } });
    }
    expect(seen[0]).toMatchObject({ reader: { vendor: 'claude' } });
    expect(seen[1]).toMatchObject({ reader: { vendor: 'local' } });
  });

  it('threads a reply and tracks acks per reading agent', () => {
    const ask = busSend({ agent: 'a', vendor: 'grok', to: { topic: 'ops' }, kind: 'ask', body: 'status?' });
    if (!ask.ok) throw new Error('send failed');
    const reply = busSend({ agent: 'b', vendor: 'devin', to: { topic: 'ops' }, kind: 'reply', thread: ask.thread, body: 'green' });
    expect(reply).toMatchObject({ ok: true, thread: ask.thread });
    expect(busAck({ agent: 'c', vendor: 'claude', id: ask.id })).toMatchObject({ ok: true, status: 'acked' });
    expect(busAck({ agent: 'c', vendor: 'claude', id: ask.id })).toMatchObject({ ok: true, status: 'duplicate' });
    const unacked = busRead({ agent: 'c', vendor: 'claude', topic: 'ops', unacked: true });
    expect(unacked.ok && unacked.messages.map(m => m.kind)).toEqual(['reply']);
    const other = busRead({ agent: 'd', vendor: 'local', topic: 'ops', unacked: true });
    expect(other.ok && other.messages).toHaveLength(2);
  });

  it('filters by recipient, topic and since', () => {
    busSend({ agent: 'a', vendor: 'human', to: { agent: 'x' }, body: 'one' }, {}, process.env, new Date('2026-11-01T00:00:00Z'));
    busSend({ agent: 'a', vendor: 'human', to: { role: 'reviewer' }, body: 'two' }, {}, process.env, new Date('2026-11-02T00:00:00Z'));
    const bodies = (input: Parameters<typeof busRead>[0]): string[] => {
      const r = busRead(input);
      return r.ok ? r.messages.map(m => m.body) : ['ERR'];
    };
    expect(bodies({ for: 'reviewer' })).toEqual(['two']);
    expect(bodies({ topic: 'agent-x' })).toEqual(['one']);
    expect(bodies({ since: '2026-11-01T12:00:00Z' })).toEqual(['two']);
    expect(bodies({ since: 'nope' })).toEqual(['ERR']);
    expect(bodies({})).toEqual(['one', 'two']);
  });

  it('refuses acks for unknown messages and invalid identities', () => {
    expect(busAck({ id: 'bus-missing' })).toMatchObject({ ok: false, status: 'not-found' });
    expect(busSend({ vendor: 'gemini', to: { agent: 'x' }, body: 'hi' })).toMatchObject({ ok: false, status: 'invalid' });
    expect(busSend({ to: { agent: 'x' }, body: 'hi', kind: 'shout' })).toMatchObject({ ok: false, status: 'invalid' });
  });

  it('redacts secret-like text before it is stored', () => {
    const fake = `ghp_${'a1B2c3D4e5F6g7H8i9J0'.repeat(2)}`;
    const sent = busSend({ to: { agent: 'x' }, body: `token ${fake}` });
    expect(sent).toMatchObject({ ok: true, redacted: true });
    const onDisk = readdirSync(dir).filter(f => f.endsWith('.jsonl')).map(f => readFileSync(join(dir, f), 'utf8')).join('');
    expect(onDisk).not.toContain(fake);
  });
});

describe('concurrent writers', () => {
  it('serializes appends from separate processes under the topic lock', async () => {
    const opsUrl = pathToFileURL(join(root, 'src/core/bus/ops.ts')).href;
    const code = `import { busSend } from ${JSON.stringify(opsUrl)};
      const n = Number(process.argv[1]);
      for (let i = 0; i < 15; i++) {
        const r = busSend({ agent: 'w' + n, vendor: 'local', to: { topic: 'race' }, body: 'm'.repeat(2000) + n + ':' + i });
        if (!r.ok) { console.error(JSON.stringify(r)); process.exit(3); }
      }`;
    const writers = 6;
    const codes = await Promise.all(Array.from({ length: writers }, (_, n) => new Promise<number>(resolve => {
      const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, String(n)], {
        cwd: root, env: { ...process.env, PHM_BUS_DIR: dir }, stdio: 'ignore',
      });
      child.on('exit', c => resolve(c ?? -1));
    })));
    expect(codes).toEqual(Array(writers).fill(0));
    const lines = readFileSync(join(dir, 'race.jsonl'), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(writers * 15);
    const parsed = lines.map(l => JSON.parse(l) as BusMessage);
    expect(parsed.every(m => busMessageIssues(m).length === 0)).toBe(true);
    expect(new Set(parsed.map(m => m.id)).size).toBe(writers * 15);
  }, 120_000);
});

describe('phm bus CLI and MCP tool', () => {
  function io(stdin = ''): BusCliIo & { lines: string[]; errs: string[] } {
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, out: s => lines.push(s), err: s => errs.push(s), readStdin: () => stdin };
  }

  it('sends, reads, acks and prints help', async () => {
    const send = io();
    expect(await runBusCli(['send', '--to', 'lead', '--vendor', 'codex', '--agent', 'j1', '--kind', 'handoff', '--ref', 'pr:1', '--json', 'take', 'over'], send)).toBe(0);
    const sent = JSON.parse(send.lines[0]!) as { id: string };
    const read = io();
    expect(await runBusCli(['read', '--for', 'lead', '--vendor', 'claude', '--agent', 'r1', '--json'], read)).toBe(0);
    const out = JSON.parse(read.lines[0]!) as { messages: BusMessage[]; reader: { vendor: string } };
    expect(out.reader.vendor).toBe('claude');
    expect(out.messages[0]).toMatchObject({ id: sent.id, body: 'take over', kind: 'handoff', refs: ['pr:1'] });
    const ack = io();
    expect(await runBusCli(['ack', sent.id, '--agent', 'r1', '--vendor', 'claude'], ack)).toBe(0);
    expect(ack.lines[0]).toContain('acked');
    expect(await runBusCli(['help'], io())).toBe(0);
  });

  it('reads the body from stdin and reports usage errors', async () => {
    const piped = io('from stdin');
    expect(await runBusCli(['send', '--to', 'lead', '-'], piped)).toBe(0);
    const r = busRead({ for: 'lead' });
    expect(r.ok && r.messages[0]?.body).toBe('from stdin');
    const bad = io();
    expect(await runBusCli(['send', '--bogus'], bad)).toBe(2);
    expect(await runBusCli(['frobnicate'], io())).toBe(2);
    expect(await runBusCli(['ack'], io())).toBe(2);
    expect(await runBusCli(['send', '--to', 'lead', '--kind', 'shout', 'hi'], io())).toBe(1);
  });

  it('exposes send, read and ack through phantom_bus', async () => {
    const text = async (args: Record<string, unknown>): Promise<Record<string, unknown>> => {
      const res = await callNativeTool('phantom_bus', args);
      expect(res.isError).toBeFalsy();
      return JSON.parse(res.content[0]!.text) as Record<string, unknown>;
    };
    const sent = await text({ op: 'send', agent: 'mcp-codex', vendor: 'codex', to: 'lead', body: 'via mcp' });
    expect(sent).toMatchObject({ ok: true, status: 'posted' });
    const read = await text({ op: 'read', agent: 'mcp-local', vendor: 'local', for: 'lead' });
    expect((read['messages'] as BusMessage[])[0]).toMatchObject({ body: 'via mcp', from: { vendor: 'codex' } });
    expect(await text({ op: 'ack', agent: 'mcp-local', vendor: 'local', id: sent['id'] })).toMatchObject({ ok: true, status: 'acked' });
    expect((await callNativeTool('phantom_bus', { op: 'delete' })).isError).toBe(true);
  });
});

describe('dispatchd adapter note', () => {
  it('names only verbs and flags the CLI really has', () => {
    const src = readFileSync(join(root, 'contrib/mac/dispatchd.py'), 'utf8');
    const note = /BUS_NOTE = \((.*?)\n\ndef /s.exec(src)?.[1] ?? '';
    expect(note).toContain('phm bus send --to');
    expect(note).toContain('phm bus read --for $PHM_BUS_AGENT --unacked');
    expect(note).toContain('phm bus ack');
    expect((note.match(/\\n/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
