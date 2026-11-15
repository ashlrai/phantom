import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetCoordination } from '../src/cli/fleet-coordination.js';
import { cmdFleetReviewTake, type FleetReviewTakeDeps } from '../src/cli/fleet-review-take.js';
import { readFleetBoard } from '../src/core/fleet/coordination.js';
import type { ReviewTakeReport } from '../src/core/fleet/review-take.js';

const repo = 'example/phantom';
const agent = 'agent-one';
const sha = 'a'.repeat(40);
const oldLedgerPath = process.env['PHANTOM_FLEET_LEDGER_PATH'];
let temporary = '';

afterEach(() => {
  vi.restoreAllMocks();
  if (oldLedgerPath === undefined) delete process.env['PHANTOM_FLEET_LEDGER_PATH'];
  else process.env['PHANTOM_FLEET_LEDGER_PATH'] = oldLedgerPath;
  if (temporary) rmSync(temporary, { recursive: true, force: true });
  temporary = '';
});

describe('review CLI durable coordination lease', () => {
  it('fences release and makes the still-open PR available again', async () => {
    temporary = mkdtempSync(join(tmpdir(), 'review-release-'));
    const ledger = join(temporary, 'coordination.jsonl');
    writeFileSync(ledger, '', { mode: 0o600 });
    process.env['PHANTOM_FLEET_LEDGER_PATH'] = ledger;
    const deps: FleetReviewTakeDeps = {
      runsDir: join(temporary, 'runs'),
      gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{
        number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: sha,
        isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
      }]) }),
      readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
      inspectBusWork: () => ({ source: 'available', claims: [] }),
      listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
    };
    const take = async (): Promise<ReviewTakeReport> => {
      let stdout = '';
      let stderr = '';
      const code = await cmdFleetReviewTake(['--agent', agent, '--repo', repo, '--json'], {
        ...deps, stdout: text => { stdout += text; }, stderr: text => { stderr += text; },
      });
      expect(code).toBe(0);
      expect(stderr).toBe('');
      return JSON.parse(stdout) as ReviewTakeReport;
    };
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const first = await take();
    expect(first).toMatchObject({ schema: 'fleet.review-take.v1', outcome: 'claimed', repo, pr: 10, owner: agent });
    expect(first.claim).not.toBeNull();
    expect(first.lease).toEqual(expect.any(String));
    const claim = first.claim!;
    const lease = first.lease!;
    const board = readFleetBoard();
    expect(board.state).toBe('known');
    expect(board.claims).toHaveLength(1);
    expect(board.claims[0]).toMatchObject({ id: claim.id, task: claim.task, repo, agent });
    expect(claim.task).toBe(`review ${repo}#10 example/review @${sha.slice(0, 12)}`);
    const events = readFileSync(ledger, 'utf8');
    expect(events.includes(lease)).toBe(false);
    expect(JSON.stringify(board).includes(lease)).toBe(false);
    expect(JSON.parse(events.trim())).toMatchObject({ kind: 'claim', claim: { id: claim.id, task: claim.task, agent } });

    expect(await cmdFleetCoordination(['release', claim.id, '--agent', agent, '--lease', 'wrong-fake-lease', '--json'])).toBe(1);
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({ ok: false, error: 'not-owner' });
    expect(readFleetBoard().claims).toMatchObject([{ id: claim.id, task: claim.task, agent }]);
    expect(await cmdFleetCoordination(['release', claim.id, '--agent', agent, '--lease', lease, '--json'])).toBe(0);
    expect(JSON.parse(String(output.mock.lastCall?.[0]))).toEqual({ ok: true, value: { released: claim.id } });
    expect(readFleetBoard().claims).toEqual([]);
    expect(readFileSync(ledger, 'utf8').includes(lease)).toBe(false);
    const second = await take();
    expect(second).toMatchObject({ outcome: 'claimed', repo, pr: 10, owner: agent, claim: { task: claim.task } });
    expect(second.claim?.id).not.toBe(claim.id);
    expect(readFleetBoard().claims).toMatchObject([{ id: second.claim?.id, task: claim.task, agent }]);
    expect(errors).not.toHaveBeenCalled();
    let help = '';
    expect(await cmdFleetReviewTake(['--help'], { stdout: text => { help += text; } })).toBe(0);
    expect(help).toContain('grants no merge, push or dispatch authority');
  });
});
