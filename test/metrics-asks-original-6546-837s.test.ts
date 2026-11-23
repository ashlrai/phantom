import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MASON_ASKS } from '../src/core/fleet/mason-asks.js';
import { checkMasonAsks, readSourceIndex, renderMasonAsksMarkdown } from '../src/core/fleet/mason-asks-check.js';

const root = resolve('.');
const pane = 'src/web-ui/routes/verse/fleet-metrics/MetricsPane.tsx';
const series = 'src/core/fleet/metrics-series.ts';
const ask = MASON_ASKS.find(item => item.id === 'A3')!;

describe('original metrics A3 reconciliation', () => {
  it('credits the actual graphs and series while preserving the two measurement gaps', () => {
    const index = readSourceIndex(root, MASON_ASKS);
    expect(index).not.toBeNull();
    const status = checkMasonAsks(MASON_ASKS, index).asks.find(item => item.id === 'A3')!;
    expect(status.state).toBe('partial');
    expect(status.evidence).toContain(pane);
    expect(status.evidence).toContain(series);
    expect(status.gaps).toEqual(['a graph of high-leverage PRs merged over time', 'a graph of autonomy over time']);
    expect(ask.pieces).toEqual(expect.arrayContaining([
      expect.objectContaining({ need: 'merged PRs per hour by repo', path: pane, exportName: 'MetricsPane' }),
      expect.objectContaining({ need: 'merged PRs per launch by hour (not autonomy)', path: pane, exportName: 'MetricsPane' }),
      expect.objectContaining({ path: series, exportName: 'readMetricsSeries' }),
    ]));
    const source = readFileSync(resolve(root, pane), 'utf8');
    expect(source).toContain('title="Merged PRs per hour"');
    expect(source).toContain('title="Merged PRs per launch"');
    expect(source).toContain('Human actions are not recorded, so this does not measure autonomy.');
  });

  it('does not infer autonomy from pane and series exports alone', () => {
    const index = { paths: [pane, series], exports: { [pane]: ['MetricsPane'], [series]: ['readMetricsSeries'] } };
    const status = checkMasonAsks([ask], index).asks[0]!;
    expect(status.state).toBe('partial');
    expect(status.gaps).toContain('a graph of autonomy over time');
    expect(status.gaps).toContain('a graph of high-leverage PRs merged over time');
  });

  it('keeps the checked-in status identical to the real renderer', () => {
    const report = checkMasonAsks(MASON_ASKS, readSourceIndex(root, MASON_ASKS));
    expect(readFileSync(resolve(root, 'docs/MASON-ASKS-STATUS.md'), 'utf8')).toBe(renderMasonAsksMarkdown(report, MASON_ASKS));
  });
});
