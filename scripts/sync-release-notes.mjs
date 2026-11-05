// Normalize release-please's generated heading to Phantom's changelog contract,
// and commit the same candidate version across desktop/docs/manifest carriers.
import assert from 'node:assert/strict';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncCandidateVersion } from './sync-candidate-version.mjs';

export function normalizeReleaseNotes(text, version) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const lines = text.split('\n');
  const prefix = `## [${version}]`;
  const matches = lines.flatMap((line, i) => line === prefix || line.startsWith(`${prefix} — `) || line.startsWith(`${prefix}(`) ? [i] : []);
  assert.equal(matches.length, 1, 'release notes must contain one current version section');
  const start = matches[0];
  let end = lines.findIndex((line, i) => i > start && line.startsWith('## ['));
  if (end < 0) end = lines.length;
  const section = lines.slice(start, end);
  const date = /\b\d{4}-\d{2}-\d{2}\b/.exec(section[0])?.[0];
  assert.ok(date, 'release notes need a release date');
  section[0] = `${prefix} — ${date}`;
  assert.ok(section.slice(1).join('\n').trim().length > 50, 'release notes body is empty or too short');
  lines.splice(start, end - start);
  const unreleased = lines.findIndex(line => line === '## [Unreleased]');
  assert.ok(unreleased >= 0, 'changelog must preserve Unreleased');
  // Release-please prepends entries. Keep Phantom's explicit Unreleased section
  // first, while preserving its content and every previous release verbatim.
  let insertion = lines.findIndex((line, i) => i > unreleased && line.startsWith('## ['));
  if (insertion < 0) insertion = lines.length;
  lines.splice(insertion, 0, ...section);
  return lines.join('\n')
    .replace(/^\| Source package \| [^|]+ \|$/m, `| Source package | ${version} |`)
    .replace(/^\| Latest dated changelog release \([^)]+\) \| [^|]+ \|$/m, `| Latest dated changelog release (${date}) | ${version} |`);
}

export function syncReleaseNotes(root, version) {
  // Validate notes before the multi-file candidate update writes anything.
  const path = join(root, 'CHANGELOG.md');
  const notes = normalizeReleaseNotes(readFileSync(path, 'utf8'), version);
  const manifestPath = join(root, '.release-please-manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest), ['.']);
  const result = syncCandidateVersion(root, version);
  manifest['.'] = version;
  writeFileSync(path, notes);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: sync-release-notes.mjs X.Y.Z');
    console.log(JSON.stringify(syncReleaseNotes(join(dirname(fileURLToPath(import.meta.url)), '..'), process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
