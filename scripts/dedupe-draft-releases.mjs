#!/usr/bin/env node
// Dry run: node scripts/dedupe-draft-releases.mjs owner/repo
// Explicit deletion: append --apply. Never invoked by CI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const versionTag = /^v\d+\.\d+\.\d+$/;
const emptyDraft = row => row?.draft === true && Array.isArray(row.assets) && row.assets.length === 0;

export function dedupePlan(rows) {
  assert.ok(Array.isArray(rows), 'release listing did not return an array');
  const groups = new Map();
  for (const row of rows) {
    if (!versionTag.test(row.tag_name ?? '') || !Number.isSafeInteger(row.id)) continue;
    const group = groups.get(row.tag_name) ?? [];
    group.push(row);
    groups.set(row.tag_name, group);
  }
  return [...groups].flatMap(([tag, group]) => {
    // Mixed published/stocked groups need individual review, never deletion.
    if (group.length < 2 || !group.every(emptyDraft)) return [];
    group.sort((a, b) => b.id - a.id);
    return [{ tag, keep: group[0].id, remove: group.slice(1).map(row => row.id) }];
  }).sort((a, b) => a.tag.localeCompare(b.tag));
}

export async function dedupeDrafts({ repo, read, remove, apply = false }) {
  assert.match(repo, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'unexpected repository name');
  const base = `repos/${repo}/releases`;
  const rows = [];
  for (let page = 1; ; page++) {
    const batch = await read(`${base}?per_page=100&page=${page}`);
    assert.ok(Array.isArray(batch), 'release listing did not return an array');
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  const groups = dedupePlan(rows);
  if (apply) {
    for (const group of groups) {
      for (const id of group.remove) {
        // Recheck both rows immediately before deletion; abort on any change.
        const keep = await read(`${base}/${group.keep}`);
        const candidate = await read(`${base}/${id}`);
        assert.ok([keep, candidate].every(row => emptyDraft(row) && row.tag_name === group.tag),
          'release changed since inventory; refusing deletion');
        assert.equal(keep.id, group.keep);
        assert.equal(candidate.id, id);
        await remove(`${base}/${id}`);
      }
    }
  }
  return { repo, apply, scanned: rows.length, groups };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const positional = args.filter(arg => arg !== '--apply');
  assert.ok(positional.length === 1 && !positional[0].startsWith('-'),
    'Usage: node scripts/dedupe-draft-releases.mjs owner/repo [--apply]');
  const api = args => execFileSync('gh', ['api', '--hostname', 'github.com', ...args],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  console.log(JSON.stringify(await dedupeDrafts({ repo: positional[0], apply,
    read: async endpoint => JSON.parse(api([endpoint])),
    remove: async endpoint => { api(['-X', 'DELETE', endpoint]); },
  }), null, 2));
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
