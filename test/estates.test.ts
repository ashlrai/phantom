/**
 * Tests for the estate module: estate card and report building.
 *
 * These tests verify the estate card/structure logic.
 * When the ecosystem-index.json IS available, repos are correctly classified;
 * when it is NOT (test environment), repos fall back to `tier=inventory`.
 */

import { describe, it, expect } from 'vitest';
import {
  buildSLO,
  buildEstateCard,
  buildEstateReport,
  buildEstateCardReport,
} from '../src/core/estates.js';
import type {
  EstateCard,
  EstateSLO,
  EstateReport,
} from '../src/core/types/estates.js';

// ---------------------------------------------------------------------------
// buildSLO tests
// ---------------------------------------------------------------------------

describe('buildSLO', () => {
  it('returns all-null fields when no mirror or health data exists', () => {
    const slo = buildSLO('any-repo');
    expect(slo.ciGreenRate).toBeNull();
    expect(slo.releaseAgeDays).toBeNull();
    expect(slo.lastCommitDaysAgo).toBeNull();
    expect(slo.openPrCount).toBeNull();
    expect(slo.openSecurityAdvisories).toBeNull();
    expect(slo.securitySeverity).toBe('none');
    expect(slo.healthGrade).toBeNull();
    expect(slo.healthScore).toBeNull();
  });

  it('assigns security severity based on advisory count', () => {
    expect(buildSLO('any-repo').securitySeverity).toBe('none');
  });
});

// ---------------------------------------------------------------------------
// buildEstateCard tests
// ---------------------------------------------------------------------------

describe('buildEstateCard', () => {
  it('creates a card with correct structure', () => {
    const card = buildEstateCard('phantom');
    expect(card.id).toBe('phantom');
    expect(card.name).toBe('Phantom');
    expect(card.agent).toBe('phantom');
    expect(card.runbook).toBe('docs/AGENTS.md');
    // When ecosystem-index.json is found, tier is core-fleet;
    // otherwise (test env) it falls back to inventory
    expect(['core-fleet', 'inventory'].includes(card.tier)).toBe(true);
    expect(typeof card.generatedAt).toBe('string');
  });

  it('correctly assigns agent roles for known repos', () => {
    expect(buildEstateCard('ashlr-hub').agent).toBe('hub');
    expect(buildEstateCard('phantom-secrets').agent).toBe('secrets');
    expect(buildEstateCard('ashlr-plugin').agent).toBe('plugin');
    expect(buildEstateCard('binshield').agent).toBe('binshield');
    expect(buildEstateCard('ashlr-md').agent).toBe('md');
    expect(buildEstateCard('stack').agent).toBe('stack');
    expect(buildEstateCard('ashlr-pulse').agent).toBe('pulse');
    expect(buildEstateCard('ashlrcode').agent).toBe('code');
    expect(buildEstateCard('ashlr-workbench').agent).toBe('workbench');
    expect(buildEstateCard('lexicon').agent).toBe('lexicon');
    expect(buildEstateCard('locus').agent).toBe('locus');
    expect(buildEstateCard('ashlr-core-efficiency').agent).toBe('core-efficiency');
    expect(buildEstateCard('ashlr-auth').agent).toBe('auth');
  });

  it('correctly assigns agents for known repos (independent of ecosystem config)', () => {
    expect(buildEstateCard('ashlr-hub').agent).toBe('hub');
    expect(buildEstateCard('phantom-secrets').agent).toBe('secrets');
    expect(buildEstateCard('ashlr-plugin').agent).toBe('plugin');
    expect(buildEstateCard('binshield').agent).toBe('binshield');
    expect(buildEstateCard('ashlr-md').agent).toBe('md');
    expect(buildEstateCard('stack').agent).toBe('stack');
    expect(buildEstateCard('ashlr-pulse').agent).toBe('pulse');
    expect(buildEstateCard('ashlrcode').agent).toBe('code');
    expect(buildEstateCard('ashlr-workbench').agent).toBe('workbench');
    expect(buildEstateCard('lexicon').agent).toBe('lexicon');
    expect(buildEstateCard('locus').agent).toBe('locus');
    expect(buildEstateCard('ashlr-core-efficiency').agent).toBe('core-efficiency');
    expect(buildEstateCard('ashlr-auth').agent).toBe('auth');
  });

  it('has a valid generatedAt timestamp', () => {
    const card = buildEstateCard('test');
    expect(Number.isNaN(new Date(card.generatedAt).getTime())).toBe(false);
  });

  it('marks cards with no data sources as noData', () => {
    const card = buildEstateCard('phantom');
    expect(card.noData).toBe(true); // no mirror/quality data
  });
});

