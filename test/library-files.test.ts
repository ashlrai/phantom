import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listLeaderFiles } from '../src/core/fleet/library-files.js';

let root = '';
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });

describe('leader library files', () => {
  it('lists bounded files and drafts with redacted previews, ignoring links and oversized files', async () => {
    root = await mkdtemp(join(tmpdir(), 'library-files-'));
    const leader = join(root, 'leader');
    await mkdir(join(leader, 'drafts'), { recursive: true });
    const secret = 'ghp_' + 'abc123'.repeat(7);
    await writeFile(join(leader, 'VISION.md'), `A vision\n${secret}`);
    await writeFile(join(leader, 'PLAN-LOG.md'), 'x'.repeat(256 * 1024 + 1));
    await writeFile(join(leader, 'drafts', 'idea.md'), 'A draft');
    await symlink(join(leader, 'VISION.md'), join(leader, 'INSPIRATION.md'));
    const rows = await listLeaderFiles(root);
    expect(rows.map(row => row.name).sort()).toEqual(['VISION.md', 'drafts/idea.md']);
    expect(rows.find(row => row.name === 'VISION.md')?.preview).toContain('[REDACTED]');
    expect(JSON.stringify(rows)).not.toContain(secret);
    expect(rows.every(row => row.size > 0 && !Number.isNaN(Date.parse(row.modifiedAt)))).toBe(true);
  });
  it('returns an empty list when the leader directory is missing', async () => {
    root = await mkdtemp(join(tmpdir(), 'library-files-'));
    expect(await listLeaderFiles(root)).toEqual([]);
  });
});
