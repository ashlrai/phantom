#!/usr/bin/env node
/* global process, console */
// Merge-group attribution only (RQ-CI-FASTGATE-1): on a failure, map each
// failing test file to the PRs in the batch whose commits touched a source that
// test names. Reports only: no rerun, no ejection, no revert (Core owns those).
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const git = (cwd, args) => execFileSync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' });
const noExt = (p) => p.replace(/\.(?:ts|tsx|mjs|js)$/, '');

export function prNumber(subject) {
  const all = [...subject.matchAll(/\(#(\d+)\)/g)];
  return all.length ? Number(all[all.length - 1][1]) : null;
}

// A commit is related to a failing test when it touched that test, or touched a
// module whose path the test text names (the same direct-import rule the
// selector uses).
export function related(testFile, testText, touched) {
  return touched.some((f) => f === testFile || testText.includes(`${noExt(f)}.js`) || testText.includes(`${noExt(f)}.ts`) ||
    testText.includes(`/${noExt(f).split('/').pop()}.js'`));
}

export function attribute({ cwd, base, head, failed }) {
  const commits = git(cwd, ['log', '--no-merges', '--format=%H%x09%s', `${base}..${head}`]).split('\n').filter(Boolean)
    .map((line) => {
      const [sha, ...rest] = line.split('\t');
      const touched = git(cwd, ['show', '--no-renames', '--name-only', '--format=', sha]).split('\n').filter(Boolean);
      return { sha, subject: rest.join('\t'), pr: prNumber(rest.join('\t')), touched };
    });
  const entries = failed.map((file) => {
    let text = '';
    try { text = readFileSync(resolve(cwd, file), 'utf8'); } catch { /* deleted or unreadable: fall to unattributed */ }
    const hits = commits.filter((c) => related(file, text, c.touched));
    return { file, prs: [...new Set(hits.map((c) => c.pr).filter((n) => n !== null))], commits: hits.map((c) => c.sha) };
  });
  return { base, head, batchPrs: [...new Set(commits.map((c) => c.pr).filter((n) => n !== null))], failures: entries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.env.RUNNER_TEMP ?? '.';
  const base = process.env.ASHLR_CI_BASE_SHA; const head = process.env.ASHLR_CI_HEAD_SHA;
  let report;
  try {
    const { failed } = JSON.parse(readFileSync(resolve(dir, 'fast-gate-failures.json'), 'utf8'));
    report = attribute({ cwd: process.cwd(), base, head, failed });
  } catch (error) {
    report = { base, head, error: error.message, failures: [] };
  }
  writeFileSync('merge-group-attribution.json', JSON.stringify(report, null, 2));
  const lines = ['### Merge group attribution', `Batch PRs: ${(report.batchPrs ?? []).map((n) => `#${n}`).join(', ') || 'unknown'}`];
  for (const f of report.failures) lines.push(`- \`${f.file}\`: ${f.prs.length ? f.prs.map((n) => `#${n}`).join(', ') : 'unattributed'}`);
  if (report.error) lines.push(`Attribution error: ${report.error}`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}
