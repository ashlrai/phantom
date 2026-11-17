import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { listBusInboxAfter, type BusInboxReceipt } from './bus-inbox.js';
import type { FeedbackCoverage, FeedbackSignal } from './feedback-triage.js';

export interface FeedbackIngestDeps {
  gh: (args: string[], signal: AbortSignal) => Promise<string>;
  pollComms: (since: number, signal: AbortSignal) => Promise<FeedbackSignal[]>;
  pause: () => Promise<void>;
}
export interface FeedbackSnapshot {
  signals: FeedbackSignal[]; open: FeedbackCoverage[]; shipped: { ref: string; at: number }[];
  sources: Record<string, 'ok' | 'unavailable' | 'truncated'>; coverageComplete: boolean;
}
type Row = Record<string, unknown>;
const repo = 'ashlrai/phantom', url = `https://github.com/${repo}`;
const record = (v: unknown): Row => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('invalid record');
  return v as Row;
};
const str = (v: Row, key: string): string => { if (typeof v[key] !== 'string') throw new Error('invalid field'); return v[key]; };
const number = (v: Row, key = 'number'): number => {
  if (!Number.isSafeInteger(v[key]) || (v[key] as number) < 1) throw new Error('invalid id');
  return v[key] as number;
};
const date = (s: string): number => { const n = Date.parse(s); if (!Number.isFinite(n)) throw new Error('invalid date'); return n; };
const sha = (s: string): string => { if (!/^[a-f0-9]{40}$/.test(s)) throw new Error('invalid sha'); return s; };

export function feedbackIngestDeps(busRoot?: string): FeedbackIngestDeps {
  return {
    gh: async (args, signal) => (await promisify(execFile)('gh', args, {
      signal, timeout: 8000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
      env: { ...process.env, GH_PROMPT_DISABLED: '1' }, encoding: 'utf8',
    })).stdout,
    pause: () => delay(250),
    pollComms: async (since) => {
      const receipts: BusInboxReceipt[] = []; let cursor = 0;
      for (let pageNumber = 0; pageNumber < 11; pageNumber++) {
        const page = listBusInboxAfter(cursor, 100, { root: busRoot });
        if (page.status !== 'ok') throw new Error('comms unavailable');
        receipts.push(...page.messages); cursor = page.nextCursor;
        if (page.messages.length < 100) break;
        if (pageNumber === 10) throw new Error('comms truncated');
      }
      return receipts.flatMap(({ envelope, receivedAt }) => {
        if (receivedAt < since || envelope.channel === 'imessage') return [];
        if (!envelope.body || typeof envelope.body !== 'object' || Array.isArray(envelope.body)) return [];
        const body = record(envelope.body);
        // Only already-receipted channel mirrors. Do not inspect iMessage text/handles.
        const inbound = body.kind === 'interjection' || (body.kind === 'owner-thread' && envelope.to === 'leader' && envelope.from === 'mason');
        if (body.channel === 'imessage' || !inbound || !['telegram', 'slack', 'desktop', 'cli'].includes(String(body.channel))) return [];
        return [{ source: 'comms' as const, text: str(body, 'text'), refs: [`comms:${envelope.id}`] }];
      }).slice(-100);
    },
  };
}

