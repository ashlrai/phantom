#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import console from 'node:console';

const begin = '<!-- changelog-sync:start -->';
const end = '<!-- changelog-sync:end -->';
const normalize = (body) => body.replace(/\r\n/g, '\n').trim();

function sections(text) {
  const headings = [...text.matchAll(/^## \[([^\]\n]+)\][^\n]*$/gm)];
  const seen = new Set();
  return headings.map((match, i) => {
    if (seen.has(match[1])) throw new Error('Duplicate changelog heading');
    seen.add(match[1]);
    return {
      name: match[1], heading: match[0], start: match.index + match[0].length,
      end: headings[i + 1]?.index ?? text.length,
    };
  });
}

// Bridge merges are titled `bridge(<JOB-ID>): <subject>` and most subjects are
// boilerplate ("BRIDGE_NOTES — <JOB-ID>"). Returns the reader-facing subject, or
// null when the entry should be omitted (boilerplate, bare job id, FIXUP- repair jobs).
function bridgeSubject(scope, subject) {
  if (scope && /^FIXUP-/i.test(scope)) return null;
  const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tail = '(?:\\s*[:—–]\\s*|\\s+-\\s+|\\s*$)';
  const prefixes = [new RegExp(`^(?:bridge[ _-]?notes(?:\\.md)?|handoff)\\b${tail}`, 'i')];
  if (scope) prefixes.unshift(new RegExp(`^${escape(scope)}${tail}`, 'i'));
  let rest = subject.trim();
  for (let again = true; again && rest;) {
    again = false;
    for (const prefix of prefixes) {
      const next = rest.replace(prefix, '').trim();
      if (next !== rest) { rest = next; again = true; }
    }
  }
  return !rest || /^(?:RQ|FIXUP)-[A-Za-z0-9._-]+$/.test(rest) ? null : rest;
}

function update(text, data) {
  if (!Array.isArray(data.commits) || !Array.isArray(data.pullRequests)) {
    throw new Error('Snapshot requires commits and pullRequests arrays');
  }
  const section = sections(text).find((s) => /unreleased/i.test(s.heading));
  if (!section) throw new Error('Missing Unreleased section');
  const groups = new Map(['Added', 'Fixed', 'Performance', 'Reverted', 'Changed'].map((g) => [g, []]));
  const merged = data.pullRequests.filter((pr) => pr.mergedAt);
  const covered = new Set(merged.flatMap((pr) => [pr.mergeCommit?.oid, ...(pr.commits ?? []).map((c) => c.oid)]));
  const entries = [
    ...merged.map((pr) => ({ message: pr.title, suffix: ` (#${pr.number})` })),
    ...data.commits.filter((c) => !covered.has(c.oid)).map((c) => ({ message: c.message, suffix: '' })),
  ];
  const seen = new Set();
  for (const entry of entries) {
    if (typeof entry.message !== 'string' || /[\r\n]/.test(entry.message)) throw new Error('Expected single-line subject');
    const match = entry.message.match(/^([a-z]+)(?:\(([^)]+)\))?(!)?: (.+)$/);
    if (!match) continue;
    if (match[1] === 'bridge') {
      match[4] = bridgeSubject(match[2], match[4]);
      if (match[4] === null) continue;
    }
    const group = new Map([['feat', 'Added'], ['fix', 'Fixed'], ['perf', 'Performance'], ['revert', 'Reverted']]).get(match[1]) ?? 'Changed';
    const line = `- ${match[3] ? '**BREAKING** ' : ''}${match[2] ? `**${match[2]}:** ` : ''}${match[4]}${entry.suffix}`;
    if (!seen.has(line)) groups.get(group).push(line);
    seen.add(line);
  }
  const block = [begin, ...[...groups].filter(([, lines]) => lines.length).flatMap(([g, lines]) => ['', `### ${g}`, ...lines]), '', end].join('\n');
  let body = text.slice(section.start, section.end);
  const starts = body.split(begin).length - 1;
  const ends = body.split(end).length - 1;
  if (starts !== ends || starts > 1 || (starts && body.indexOf(begin) > body.indexOf(end))) throw new Error('Malformed generated block');
  body = starts ? body.slice(0, body.indexOf(begin)) + block + body.slice(body.indexOf(end) + end.length) : `${body.trimEnd()}\n\n${block}\n\n`;
  return text.slice(0, section.start) + body + text.slice(section.end);
}

function verify(text, data) {
  if (!Array.isArray(data.tags) || !Array.isArray(data.releases)) throw new Error('Snapshot requires tags and releases arrays');
  if (new Set(data.tags).size !== data.tags.length) throw new Error('Duplicate release tag');
  const all = sections(text);
  const failures = [];
  for (const tag of data.tags) {
    if (typeof tag !== 'string' || !/^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(tag)) throw new Error('Invalid release tag');
    const section = all.find((s) => s.name === tag.replace(/^v/, ''));
    const releases = data.releases.filter((r) => r.tagName === tag && r.isDraft === false);
    if (!section || releases.length !== 1 || typeof releases[0].body !== 'string' || !normalize(releases[0].body) || normalize(text.slice(section.start, section.end)) !== normalize(releases[0].body)) failures.push(tag);
  }
  if (failures.length) throw new Error(`Release mismatch or missing evidence: ${failures.join(', ')}`);
  return data.tags.length;
}

try {
  const [mode, ...args] = process.argv.slice(2);
  if (!['update', 'verify'].includes(mode)) throw new Error('Usage: changelog-sync update|verify --snapshot FILE [--changelog FILE] [--write]');
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--snapshot', '--changelog', '--write'].includes(key) || key in options) throw new Error('Unknown or duplicate option');
    options[key] = key === '--write' ? true : args[++i];
    if (!options[key] || (typeof options[key] === 'string' && options[key].startsWith('--'))) throw new Error('Missing option value');
  }
  if (!options['--snapshot']) throw new Error('A scoped GitHub snapshot is required');
  if (mode === 'verify' && options['--write']) throw new Error('verify cannot write');
  const path = options['--changelog'] ?? 'CHANGELOG.md';
  const text = readFileSync(path, 'utf8');
  const data = JSON.parse(readFileSync(options['--snapshot'], 'utf8'));
  if (mode === 'verify') {
    if (!data.tags) data.tags = execFileSync('git', ['tag', '--list'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    if (!data.tags.length) throw new Error('No tags to verify');
    console.log(`Verified ${verify(text, data)} tags`);
  } else {
    // The snapshot bounds PRs to the same base..HEAD range as these commits.
    if (!data.commits) {
      if (!/^[a-f0-9]{40}$/.test(data.base ?? '')) throw new Error('Snapshot base must be a full commit SHA');
      data.commits = execFileSync('git', ['log', '--reverse', '--format=%H%x09%s', `${data.base}..HEAD`], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map((line) => { const [oid, ...subject] = line.split('\t'); return { oid, message: subject.join('\t') }; });
    }
    const next = update(text, data);
    if (options['--write']) writeFileSync(path, next);
    else process.stdout.write(next);
  }
} catch (error) {
  console.error(`changelog-sync: ${error.message}`);
  process.exitCode = 1;
}
