import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet-entry.js';
import queue from '../src/cli/security-repin-queue.json' with { type: 'json' };

describe('fleet re-pin queue', () => {
  it('reads the bundled snapshot through the executable fleet dispatcher', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await cmdFleet(['repin-queue', '--json'])).toBe(0);
      expect(log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(queue));
      expect(await cmdFleet(['repin-queue', '--help'])).toBe(0);
      expect(log).toHaveBeenLastCalledWith(expect.stringContaining('phm fleet repin-queue --json'));
      expect(await cmdFleet(['repin-queue', '--apply'])).toBe(2);
      expect(error).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });

  it('matches every PR, digest, and command in the operator documentation', () => {
    const doc = readFileSync(new URL('../docs/SECURITY-REPIN-QUEUE.md', import.meta.url), 'utf8');
    const [, ...sections] = doc.split(/^## /m);
    expect(queue.schema).toBe('fleet.repin-queue.v1');
    expect(doc).toContain(queue.snapshotCommit);
    expect(sections).toHaveLength(queue.entries.length);
    for (const [index, entry] of queue.entries.entries()) {
      const section = sections[index]!;
      expect(section).toContain(`[#${entry.pr}](https://github.com/ashlrai/phantom/pull/${entry.pr}): ${entry.title}`);
      expect(section).toContain(`Merge: \`${entry.mergeCommit}\``);
      expect(section).toContain(`- Preview: ${entry.previewCommand ? '`' + entry.previewCommand + '`' : 'not applicable'}.`);
      expect(section).toContain(`- Install after approval: ${entry.installCommand ? '`' + entry.installCommand + '`' : 'no supported repository command for this entry'}.`);
      expect(section).toContain(entry.notes);
      expect(section.match(/^\| `(?:contrib|fleet)\//gm)).toHaveLength(entry.files.length);
      for (const file of entry.files) {
        expect(file.reviewedSha256).toMatch(/^[0-9a-f]{64}$/);
        if (file.liveSha256 !== null) expect(file.liveSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(section).toContain(`| \`${file.path}\` | \`${file.reviewedSha256}\` | \`${file.liveSha256 ?? 'unknown'}\` | ${file.action} | ${file.liveEvidence ?? '—'} |`);
      }
    }
  });
});
