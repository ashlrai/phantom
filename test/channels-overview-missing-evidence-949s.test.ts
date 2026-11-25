import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildChannelsOverview, createDefaultChannelsReader } from '../src/core/fleet/channels-overview.js';
import type { ChannelSource, InboundEvidence } from '../src/core/fleet/channel-health.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('channels overview inbound evidence', () => {
  for (const mode of ['normal', 'unconfigured', 'stopped'] as const) {
    for (const store of ['missing', 'unreadable', 'ok'] as const) {
      it(`${mode}: preserves ${store} evidence for both relays`, async () => {
        const root = mkdtempSync(join(tmpdir(), 'channels-evidence-'));
        roots.push(root);
        const source = () => {
          const inboundEvidence = vi.fn((): InboundEvidence => ({ store, rows: [] }));
          const inbound = vi.fn(() => []);
          const replies = vi.fn(() => []);
          const value: ChannelSource = {
            configMissing: () => mode === 'unconfigured' ? ['config missing'] : [],
            processAlive: () => mode !== 'stopped',
            inbound, inboundEvidence, replies,
          };
          return { value, inboundEvidence, inbound, replies };
        };
        const slack = source();
        const imessage = source();
        const read = createDefaultChannelsReader({
          cfg: {} as never, homeDir: root, runsDir: join(root, 'runs'), env: {},
          now: () => new Date('2026-11-17T18:00:00Z'), mobileDevices: () => 0,
          sources: { slack: slack.value, imessage: imessage.value },
        });
        const view = buildChannelsOverview(await read());
        for (const [name, src] of [['slack', slack], ['imessage', imessage]] as const) {
          expect(src.inboundEvidence).toHaveBeenCalledTimes(1);
          expect(src.inbound).not.toHaveBeenCalled();
          expect(src.replies).toHaveBeenCalledTimes(1);
          expect(view.channels.find((row) => row.channel === name)).toMatchObject({
            messages24h: store === 'ok' ? 0 : 'unknown',
            lastInboundAt: store === 'ok' ? null : 'unknown',
            lastOutboundAt: null,
            state: mode === 'unconfigured' ? 'not-set-up' : mode === 'stopped' ? 'failing' : store === 'ok' ? 'connected' : 'unknown',
          });
        }
        expect(view.channels.find((row) => row.channel === 'cli')).toMatchObject({ state: 'connected', verifiedSenders: null });
        expect(view.channels.find((row) => row.channel === 'mobile')).toMatchObject({ state: 'not-set-up', verifiedSenders: 0 });
      });
    }
  }
});
