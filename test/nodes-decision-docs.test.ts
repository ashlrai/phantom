import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = new URL('..', import.meta.url);
const document = readFileSync(new URL('docs/NODES.md', root), 'utf8');
const text = document.replace(/\s+/gu, ' ');
function section(heading: string): string {
  const start = text.indexOf(`## ${heading} `);
  expect(start, `missing section: ${heading}`).toBeGreaterThanOrEqual(0);
  const end = text.indexOf(' ## ', start + 3);
  return text.slice(start, end < 0 ? undefined : end);
}

describe('drive node decision boundaries', () => {
  it('identifies the Mac as the only local hardware and the box as shared vendor hosting', () => {
    expect(text).toContain('The Mac is the only local hardware.');
    expect(text).toMatch(/hosted, vendor-operated Linux machine shared by all of Mason's Grok Bot agents/u);
    expect(text).not.toMatch(/owned hardware|second local node|doubles local|existing LAN\b|only new costs are electricity/iu);
    const box = section('Option A: the Grok Bot box as a headless node');
    expect(box).toMatch(/CLI sessions signed in there are usable by every agent on the box/u);
    expect(box).toMatch(/does not isolate one agent from another or remove vendor access/u);
    expect(box).toContain('Never copy auth directories from the Mac.');
  });

  it('preserves heavy-build routing and treats shared capacity as unverified', () => {
    const box = section('Option A: the Grok Bot box as a headless node');
    expect(box).toMatch(/Current engineer rules keep heavy builds and full suites on the Mac pools/u);
    expect(box).toMatch(/Mason must explicitly approve any later routing change/u);
    expect(box).toMatch(/Remaining allowance, CPU, RAM and concurrent usage by other agents are unverified/u);
    expect(box).toMatch(/Dispatch and result delivery cross a remote network boundary/u);
  });

  it('makes reuse conditional without authorizing spending or claiming physical custody', () => {
    const recommendation = section('Recommendation');
    expect(recommendation).toMatch(/hosted shared credential boundary and plan coverage must first be accepted by Mason/u);
    expect(recommendation).toMatch(/no owned-hardware security advantage over option D/u);
    expect(recommendation).toContain('Defer option D.');
    expect(recommendation).toMatch(/No new spending, on-demand billing, tokens or paid resources are authorized/u);
    expect(recommendation).toContain('do not purchase replacement capacity');
  });

  it('requires Mac claim custody, authenticated remote transport and a safe pilot', () => {
    const steps = section('What Mason must do');
    expect(steps).toMatch(/on-demand billing disabled/u);
    expect(steps).toMatch(/Never copy `~\/.codex`, `~\/.claude` or any other auth directory/u);
    expect(steps).toMatch(/authenticated channel to the Mac's bridge using existing authorized access/u);
    expect(steps).toMatch(/create no new tokens/u);
    expect(steps).toMatch(/Mac remains the sole `queue.v1` claim and custody authority/u);
    expect(steps).toMatch(/Do not share `~\/.ashlr-runs\/queue\/` over a network filesystem/u);
    expect(steps).toMatch(/PAUSE prevents launches and KILL stops an active synthetic worker/u);
    expect(steps).toMatch(/dispatchd must share the Mac's atomic claim authority; otherwise stop or isolate dispatchd from pilot jobs/u);
    expect(steps).toContain('synthetic queue state');
    expect(text).toContain('**The Mac keeps queue and publish custody.**');
    expect(text).not.toMatch(/own bridge executable and queue pair|store migrates to the VM/u);
  });

  it('keeps the requested plain punctuation', () => {
    expect(document).not.toContain(String.fromCodePoint(0x2014));
  });

  it('validates the decision guide links, including its billing evidence', () => {
    expect(checkDocumentation({ root: fileURLToPath(root), entrypoints: ['docs/NODES.md'] }))
      .toMatchObject({ ok: true, errors: [], externalRequests: 0 });
  });
});
