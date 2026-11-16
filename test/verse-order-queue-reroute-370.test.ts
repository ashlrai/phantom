import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readOrderTrace } from '../src/core/fleet/order-trace.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';
import { listLiveWorkers } from '../src/core/fleet/runs-live-workers.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { createFleetOrderStateApi, VERSE_FLEET_ORDER_STATE_PATH as PATH } from '../src/core/verse/fleet-order-state-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = Date.parse('2026-11-14T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();
const UNTIL = '2026-11-15T00:00:00.000Z';
const JOB = 'RQ-PHX-FAKEREROUTE370';
const A = 'codex-personal';
const B = 'devin';
const PRIVATE = 'PRIVATE-hold-reason-370';
const BODY = 'PRIVATE-order-body-370';

async function request(api: ApiModule) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url: PATH } as IncomingMessage, res, PATH, 'GET');
  expect(handled).toBe(true);
  expect(status).toBe(200);
  return { text, body: JSON.parse(text) };
}

describe('desktop order status follows queue reassignment', () => {
  it('refreshes ownership and held-lane evidence on one handler across removal and recovery', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'order-reroute-370-'));
    const root = join(parent, 'runs');
    const queue = join(root, 'queue');
    const prompt = join(queue, 'prompts', `${JOB}.md`);
    const ready = join(queue, 'ready.tsv');
    const route = (lane: string) => writeFile(ready, `${JOB}\tphantom\t${lane}\twork\t${prompt}\n`);
    const slots = (holdB: boolean) => writeFile(join(queue, 'slots.json'), JSON.stringify({
      [A]: { target: 1, floor: 0, ceiling: 4, held: true, held_reason: PRIVATE, held_until: UNTIL },
      [B]: { target: 1, floor: 0, ceiling: 4, held: holdB, held_reason: PRIVATE, held_until: UNTIL },
      hard_cap: 10,
    }));
    try {
      await mkdir(join(queue, 'prompts'), { recursive: true });
      await mkdir(join(root, 'leader'), { recursive: true });
      await mkdir(join(root, 'metrics'), { recursive: true });
      await writeFile(join(root, 'leader', 'MASON-INBOX.md'), `## 2026-11-14 04:30 ET (Mason, Fake console) PRIORITY P0\n${BODY}\n`);
      await writeFile(prompt, "Serves Mason's Nov 14 04:30 order.\n");
      await writeFile(join(root, 'metrics', 'jobs.jsonl'), '');
      await slots(false);
      await route(A);
      const api = createFleetOrderStateApi({
        now: () => new Date(NOW),
        read: (opts) => readOrderTrace({ ...opts, runsDir: root }),
        lanes: () => readLaneTargets({ runsDir: root, now: () => new Date(NOW) }),
        live: () => listLiveWorkers({ runPs: async () => '100  12:34 /sbin/launchd\n', now: () => NOW }),
      });
      const check = async (lane: string | null, blocked: boolean, queueHealth: string) => {
        const { body, text } = await request(api);
        expect(body.sources.queue).toBe(queueHealth);
        expect(body.live).toBe('healthy');
        expect(body.lanes).toBe('healthy');
        expect(body.asOf).toBe(ISO);
        expect(body.orders).toHaveLength(1);
        const order = body.orders[0];
        expect(order.key).toBe('11-14 04:30');
        expect(order.source).toBe('Fake console');
        expect(order.owner).toEqual({ job: JOB, lane });
        if (blocked) {
          expect(order.state).toBe('BLOCKED');
          expect(order.blocker).toBe(`lane ${lane} held until ${UNTIL}`);
          expect(order.evidenceSource).toBe('slots.json');
          expect(order.asOf).toBe(ISO);
        } else {
          expect(order.state).toBe('RECEIVED');
          expect(order.evidenceSource).toBe('receivedAt');
          expect(order.asOf).toBe('2026-11-14T09:30:00.000Z');
          expect(order.blocker).toBeNull();
        }
        expect(text).not.toContain(BODY);
        expect(text).not.toContain(PRIVATE);
        expect(text).not.toContain(parent);
        return order;
      };
      await check(A, true, 'healthy');
      await route(B);
      const reassigned = await check(B, false, 'healthy');
      expect(JSON.stringify(reassigned)).not.toContain(A);
      await slots(true);
      const heldB = await check(B, true, 'healthy');
      expect(JSON.stringify(heldB)).not.toContain(A);
      await rm(ready);
      const missing = await check(null, false, 'missing');
      expect(JSON.stringify(missing)).not.toContain(A);
      expect(JSON.stringify(missing)).not.toContain(B);
      await route(B);
      await check(B, true, 'healthy');
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
