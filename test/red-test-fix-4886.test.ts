import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDefaultReleaseAnnouncement, runReleaseAnnouncement, type ObservedRelease } from '../src/core/fleet/release-live-announce.js';

const ROOT = join(__dirname, '..');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json');
const LEADER = join(ROOT, 'src', 'core', 'vision', 'leader.ts');

const LIVE: ObservedRelease = { version: '9.9.9', live: true };

/**
 * Fix of #4886 (RQ-PHX-RELEASELIVEANNOUNCE96). The PR wired a release-live
 * announcement into the Leader tick via a dynamic import; that pulled
 * release-live-announce.ts, release-live-notice.ts and app-update-status.ts
 * into the Tier-1 authority import closure and the hermetic drift check
 * (test/authority-tier1-closure-310b.test.ts) failed on a stale snapshot.
 * These cases pin both halves: the reviewed snapshot keeps the new chain,
 * and the wiring the closure now covers stays safe — a failed post rejects
 * the run without advancing state or holding the lock, so the next tick
 * retries and the leader catch contains it.
 */
describe('red-test-fix-4886', () => {
  it('the reviewed Tier-1 closure snapshot records the release-announcement chain', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { closure: string[] };
    for (const file of [
      'src/core/fleet/release-live-announce.ts',
      'src/core/fleet/release-live-notice.ts',
      'src/core/app-update-status.ts',
    ]) {
      expect(snapshot.closure).toContain(file);
    }
  });

  it('leader.ts wires announceRelease through the fleet module with failure containment', () => {
    const source = readFileSync(LEADER, 'utf8');
    expect(source).toContain("announceRelease: () => import('../fleet/release-live-announce.js').then(m => m.runDefaultReleaseAnnouncement())");
    expect(source).toContain('if (deps.announceRelease)');
    expect(source).toContain('leader tick: release announcement failed');
  });

  it('runDefaultReleaseAnnouncement stays exported for the leader wiring', () => {
    expect(typeof runDefaultReleaseAnnouncement).toBe('function');
  });

  describe('a throwing post', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rtf4886-')); });
    afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

    const deps = (post: (text: string) => void) => ({
      stateDir: dir,
      readRelease: async () => LIVE,
      readInstalled: () => null,
      post,
    });

    it('rejects, leaves state unadvanced and releases the lock for the retry', async () => {
      await expect(runReleaseAnnouncement(deps(() => { throw new Error('post boom'); }))).rejects.toThrow('post boom');
      // State file was not advanced past the failed post.
      expect(() => readFileSync(join(dir, 'release-announce.json'), 'utf8')).toThrow();
      // The lock is gone: the immediate retry posts cleanly.
      const posted: string[] = [];
      const again = await runReleaseAnnouncement(deps((text) => { posted.push(text); }));
      expect(again.skipped).toBeNull();
      expect(posted).toEqual(['Phantom v9.9.9 is published and the update feed is live. Installed here: unknown.']);
    });
  });
});