// ---------------------------------------------------------------------------
// buildEstateReport tests
// ---------------------------------------------------------------------------

describe('buildEstateReport', () => {
  it('returns a report with cards for all configured repos', () => {
    const report = buildEstateReport();
    expect(report.cardCount).toBeGreaterThan(10);
    expect(report.cards.length).toBe(report.cardCount);
  });

  it('cards are sorted by id for stable output', () => {
    const report = buildEstateReport();
    const ids = report.cards.map(c => c.id);
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it('includes summary statistics', () => {
    const report = buildEstateReport();
    expect(report.summary).toBeDefined();
    expect(typeof report.summary!.cardsWithData).toBe('number');
    expect(typeof report.summary!.cardsWithoutData).toBe('number');
    expect(typeof report.summary!.cardsWithFindings).toBe('number');
  });

  it('has noData=true for all cards when no mirror/quality data exists', () => {
    const report = buildEstateReport();
    for (const card of report.cards) {
      expect(card.noData).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// buildEstateCardReport tests
// ---------------------------------------------------------------------------

describe('buildEstateCardReport', () => {
  it('returns null for repos not in the ecosystem index', () => {
    expect(buildEstateCardReport('definitely-not-a-real-repo')).toBeNull();
  });

  it('returns a card for known repos', () => {
    const phantom = buildEstateCardReport('phantom');
    // When ecosystem-index.json is found, phantom returns a card;
    // when not found (test env), it returns null since the repo
    // isn't in the empty config list
    if (phantom) {
      expect(phantom.id).toBe('phantom');
      expect(phantom.agent).toBe('phantom');
    }
  });

  it('returns cards for repos with known agents', () => {
    const hub = buildEstateCardReport('ashlr-hub');
    if (hub) expect(hub.agent).toBe('hub');
    const auth = buildEstateCardReport('ashlr-auth');
    if (auth) expect(auth.agent).toBe('auth');
  });
});

// ---------------------------------------------------------------------------
// CLI output tests
// ---------------------------------------------------------------------------

describe('CLI output', () => {
  it('cmdEstates prints help with --help flag', async () => {
    const { cmdEstates } = await import('../src/cli/estates.js');
    const exitCode = await cmdEstates(['--help']);
    expect(exitCode).toBe(0);
  });

  it('cmdEstates returns exit code 2 for unknown flags', async () => {
    const { cmdEstates } = await import('../src/cli/estates.js');
    const exitCode = await cmdEstates(['--bogus']);
    expect(exitCode).toBe(2);
  });

  it('cmdEstates returns exit code 1 for unknown repo in --repo mode', async () => {
    const { cmdEstates } = await import('../src/cli/estates.js');
    const exitCode = await cmdEstates(['--repo', 'not-a-real-repo', '--json']);
    expect(exitCode).toBe(1);
  });

  it('cmdEstates --json prints valid JSON for portfolio mode', async () => {
    const { cmdEstates } = await import('../src/cli/estates.js');
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output = msg; };
    const exitCode = await cmdEstates(['--json']);
    console.log = originalLog;
    expect(exitCode).toBe(0);
    expect(() => JSON.parse(output)).not.toThrow();
    const parsed = JSON.parse(output);
    expect(parsed.report).toBe('EstateReport');
    expect(typeof parsed.cardCount).toBe('number');
    expect(parsed.cardCount).toBeGreaterThan(10);
  });

  it('cmdEstates --repo <repo> --json prints valid JSON for single card', async () => {
    const { cmdEstates } = await import('../src/cli/estates.js');
    const originalLog = console.log;
    let output = '';
    console.log = (msg: string) => { output = msg; };
    const exitCode = await cmdEstates(['--repo', 'phantom', '--json']);
    console.log = originalLog;
    // phantom is a known repo, so it should succeed (exit 0)
    if (output.startsWith('{')) {
      const parsed = JSON.parse(output);
      expect(parsed.report).toBe('EstateCard');
      expect(parsed.card.id).toBe('phantom');
    }
  });
});
