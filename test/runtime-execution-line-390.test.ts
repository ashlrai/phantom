import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { RuntimeIdentityBody } from '../src/web-ui/routes/verse/fleet-host/RuntimeIdentityCard.js';
import { executionLine } from '../src/web-ui/routes/verse/fleet-host/runtime-execution-line.js';

const body = (execution: unknown) => ({ snapshot: { execution } });
const known = { state: 'known', running: 0, claimedNoWorker: 0, unknown: 0 };

it('hides the row when the field is absent', () => {
  expect(executionLine({ snapshot: {} })).toBeUndefined();
});
it('reports request errors', () => {
  expect(executionLine(undefined, new Error())).toEqual({ text: 'Execution unknown: snapshot unavailable', tone: 'unknown' });
});
it('reports unknown evidence with a bounded sanitized reason', () => {
  expect(executionLine(body({ ...known, state: 'UNKNOWN', reason: `${'a'.repeat(120)}!ignored` })))
    .toEqual({ text: `Execution unknown: ${'a'.repeat(120)}`, tone: 'unknown' });
  expect(executionLine(body({ ...known, state: 'UNKNOWN', reason: 'bad! <data>' }))?.text).toBe('Execution unknown: bad data');
});
it('rejects invalid counts', () => {
  for (const value of [-1, 1.5, Infinity, NaN, '1']) {
    expect(executionLine(body({ ...known, running: value }))).toEqual({ text: 'Execution unknown', tone: 'unknown' });
  }
});
it('reports zero work', () => {
  expect(executionLine(body(known))).toEqual({ text: 'No claimed work running', tone: 'ok' });
});
it('reports running and warns about missing or unknown workers', () => {
  expect(executionLine(body({ ...known, running: 2 }))).toEqual({ text: '2 running', tone: 'ok' });
  expect(executionLine(body({ ...known, running: 2, claimedNoWorker: 1, unknown: 3 })))
    .toEqual({ text: '2 running, 1 claimed with no worker, 3 unknown', tone: 'warn' });
});
it('renders the execution row after coordination', () => {
  const view = { generatedAt: 'g', host: 'h', platform: 'darwin', asOf: 'a', installedVersion: '1', sourceVersion: '1', versionDrift: false, tailnetName: 't', fleetState: { ageSeconds: 0, stale: false as const }, reasons: [] };
  const html = renderToStaticMarkup(createElement(RuntimeIdentityBody, { view, coordination: { text: 'coordination', tone: 'ok' }, execution: { text: '1 running', tone: 'warn' } }));
  expect(html).toMatch(/<dt>Coordination<\/dt>.*<dt>Execution<\/dt><dd data-tone="warn">1 running<\/dd>/);
});
