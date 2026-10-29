import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboard = JSON.parse(readFileSync(
  new URL('../docs/observability/cycle-dashboard.json', import.meta.url), 'utf8',
));
const datasource = { type: 'prometheus', uid: '${DS_PROMETHEUS}' };

// Structural schema assertions deliberately avoid an undeclared schema-validator
// dependency. Semantic checks below pin the queries as well as the import shape.
describe('cycle dashboard schema and metric contract', () => {
  it('is a portable Grafana import with a selectable Prometheus datasource', () => {
    expect(dashboard).toMatchObject({
      id: null, uid: 'phantom-cycle', schemaVersion: 39, version: 1,
      title: expect.any(String), timezone: 'utc', refresh: '1m',
      time: { from: 'now-7d', to: 'now' },
      __inputs: [{ name: 'DS_PROMETHEUS', type: 'datasource', pluginId: 'prometheus' }],
      annotations: { list: [] },
    });
    expect(dashboard.panels).toHaveLength(4);
  });

  it('offers consistent repository and pool filters without embedding deployment identities', () => {
    expect(dashboard.templating.list).toHaveLength(2);
    for (const [index, name] of ['repo', 'pool'].entries()) {
      expect(dashboard.templating.list[index]).toMatchObject({
        name, type: 'query', datasource, multi: true, includeAll: true,
        allValue: '.*', refresh: 2,
        query: `label_values(phantom_cycle_stage_duration_seconds_bucket, ${name})`,
        current: { text: 'All', value: '$__all' },
      });
    }
  });

  const contracts = [
    { title: 'Stage duration · p50', metric: 'stage_duration', stage: true, quantiles: [0.5] },
    { title: 'Stage duration · p90', metric: 'stage_duration', stage: true, quantiles: [0.9] },
    { title: 'Queue wait', metric: 'queue_wait', stage: false, quantiles: [0.5, 0.9] },
    { title: 'CI execution time', metric: 'ci_duration', stage: false, quantiles: [0.5, 0.9] },
  ];

  it.each(contracts)('$title preserves seconds, histogram labels and missing data', (contract) => {
    const index = contracts.indexOf(contract);
    const panel = dashboard.panels[index];
    expect(panel).toMatchObject({
      id: index + 1, title: contract.title, type: 'timeseries', datasource,
      gridPos: { h: 9, w: 12, x: (index % 2) * 12, y: Math.floor(index / 2) * 9 },
      fieldConfig: {
        defaults: { unit: 's', min: 0, noValue: 'No observations', custom: { spanNulls: false } },
        overrides: [],
      },
    });
    expect(panel.targets).toHaveLength(contract.quantiles.length);
    for (const [targetIndex, quantile] of contract.quantiles.entries()) {
      expect(panel.targets[targetIndex]).toEqual({
        refId: String.fromCharCode(65 + targetIndex), datasource, editorMode: 'code', range: true,
        expr: `histogram_quantile(${quantile}, sum by (le${contract.stage ? ', stage' : ''}) (rate(phantom_cycle_${contract.metric}_seconds_bucket{repo=~"$repo", pool=~"$pool"}[$__rate_interval])))`,
        legendFormat: `${contract.stage ? '{{stage}} · ' : ''}${quantile === 0.5 ? 'p50' : 'p90'}`,
      });
    }
    // No transformations that could replace unknowns with zeros or average tails.
    expect(panel.transformations ?? []).toEqual([]);
  });
});