/** Seven bounded metadata reads; no logs, sends, model calls, or credential resolution. */
export async function ingestFeedback(now: number, days = 7, deps = feedbackIngestDeps()): Promise<FeedbackSnapshot> {
  if (!Number.isSafeInteger(now) || !Number.isInteger(days) || days < 1 || days > 30) throw new Error('invalid window');
  const since = now - days * 86400000, iso = new Date(since).toISOString();
  const out: FeedbackSnapshot = { signals: [], open: [], shipped: [], sources: {}, coverageComplete: false };
  const collect = async (name: string, action: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await deps.pause();
      await Promise.race([action(abort.signal), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { abort.abort(); reject(new Error('timeout')); }, 9000);
      })]);
      out.sources[name] ??= 'ok';
    } catch { out.sources[name] = 'unavailable'; }
    finally { clearTimeout(timer); abort.abort(); }
  };
  const rows = async (name: string, args: string[], signal: AbortSignal, cap = 100): Promise<Row[]> => {
    const text = await deps.gh(args, signal);
    if (signal.aborted || Buffer.byteLength(text) > 1024 * 1024) throw new Error('bounded read');
    const data: unknown = JSON.parse(text);
    if (!Array.isArray(data) || data.length > cap) throw new Error('invalid page');
    if (data.length === cap) out.sources[name] = 'truncated';
    return data.map(record);
  };
  const push = (signal: AbortSignal, values: FeedbackSignal[]): void => { if (!signal.aborted) out.signals.push(...values); };
  const recent = (s: string): boolean => date(s) >= since && date(s) <= now;
  const list = (kind: string, state: string, fields: string, cap = 100): string[] =>
    [kind, 'list', '--repo', repo, '--state', state, '--limit', String(cap), '--json', fields];
  await collect('open-prs', async signal => {
    const data = await rows('open-prs', list('pr', 'open', 'number,title,body', 1000), signal, 1000);
    const coverage = data.map(r => ({ text: `${str(r, 'title')}\n${str(r, 'body')}`, refs: [`${url}/pull/${number(r)}`] }));
    if (!signal.aborted) { out.open = coverage; out.coverageComplete = data.length < 1000; }
  });
  await collect('issues', async signal => {
    const data = await rows('issues', [...list('issue', 'open', 'number,title,body,updatedAt'), '--search', `updated:>=${iso}`], signal);
    push(signal, data.filter(r => recent(str(r, 'updatedAt'))).map(r => ({ source: 'github-issue', text: `${str(r, 'title')}\n${str(r, 'body')}`, refs: [`${url}/issues/${number(r)}`] })));
  });
  for (const endpoint of ['issues', 'pulls']) await collect(`${endpoint}-comments`, async signal => {
    const data = await rows(`${endpoint}-comments`, ['api', `repos/${repo}/${endpoint}/comments?since=${iso}&per_page=100&sort=updated&direction=desc`], signal);
    push(signal, data.filter(r => recent(str(r, 'updated_at'))).flatMap(r => {
      const parent = str(r, endpoint === 'pulls' ? 'pull_request_url' : 'issue_url').match(/\/(?:issues|pulls)\/(\d+)$/)?.[1];
      if (!parent) throw new Error('invalid parent');
      if (endpoint === 'issues' && !out.open.some(p => p.refs?.includes(`${url}/pull/${parent}`))) return [];
      return [{ source: 'pr-comment' as const, text: str(r, 'body'), refs: [`${url}/pull/${parent}`] }];
    }));
  });
  await collect('ci', async signal => {
    const data = await rows('ci', ['run', 'list', '--repo', repo, '--status', 'failure', '--created', `>=${iso}`, '--limit', '100', '--json', 'databaseId,displayTitle,createdAt'], signal);
    push(signal, data.filter(r => recent(str(r, 'createdAt'))).map(r => ({ source: 'ci-failure', text: str(r, 'displayTitle'), refs: [`${url}/actions/runs/${number(r, 'databaseId')}`] })));
  });
  let merges: Row[] = [];
  await collect('merges', async signal => {
    const data = await rows('merges', [...list('pr', 'merged', 'number,mergeCommit,mergedAt'), '--base', 'master', '--search', `merged:>=${iso}`], signal);
    const valid = data.filter(r => recent(str(r, 'mergedAt')));
    const refs = valid.map(r => { sha(str(record(r.mergeCommit), 'oid')); return { ref: `${url}/pull/${number(r)}`, at: date(str(r, 'mergedAt')) }; });
    if (!signal.aborted) { merges = valid; out.shipped = refs; }
  });
  await collect('reverts', async signal => {
    if (out.sources.merges === 'unavailable') throw new Error('missing merge evidence');
    const data = await rows('reverts', ['api', `repos/${repo}/commits?sha=master&since=${iso}&per_page=100`], signal);
    push(signal, data.flatMap(r => {
      const commit = record(r.commit), at = date(str(record(commit.committer), 'date'));
      const target = /This reverts commit ([a-f0-9]{40})\./.exec(str(commit, 'message'))?.[1];
      const merge = merges.find(m => str(record(m.mergeCommit), 'oid') === target);
      if (!merge || at < date(str(merge, 'mergedAt')) || at > now || at - date(str(merge, 'mergedAt')) > days * 86400000) return [];
      return [{ source: 'revert' as const, text: `Regression: merged PR #${number(merge)} was reverted on master. Investigate and fix forward.`, refs: [`${url}/commit/${sha(str(r, 'sha'))}`, `${url}/pull/${number(merge)}`] }];
    }));
  });
  await collect('comms', async signal => {
    const data = await deps.pollComms(since, signal);
    if (!Array.isArray(data) || data.length > 100) throw new Error('comms truncated');
    if (!signal.aborted && data.length === 100) out.sources.comms = 'truncated';
    push(signal, data);
  });
  return out;
}
