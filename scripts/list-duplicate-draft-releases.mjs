#!/usr/bin/env node
// Dry-run inventory of duplicate GitHub releases: every tag that owns more
// than one release row (the draft-duplication state the release train used to
// create). Read-only — it never deletes, patches or creates anything; cleanup
// of the listed duplicates is a separate human decision. Drafts only appear to
// tokens with push access, so run it with the release-capable gh auth.
//
//   node scripts/list-duplicate-draft-releases.mjs [owner/repo]
//
// Prints JSON: { repo, scanned, groups: [{ tag, releases: [{ id, draft, created_at }] }] }.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;

/** Group release rows by tag; keep only tags with more than one release where
 * at least one is a draft (a published-plus-draft pair is still one feed but
 * worth seeing). Releases within a group sort by id so the row the train
 * treats as canonical — the lowest id — is first. */
export function duplicateDraftGroups(rows) {
  assert.ok(Array.isArray(rows), 'release listing did not return an array');
  const byTag = new Map();
  for (const row of rows) {
    if (!object(row) || typeof row.tag_name !== 'string' || !Number.isSafeInteger(row.id)) continue;
    const group = byTag.get(row.tag_name) ?? [];
    group.push(row);
    byTag.set(row.tag_name, group);
  }
  return [...byTag.entries()]
    .filter(([, group]) => group.length > 1 && group.some(r => r.draft === true))
    .map(([tag, group]) => ({ tag, releases: group
      .map(r => ({ id: r.id, draft: r.draft === true, created_at: r.created_at ?? null }))
      .sort((a, b) => a.id - b.id) }))
    .sort((a, b) => a.tag.localeCompare(b.tag));
}

function main() {
  const repo = process.argv[2] ?? process.env.REPO;
  if (!repo || repo === '--help' || repo === '-h') {
    console.log('Usage: node scripts/list-duplicate-draft-releases.mjs [owner/repo] — read-only duplicate-release inventory.');
    process.exitCode = repo ? 0 : 1; return;
  }
  assert.match(repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'unexpected repository name');
  const rows = JSON.parse(execFileSync('gh',
    ['api', '--hostname', 'github.com', '--paginate', `repos/${repo}/releases?per_page=100`],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, env: process.env }));
  const groups = duplicateDraftGroups(rows);
  console.log(JSON.stringify({ repo, scanned: rows.length, groups }, null, 2));
  if (groups.length > 0) console.error(`${groups.length} tag(s) own duplicate releases; see groups[].releases for ids.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
