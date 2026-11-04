/** Pure temp-dir fixtures; no HOME, no git. Queue prompt names are the only claim source. */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { queuedCollisions, readQueuedPathClaims } from '../src/core/fleet/queued-path-claims.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function root() { const dir = await mkdtemp(join(tmpdir(), 'queued-claims-')); roots.push(dir); return dir; }
const prompt = (body: string) => `#job repo=phantom lane=fleet tier=work\n${body}`;
const A = 'RQ-PHX-FAKEQUEUEDA06';
const B = 'RQ-PHX-FAKEQUEUEDB06';

it('maps each claimed path to the sorted queued job ids that name it', async () => {
  const dir = await root();
  await mkdir(join(dir, 'queue/prompts'), { recursive: true });
  await writeFile(join(dir, 'queue/prompts', `${B}.md`), prompt('Edit src/core/fleet/example-a.ts and test/example-a.test.ts\n'));
  await writeFile(join(dir, 'queue/prompts', `${A}.md`), prompt('Edit src/core/fleet/example-a.ts\n'));
  // Names outside the RQ-PHX-<A-Z0-9{3,40}>.md shape never claim paths.
  await writeFile(join(dir, 'queue/prompts', 'notes.md'), prompt('src/core/fleet/example-a.ts\n'));
  await writeFile(join(dir, 'queue/prompts', 'RQ-PHX-lowercase.md'), prompt('src/core/fleet/example-a.ts\n'));
  const read = await readQueuedPathClaims({ runsRoot: dir });
  expect(read.sourceState).toBe('healthy');
  expect(read.claims).toEqual(new Map([
    ['src/core/fleet/example-a.ts', [A, B]],
    ['test/example-a.test.ts', [B]],
  ]));
});

it('reads the runs root from ASHLR_RUNS_DIR when runsRoot is not injected', async () => {
  const dir = await root();
  await mkdir(join(dir, 'queue/prompts'), { recursive: true });
  await writeFile(join(dir, 'queue/prompts', `${A}.md`), prompt('src/core/fleet/example-a.ts\n'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  const read = await readQueuedPathClaims();
  expect(read.sourceState).toBe('healthy');
  expect(read.claims.get('src/core/fleet/example-a.ts')).toEqual([A]);
});

it('reports missing when the prompts directory does not exist', async () => {
  const dir = await root();
  expect(await readQueuedPathClaims({ runsRoot: dir })).toEqual({ sourceState: 'missing', claims: new Map() });
  expect((await readQueuedPathClaims({ runsRoot: join(dir, 'absent') })).sourceState).toBe('missing');
});

it('refuses a symlinked prompts dir, file and root as degraded', async () => {
  const outside = await root();
  await mkdir(join(outside, 'prompts'), { recursive: true });
  await writeFile(join(outside, 'prompts', `${A}.md`), prompt('src/core/fleet/example-a.ts\n'));
  const dir = await root();
  await mkdir(join(dir, 'queue'), { recursive: true });
  await symlink(join(outside, 'prompts'), join(dir, 'queue/prompts'), 'dir');
  expect(await readQueuedPathClaims({ runsRoot: dir })).toEqual({ sourceState: 'degraded', claims: new Map() });

  const fileDir = await root();
  await mkdir(join(fileDir, 'queue/prompts'), { recursive: true });
  await symlink(join(outside, 'prompts', `${A}.md`), join(fileDir, 'queue/prompts', `${A}.md`));
  await writeFile(join(fileDir, 'queue/prompts', `${B}.md`), prompt('src/other.ts\n'));
  const mixed = await readQueuedPathClaims({ runsRoot: fileDir });
  expect(mixed.sourceState).toBe('degraded');
  expect(mixed.claims).toEqual(new Map([['src/other.ts', [B]]]));

  const linkRoot = await root();
  await symlink(outside, join(linkRoot, 'runs'), 'dir');
  expect((await readQueuedPathClaims({ runsRoot: join(linkRoot, 'runs') })).sourceState).toBe('degraded');
});

it('skips an over-16-KiB prompt and a non-file entry as degraded', async () => {
  const dir = await root();
  await mkdir(join(dir, 'queue/prompts', 'RQ-PHX-DIRNAME06.md'), { recursive: true });
  await writeFile(join(dir, 'queue/prompts', `${A}.md`), prompt('x'.repeat(17 * 1024)));
  await writeFile(join(dir, 'queue/prompts', `${B}.md`), prompt('src/core/fleet/example-a.ts\n'));
  const read = await readQueuedPathClaims({ runsRoot: dir });
  expect(read.sourceState).toBe('degraded');
  expect(read.claims).toEqual(new Map([['src/core/fleet/example-a.ts', [B]]]));
});

it('caps the scan at 400 prompts, sorted, and marks a longer queue degraded', async () => {
  const dir = await root();
  const prompts = join(dir, 'queue/prompts');
  await mkdir(prompts, { recursive: true });
  for (let i = 1; i <= 401; i += 1) {
    await writeFile(join(prompts, `RQ-PHX-Q${String(i).padStart(4, '0')}.md`), prompt(`src/f${String(i).padStart(4, '0')}.ts\n`));
  }
  const read = await readQueuedPathClaims({ runsRoot: dir });
  expect(read.sourceState).toBe('degraded');
  expect(read.claims.size).toBe(400);
  expect(read.claims.get('src/f0001.ts')).toEqual(['RQ-PHX-Q0001']);
  expect(read.claims.has('src/f0401.ts')).toBe(false);
});

it('injected readDir/readFile seams still stat every file under the root', async () => {
  const dir = await root();
  const prompts = join(dir, 'queue/prompts');
  await mkdir(prompts, { recursive: true });
  await writeFile(join(prompts, `${A}.md`), 'unused\n');
  const read = await readQueuedPathClaims({
    runsRoot: dir,
    readDir: async () => [`${A}.md`, 'not-a-job.txt'],
    readFile: async () => 'Edit src/injected.ts\n',
  });
  expect(read.sourceState).toBe('healthy');
  expect(read.claims).toEqual(new Map([['src/injected.ts', [A]]]));
});

it('queuedCollisions ignores a draft re-issue, reports other claimants sorted', () => {
  const claims = new Map([
    ['src/a.ts', [B, A]],
    ['src/b.ts', [A]],
    ['src/c.ts', [B]],
  ]);
  const hits = queuedCollisions(
    [
      { name: `${A}.md`, paths: ['src/b.ts', 'src/a.ts'] },
      { name: 'RQ-PHX-DRAFTC06.md', paths: ['src/c.ts', 'src/a.ts'] },
      { name: 'RQ-PHX-DRAFTD06.md', paths: ['src/nowhere.ts'] },
    ],
    claims,
  );
  expect(hits).toEqual([
    // src/a.ts: A's own queued id filtered out for A's draft, kept for C's.
    { path: 'src/a.ts', draft: 'RQ-PHX-DRAFTC06.md', queued: [B, A] },
    { path: 'src/a.ts', draft: `${A}.md`, queued: [B] },
    { path: 'src/c.ts', draft: 'RQ-PHX-DRAFTC06.md', queued: [B] },
  ]);
});
