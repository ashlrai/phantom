import { describe, expect, it } from 'vitest';
import { buildMemoryBenchmark, memoryBenchmarkSpans, memoryReportLine, parseMemoryJobs } from '../src/core/observability/memory-benchmark.js';
import { buildGenAiTrace } from '../src/core/observability/otlp.js';

const sample = (rssBytes: number, memguard: 'RUN' | 'PAUSE' = 'RUN') => ({ rssBytes, memguard });
const pr = { repo: 'ashlrai/phantom', number: 42 };

describe('memory efficiency benchmark', () => {
  it('records job peaks, PAUSE episodes and distinct confirmed merges', () => {
    const report = buildMemoryBenchmark([
      { jobId: 'retry-1', samples: [sample(10), sample(30, 'PAUSE'), sample(20, 'PAUSE'), sample(15), sample(25, 'PAUSE')], mergedPr: pr },
      { jobId: 'retry-2', samples: [sample(50, 'PAUSE')], mergedPr: { ...pr, repo: 'AshlrAI/Phantom' } },
      { jobId: 'failed-job', samples: [sample(40)] },
    ]);
    expect(report.jobs.map(j => [j.peakRssBytes, j.pauseEvents])).toEqual([[30, 2], [50, 1], [40, 0]]);
    expect(report.mergedPrs).toEqual([{ ...pr, peakRssBytes: 50, sampleCount: 6, pauseEvents: 3, jobs: 2 }]);
    expect(report.peakBytesPerMergedPr).toBe(120);
    expect(memoryReportLine(report)).toContain('memguard PAUSE 3');
  });
  it('distinguishes no samples, measured zero and no merged PR denominator', () => {
    expect(buildMemoryBenchmark([]).peakBytesPerMergedPr).toBeNull();
    const report = buildMemoryBenchmark([{ jobId: 'missing', samples: [], mergedPr: pr }, { jobId: 'zero', samples: [sample(0)] }]);
    expect(report.jobs.map(j => j.peakRssBytes)).toEqual([null, 0]);
    expect(report.peakBytesPerMergedPr).toBeNull();
    expect(report.mergedPrs[0].peakRssBytes).toBeNull();
    expect(memoryReportLine(buildMemoryBenchmark([]))).toContain('peak RSS unknown');
  });
  it.each([-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1, '100'])('rejects invalid RSS %s', rssBytes => {
    expect(() => buildMemoryBenchmark([{ jobId: 'a', samples: [{ rssBytes, memguard: 'RUN' }] }])).toThrow();
  });
  it('rejects duplicates, malformed states, unsafe aggregates and oversized collections', () => {
    const job = { jobId: 'a', samples: [sample(1)] };
    for (const value of [null, [job, job], [{ ...job, jobId: '/private/path' }], [{ ...job, samples: [{ rssBytes: 1, memguard: 'STOP' }] }], [{ ...job, mergedPr: { ...pr, number: 0 } }], Array(10001).fill(job), [{ ...job, samples: Array(100001).fill(sample(1)) }], [{ ...job, samples: [sample(Number.MAX_SAFE_INTEGER)] }, { jobId: 'b', samples: [sample(1)] }]]) {
      expect(() => buildMemoryBenchmark(value)).toThrow();
    }
  });
  it('counts separate repositories separately and does not sum sequential job peaks as PR RSS', () => {
    const report = buildMemoryBenchmark([
      { jobId: 'a', samples: [sample(100)], mergedPr: pr },
      { jobId: 'b', samples: [sample(200)], mergedPr: { ...pr, repo: 'ashlrai/locus' } },
    ]);
    expect(report.mergedPrs).toHaveLength(2);
    expect(report.peakBytesPerMergedPr).toBe(150);
  });
  it('exports allowlisted numeric metadata through the existing OTLP path', () => {
    const input = [{ jobId: 'a', samples: [{ ...sample(1024, 'PAUSE'), secret: 'PRIVATE_CONTENT' }], mergedPr: pr, prompt: 'PRIVATE_CONTENT' }];
    expect(JSON.stringify(parseMemoryJobs(input))).not.toContain('PRIVATE_CONTENT');
    const spans = memoryBenchmarkSpans(buildMemoryBenchmark(input), '2026-10-26T12:00:00Z');
    const wire = buildGenAiTrace(spans);
    expect(wire.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
    expect(wire.resourceSpans[0].scopeSpans[0].spans[0].attributes).toEqual(expect.arrayContaining([
      { key: 'phantom.memory.peak_rss_bytes', value: { intValue: '1024' } },
      { key: 'phantom.memguard.pause_events', value: { intValue: '1' } },
      { key: 'phantom.memory.scope', value: { stringValue: 'job' } },
    ]));
    expect(JSON.stringify(wire)).not.toContain('PRIVATE_CONTENT');
    const missing = buildGenAiTrace(memoryBenchmarkSpans(buildMemoryBenchmark([{ jobId: 'a', samples: [] }]), '2026-10-26T12:00:00Z'));
    expect(JSON.stringify(missing)).not.toContain('peak_rss_bytes');
  });
});
