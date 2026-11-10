/**
 * Incremental transcript memo in usage-source (RQ-PHANTOM-VERSE-CPU-1).
 *
 * Every rollup used to re-read every Claude transcript in the window (3+ GB on
 * the operator's machine) on each dashboard poll. The memo reuses unchanged
 * files and parses only what was appended. These tests pin that the memo
 * never changes the answer: appends, in-place rewrites, same-size rewrites,
 * trailing partial lines, chunk-straddling UTF-8, and caller mutation.
 * Hermetic: tmp HOME only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { _resetClaudeUsageMemoForTest, collectUsageEvents } from '../src/core/observability/usage-source.js';

let tmpHome: string;
let origHome: string | undefined;
let transcript: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-usage-memo-'));
  origHome = process.env.HOME;
  process.env.HOME = tmpHome;
  transcript = path.join(tmpHome, '.claude', 'projects', '-tmp-proj', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  _resetClaudeUsageMemoForTest();
});

afterEach(() => {
  if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
  _resetClaudeUsageMemoForTest();
});

function line(opts: { id?: string; input?: number; output?: number; model?: string; ts?: string; text?: string; pad?: string }): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: opts.ts ?? new Date().toISOString(),
    ...(opts.id ? { requestId: `req-${opts.id}` } : {}),
    ...(opts.pad !== undefined ? { pad: opts.pad } : {}),
    message: {
      ...(opts.id ? { id: opts.id } : {}),
      model: opts.model ?? 'claude-test',
      content: [{ type: 'text', text: opts.text ?? 'PRIVATE CONTENT' }],
      usage: { input_tokens: opts.input ?? 10, output_tokens: opts.output ?? 1 },
    },
  });
}

const since = () => Date.now() - 86_400_000;
const claude = () => collectUsageEvents(since()).filter((event) => event.source === 'claude');
const totalIn = () => claude().reduce((sum, event) => sum + event.tokensIn, 0);

describe('usage-source transcript memo', () => {
  it('reuses an unchanged transcript and parses only appended lines', () => {
    fs.writeFileSync(transcript, `${line({ id: 'a', input: 10 })}\n${line({ id: 'b', input: 20 })}\n`);
    expect(totalIn()).toBe(30);
    fs.appendFileSync(transcript, `${line({ id: 'c', input: 40 })}\n`);
    expect(totalIn()).toBe(70);
    expect(claude()).toHaveLength(3);
  });

  it('still merges repeated message lines across an append boundary', () => {
    fs.writeFileSync(transcript, `${line({ id: 'm', input: 10, output: 1 })}\n`);
    expect(claude()).toHaveLength(1);
    fs.appendFileSync(transcript, `${line({ id: 'm', input: 10, output: 9 })}\n`);
    const events = claude();
    expect(events).toHaveLength(1);
    expect(events[0]!.tokensOut).toBe(9);
  });

  it('re-reads a transcript rewritten in place (same inode, larger)', () => {
    fs.writeFileSync(transcript, `${line({ id: 'a', input: 10 })}\n`);
    expect(totalIn()).toBe(10);
    // writeFileSync truncates and rewrites the SAME inode with new content.
    fs.writeFileSync(transcript, `${line({ id: 'x', input: 500 })}\n${line({ id: 'y', input: 500 })}\n`);
    expect(totalIn()).toBe(1000);
  });

  it('re-reads a same-size rewrite whose mtime changed', () => {
    fs.writeFileSync(transcript, `${line({ id: 'a', input: 11 })}\n`);
    expect(totalIn()).toBe(11);
    fs.writeFileSync(transcript, `${line({ id: 'b', input: 22 })}\n`); // identical byte length
    const later = new Date(Date.now() + 5_000);
    fs.utimesSync(transcript, later, later);
    expect(totalIn()).toBe(22);
  });

  it('counts a trailing line without a newline once, then once more only when completed', () => {
    fs.writeFileSync(transcript, `${line({ id: 'a', input: 10 })}\n${line({ id: 'b', input: 5 })}`);
    expect(totalIn()).toBe(15);
    expect(totalIn()).toBe(15); // re-read, never double counted
    fs.appendFileSync(transcript, `\n${line({ id: 'c', input: 100 })}\n`);
    expect(totalIn()).toBe(115);
    expect(claude()).toHaveLength(3);
  });

  it('keeps a multi-byte character that straddles a 64 KiB read boundary intact', () => {
    // Pad the first line so the model name's "é" starts on the last byte of
    // the first 64 KiB chunk: a chunk-wise decode would corrupt it.
    const marker = 'MODEL-é';
    const probe = line({ id: 'a', model: marker, pad: '' });
    const offset = Buffer.from(probe).indexOf(Buffer.from('é'));
    const pad = 64 * 1024 - 1 - offset;
    const first = line({ id: 'a', model: marker, pad: 'x'.repeat(pad) });
    expect(Buffer.from(first).indexOf(Buffer.from('é'))).toBe(64 * 1024 - 1);
    fs.writeFileSync(transcript, `${first}\n`);
    expect(claude().map((event) => event.model)).toEqual([marker]);
  });

  it('returns copies: mutating an event never changes the next read', () => {
    fs.writeFileSync(transcript, `${line({ id: 'a', input: 10 })}\n`);
    const [event] = claude();
    event!.tokensIn = 9_999;
    expect(totalIn()).toBe(10);
  });

  it('applies the time window on every read, not only at parse time', () => {
    const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
    fs.writeFileSync(transcript, `${line({ id: 'old', input: 7, ts: old })}\n${line({ id: 'new', input: 3 })}\n`);
    expect(collectUsageEvents(Date.now() - 7 * 86_400_000).filter((e) => e.source === 'claude')).toHaveLength(2);
    expect(totalIn()).toBe(3); // 1-day window drops the old line from the same memo
  });

  it('never retains message content', () => {
    fs.writeFileSync(transcript, `${line({ id: 'a', text: 'TOP SECRET PROMPT' })}\n`);
    expect(JSON.stringify(claude())).not.toContain('TOP SECRET PROMPT');
  });
});
