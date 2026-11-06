import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPlannerBrief, type PlannerBriefGit } from '../src/core/fleet/planner-brief.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'brief-inflight-'));
  roots.push(root);
  await mkdir(join(root, 'leader/drop'), { recursive: true });
  await mkdir(join(root, 'queue'));
  return root;
}

const NOW = Date.parse('2026-11-02T12:00:00');
const HEADING = '## IN FLIGHT (ingested in the last 48h, not yet merged on origin/master)';
const LEDGER = [
  '2026-11-02 10:00:00\tRQ-PHX-FAKEALPHA06\tp1\tclaude\twork\talpha topic',
  '2026-11-02 09:00:00\tRQ-PHX-FAKEMERGED06\tp1\tclaude\twork\tmerged topic',
  '2026-10-30 09:00:00\tRQ-PHX-FAKESTALE06\tp1\tclaude\twork\tstale topic',
].join('\n');
const MERGES = 'ordinary commit\nbridge(RQ-PHX-FAKEMERGED06): merged topic (#99)\n';
const inFlightSection = (text: string): string =>
  text.slice(text.indexOf(HEADING), text.indexOf('## MASON INBOX'));

it('renders IN FLIGHT after RECENT PHANTOM MERGES with unmerged windowed jobs only', async () => {
  const root = await fixture();
  await writeFile(join(root, 'leader/drop/ingested.tsv'), LEDGER);
  const calls: string[][] = [];
  const git: PlannerBriefGit = (_program, args, _options, done) => {
    calls.push(args);
    done(null, args.includes('--since=48.hours') ? MERGES : MERGES);
  };
  const brief = await buildPlannerBrief({ runsRoot: root, git, now: NOW });
  expect(brief.text).toContain(HEADING);
  expect(brief.text.indexOf(HEADING)).toBeGreaterThan(brief.text.indexOf('## RECENT PHANTOM MERGES'));
  expect(brief.text.indexOf(HEADING)).toBeLessThan(brief.text.indexOf('## MASON INBOX'));
  const section = inFlightSection(brief.text);
  expect(section).toContain('RQ-PHX-FAKEALPHA06 claude work 2h alpha topic');
  expect(section).not.toContain('FAKEMERGED06');
  expect(section).not.toContain('FAKESTALE06');
  expect(brief.sections.inFlight).toBe(1);
  expect(brief.missing).not.toContain('git log origin/master (in flight)');
  const since = calls.find(args => args.includes('--since=48.hours'));
  expect(since?.slice(-4)).toEqual(['log', 'origin/master', '--since=48.hours', '--format=%s']);
});

it('renders the none line when every recent job has merged', async () => {
  const root = await fixture();
  await writeFile(join(root, 'leader/drop/ingested.tsv'), '2026-11-02 10:00:00\tRQ-PHX-FAKEDONE06\tp1\tclaude\twork\tdone topic');
  const git: PlannerBriefGit = (_program, args, _options, done) =>
    done(null, args.includes('--since=48.hours') ? 'bridge(RQ-PHX-FAKEDONE06): done (#1)\n' : '');
  const brief = await buildPlannerBrief({ runsRoot: root, git, now: NOW });
  expect(inFlightSection(brief.text)).toContain('(none: every job ingested in the last 48h has merged)');
  expect(brief.sections.inFlight).toBe(1);
});

it('marks the section unavailable and records missing when the windowed git log fails', async () => {
  const root = await fixture();
  await writeFile(join(root, 'leader/drop/ingested.tsv'), LEDGER);
  const git: PlannerBriefGit = (_program, args, _options, done) => {
    if (args.includes('--since=48.hours')) { done(new Error('boom'), ''); return; }
    done(null, MERGES);
  };
  const brief = await buildPlannerBrief({ runsRoot: root, git, now: NOW });
  expect(brief.text).toContain(`${HEADING}\n(unavailable: git log origin/master)`);
  expect(brief.missing).toContain('git log origin/master (in flight)');
  expect(brief.sections.inFlight).toBe(1);
  expect(brief.text).toContain('bridge(RQ-PHX-FAKEMERGED06): merged topic (#99)');
});

it('renders the ledger unavailable text and never calls git when the ledger is not healthy', async () => {
  const root = await fixture();
  let calls = 0;
  const git: PlannerBriefGit = (_program, args, _options, done) => { calls++; done(null, ''); };
  const brief = await buildPlannerBrief({ runsRoot: root, git, now: NOW });
  expect(brief.text).toContain(`${HEADING}\n(unavailable: leader/drop/ingested.tsv missing)`);
  expect(calls).toBe(1);
  expect(brief.missing).not.toContain('git log origin/master (in flight)');
});
