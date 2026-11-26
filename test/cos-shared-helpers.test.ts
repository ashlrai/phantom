import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fleetCosCliMod from '../src/cli/fleet-cos.js';
import * as draftsMod from '../src/core/cos/drafts.js';
import * as intakeMod from '../src/core/cos/intake.js';
import * as loopMod from '../src/core/cos/loop.js';
import * as memoryMod from '../src/core/cos/memory.js';
import * as pagesMod from '../src/core/cos/pages.js';
import * as peerPlanMod from '../src/core/cos/peer-plan.js';
import { readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import * as cosMemoryApiMod from '../src/core/verse/cos-memory-api.js';
import * as fleetCosApiMod from '../src/core/verse/fleet-cos-api.js';

let tempRoot = '';
let prevAshlrHome: string | undefined;
let prevRunsDir: string | undefined;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'cos-shared-helpers-'));
  prevAshlrHome = process.env['ASHLR_HOME'];
  prevRunsDir = process.env['ASHLR_RUNS_DIR'];
});

afterEach(() => {
  vi.restoreAllMocks();
  if (prevAshlrHome === undefined) delete process.env['ASHLR_HOME'];
  else process.env['ASHLR_HOME'] = prevAshlrHome;
  if (prevRunsDir === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = prevRunsDir;
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('cos shared helpers', () => {
  it('resolves runsDir, cosDir, and cosQueueStore consistently', () => {
    delete process.env['ASHLR_RUNS_DIR'];
    expect(intakeMod.resolveCosRunsDir()).toBe(join(homedir(), '.ashlr-runs'));

    const envRuns = join(tempRoot, 'env-runs');
    process.env['ASHLR_RUNS_DIR'] = envRuns;
    expect(intakeMod.resolveCosRunsDir()).toBe(envRuns);
    expect(intakeMod.cosDir()).toBe(join(envRuns, 'cos'));
    expect(intakeMod.cosQueueStore().directory).toBe(join(envRuns, 'queue'));

    const explicitRuns = join(tempRoot, 'explicit-runs');
    expect(intakeMod.resolveCosRunsDir(explicitRuns)).toBe(explicitRuns);
    expect(intakeMod.cosDir(explicitRuns)).toBe(join(explicitRuns, 'cos'));
    expect(intakeMod.cosQueueStore(explicitRuns).directory).toBe(join(explicitRuns, 'queue'));
  });

  it('validates plain records, cos job ids, and 64-hex digests', () => {
    expect(intakeMod.isPlainRecord({})).toBe(true);
    expect(intakeMod.isPlainRecord({ a: 1 })).toBe(true);
    expect(intakeMod.isPlainRecord(null)).toBe(false);
    expect(intakeMod.isPlainRecord([])).toBe(false);
    expect(intakeMod.isPlainRecord('str')).toBe(false);

    const validId = `cos-${'a'.repeat(32)}`;
    expect(intakeMod.isCosJobId(validId)).toBe(true);
    expect(intakeMod.isCosJobId(`cos-${'A'.repeat(32)}`)).toBe(false);
    expect(intakeMod.isCosJobId(`cos-${'a'.repeat(31)}`)).toBe(false);
    expect(intakeMod.isCosJobId('RQ-1234')).toBe(false);
    expect(intakeMod.isCosJobId(null)).toBe(false);

    const validDigest = '0123456789abcdef'.repeat(4);
    expect(intakeMod.isCosDigest(validDigest)).toBe(true);
    expect(intakeMod.isCosDigest(validDigest.toUpperCase())).toBe(false);
    expect(intakeMod.isCosDigest(validDigest.slice(0, 63))).toBe(false);
    expect(intakeMod.isCosDigest(undefined)).toBe(false);
  });

  it('parses valid cos-intake routes and rejects malformed acceptance payloads', () => {
    expect(intakeMod.parseCosIntakeRoute(JSON.stringify({
      kind: 'cos-intake',
      origin: { channel: 'telegram', senderId: 'telegram:123', threadId: '55' },
    }))).toEqual({
      kind: 'cos-intake',
      origin: { channel: 'telegram', senderId: 'telegram:123', threadId: '55' },
    });

    expect(intakeMod.parseCosIntakeRoute(JSON.stringify({
      kind: 'cos-intake',
      origin: { channel: 'cli', senderId: 'cos-local' },
    }))).toEqual({
      kind: 'cos-intake',
      origin: { channel: 'cli', senderId: 'cos-local' },
    });

    for (const invalid of [
      'not json',
      '[]',
      JSON.stringify({ kind: 'other', origin: { channel: 'cli', senderId: 'x' } }),
      JSON.stringify({ kind: 'cos-intake' }),
      JSON.stringify({ kind: 'cos-intake', origin: { channel: 'cli' } }),
      JSON.stringify({ kind: 'cos-intake', origin: { channel: 'cli', senderId: 'x', threadId: 42 } }),
    ]) {
      expect(intakeMod.parseCosIntakeRoute(invalid)).toBeNull();
    }
  });

  it('writes delivery claims with mode 0600 and honors exclusive creation', async () => {
    const dir = intakeMod.cosDir(tempRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const id = `cos-${'b'.repeat(32)}`;
    const path = intakeMod.cosDeliveryPath(id, tempRoot);

    await intakeMod.writeCosDeliveryState(path, 'sending', { exclusive: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ state: 'sending' });
    expect(statSync(path).mode & 0o777).toBe(0o600);

    await expect(intakeMod.writeCosDeliveryState(path, 'declined', { exclusive: true }))
      .rejects.toMatchObject({ code: 'EEXIST' });

    await intakeMod.writeCosDeliveryState(path, 'sent');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ state: 'sent' });
  });

  it('closes needs-you approval lines for both desktop and cli sources', () => {
    const id = `cos-${'c'.repeat(32)}`;
    writeFileSync(
      join(tempRoot, 'NEEDS-MASON.md'),
      `- [ ] Approve chief-of-staff reply ${id}; inspect with phm cos status ${id} --json\n`,
    );
    expect(readNeedsMason({ runsDir: tempRoot }).items).toHaveLength(1);

    intakeMod.closeCosNeedsYou(id, tempRoot, 'cli');
    expect(readNeedsMason({ runsDir: tempRoot }).items).toEqual([]);
  });

  it('validates draft statuses and memory kinds consistently', () => {
    expect(draftsMod.isDraftStatus('pending')).toBe(true);
    expect(draftsMod.isDraftStatus('approved')).toBe(true);
    expect(draftsMod.isDraftStatus('rejected')).toBe(true);
    expect(draftsMod.isDraftStatus('sent')).toBe(false);
    expect(draftsMod.isDraftStatus(null)).toBe(false);

    expect(memoryMod.isMemoryKind('preference')).toBe(true);
    expect(memoryMod.isMemoryKind('doctrine')).toBe(true);
    expect(memoryMod.isMemoryKind('fact')).toBe(true);
    expect(memoryMod.isMemoryKind('note')).toBe(false);
    expect(memoryMod.isMemoryKind(undefined)).toBe(false);
  });

  it('returns the full published page shape and truncates long descriptions in pagesApiGetResponse', () => {
    process.env['ASHLR_HOME'] = join(tempRoot, 'home');
    const source = join(tempRoot, 'report.md');
    const longDesc = 'word '.repeat(60).trim();
    writeFileSync(source, `---\ntitle: Weekly Review\ndescription: "${longDesc}"\n---\n# Weekly Review\n\nBody text.\n`);

    const published = pagesMod.publishPage({ filePath: source, slug: 'weekly-review' });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.page.description?.length).toBeLessThanOrEqual(200);
    expect(published.page.description?.endsWith('…')).toBe(true);

    const response = pagesMod.pagesApiGetResponse('/api/pages/weekly-review');
    expect(response).toEqual({ status: 200, body: published.page });
  });

  it('does not export pruned internal constants and helpers', () => {
    expect('cosApprovalTexts' in intakeMod).toBe(false);
    expect('draftDigest' in draftsMod).toBe(false);
    expect('DRAFT_STATUSES' in draftsMod).toBe(false);
    expect('COS_LOOP_BLOCKED_STREAK_LIMIT' in loopMod).toBe(false);
    expect('COS_LOOP_DEFAULT_PASS_TIMEOUT_MS' in loopMod).toBe(false);
    expect('COS_PEER_PLAN_MAX_DEADLINE_MS' in peerPlanMod).toBe(false);
    expect('PAGES_SCHEMA_VERSION' in pagesMod).toBe(false);
    expect('MAX_PAGE_FILE_BYTES' in pagesMod).toBe(false);
    expect('MAX_LIST_ENTRIES' in pagesMod).toBe(false);
    expect('PAGES_API_PATH' in pagesMod).toBe(false);
    expect('FLEET_COS_USAGE' in fleetCosCliMod).toBe(false);
    expect('VERSE_FLEET_COS_ASK_PATH' in fleetCosApiMod).toBe(false);
    expect('VERSE_FLEET_COS_STATUS_PATH' in fleetCosApiMod).toBe(false);
    expect('VERSE_FLEET_COS_APPROVE_PATH' in fleetCosApiMod).toBe(false);
    expect('VERSE_COS_MEMORY_PATH' in cosMemoryApiMod).toBe(false);
    expect('VERSE_COS_MEMORY_FORGET_PATH' in cosMemoryApiMod).toBe(false);
  });
});
