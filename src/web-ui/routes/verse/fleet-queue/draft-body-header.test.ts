import { expect, it } from 'vitest';
import { composeDropJobFile } from '../../../../core/fleet/drop-job-writer.js';
import { orderJobDraft } from '../fleet-inbox/order-job-draft.js';
import type { MainHealthRepo } from '../shell/main-health-query.js';
import { validateDraft } from './drop-job-model.js';
import { mainRedFixDraft } from './main-red-fix-draft.js';

const repo: MainHealthRepo = {
  repo: 'phantom', branch: 'master', sha: 'abc1234', state: 'red',
  checkedAt: '2026-11-02T12:00:00Z', failingCheck: 'build', fixJobs: [], nightlyRed: null,
};
const order = { at: '2026-11-01 00:08', source: 'fake desktop', text: 'Serve fake feature' };

it.each([
  ['order', orderJobDraft(order, 0)!],
  ['main fix', mainRedFixDraft(repo, 0)!],
])('%s leaves the single routing header to the writer', (_name, draft) => {
  expect(draft.body).toMatch(/^Goal:/);
  expect(draft.body.split('\n').filter(line => line.startsWith('#job'))).toEqual([]);
  for (const [lane, tier] of [['devin', 'work'], ['claude', 'frontier']]) {
    const file = composeDropJobFile({ ...draft, lane: lane!, tier: tier! });
    expect(file.split('\n').filter(line => line.startsWith('#job')))
      .toEqual([`#job repo=phantom lane=${lane} tier=${tier}`]);
    expect(file).toContain(`\n\n${draft.body}`);
  }
});

it.each(['phantom', 'ashlrai/phantom', 'PHANTOM', 'AshlrAI/Phantom'])('accepts Phantom repo %s', name => {
  expect(mainRedFixDraft({ ...repo, repo: name }, 0)).not.toBeNull();
});
it.each(['stack', 'other/phantom', 'phantom-extra'])('refuses unsupported repo %s', name => {
  expect(mainRedFixDraft({ ...repo, repo: name }, 0)).toBeNull();
});

it.each(['', '\n  \n'])('rejects a restored body header after blank prefix %j', prefix => {
  const draft = { id: 'FAKE123', lane: 'devin', tier: 'work', body: 'Goal: Serve fake feature.' };
  expect(validateDraft({ ...draft, body: `${prefix}#job repo=phantom lane=devin tier=work\n\n${draft.body}` }))
    .toEqual({ ok: false, reasons: ['Body must not repeat the #job header; the writer adds it.'] });
  expect(validateDraft({ ...draft, body: `${prefix}${draft.body}` })).toMatchObject({ ok: true });
});
