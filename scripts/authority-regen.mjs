import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function authoritySummary(beforeSnapshot, afterSnapshot, beforeOwners, afterOwners) {
  const changes = (before, after) => {
    const old = new Set(before);
    const current = new Set(after);
    return [...before.filter((line) => !current.has(line)).map((line) => `- ${line}`),
      ...after.filter((line) => !old.has(line)).map((line) => `+ ${line}`)];
  };
  const lines = (text) => text.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  return [['Tier-1 roots', changes(beforeSnapshot.roots, afterSnapshot.roots)],
    ['Tier-1 closure', changes(beforeSnapshot.closure, afterSnapshot.closure)],
    ['CODEOWNERS lines', changes(lines(beforeOwners), lines(afterOwners))]]
    .map(([title, entries]) => `${title}:\n${entries.length ? entries.join('\n') : '  (no changes)'}`).join('\n');
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const snapshot = resolve(root, 'test/fixtures/authority/tier1-closure.json');
  const owners = resolve(root, '.github/CODEOWNERS');
  const readSnapshot = () => JSON.parse(readFileSync(snapshot, 'utf8'));
  const beforeSnapshot = readSnapshot();
  const beforeOwners = readFileSync(owners, 'utf8');
  for (const [key, test] of [
    ['ASHLR_UPDATE_CODEOWNERS', 'test/authority-codeowners-310b.test.ts'],
    ['ASHLR_UPDATE_TIER1_CLOSURE', 'test/authority-tier1-closure-310b.test.ts'],
  ]) {
    const result = spawnSync(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', test], {
      cwd: root, stdio: 'inherit', env: { ...process.env, [key]: '1' },
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${test} regeneration failed`);
  }
  console.log(authoritySummary(beforeSnapshot, readSnapshot(), beforeOwners, readFileSync(owners, 'utf8')));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
