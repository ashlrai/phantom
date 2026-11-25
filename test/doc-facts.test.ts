/**
 * Doc facts: the commands, verbs and flags that agent-facing docs show in
 * inline code must exist in the CLI.
 *
 * Every `phm …` / `ashlr …` code span, and every fenced line that starts with
 * the CLI, in the listed docs and website pages is checked against
 * the sources of truth: the top-level command must be in TOP_LEVEL_COMMANDS
 * (itself pinned to the dispatch switch by cli-registry-drift.test.ts), a
 * literal second word must be one of the verbs shell completion offers for
 * that command (when completion lists any), and every `--flag` must appear
 * in src/. A stale doc fails here with the file and line to fix.
 * No network, no subprocesses.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { TOP_LEVEL_COMMANDS, cmdCompletions } from '../src/cli/completions.js';

const ROOT = join(__dirname, '..');

/** Entry points and agent-facing docs held to the current CLI. */
const DOCS = [
  'README.md',
  'docs/ECOSYSTEM-MAP.md',
  'AGENTS.md',
  'CLAUDE.md',
  'CONTRIBUTING.md',
  'docs/AGENT-OPERATIONS.md',
  'docs/AGENT-MCP-CLI.md',
  'docs/CLI-AGENT-READINESS.md',
  'docs/HUB-REFERENCE.md',
  'docs/MISSION-OS.md',
  'docs/README.md',
  'docs/SELF-HOSTING.md',
  // Guides the start-here sections of README.md and docs/README.md send
  // agents to next.
  'docs/QUICKSTART.md',
  'docs/add-a-computer.md',
  'docs/AGENT-NETWORK.md',
  'docs/AGENT-TOOLCHAIN.md',
  'docs/COMPANIONS.md',
  'docs/ECOSYSTEM-ONBOARDING.md',
  'docs/AUTOMATIC-OUTCOMES.md',
  'docs/AUTONOMY-SETUP.md',
  'docs/SUBAGENTS.md',
  // The first-pull-request guide README.md and AGENTS.md send contributors to.
  'docs/CONTRIBUTE-WITH-AN-AGENT.md',
  // Community and policy pages the contributor path links to: where to get
  // help and report bugs, how to report vulnerabilities, and the authority
  // agents work under, plus the FAQ and glossary newcomers read first.
  'SUPPORT.md',
  'SECURITY.md',
  'docs/FAQ.md',
  'docs/GLOSSARY.md',
  'CONSTITUTION.md',
  'docs/STANDING-AUTHORITY.md',
  'docs/AGENTS-MD-AUDIT.md',
  // Pages CONTRIBUTING.md, the contributor guide, AGENT-OPERATIONS.md and
  // AGENT-TOOLCHAIN.md link a contributor to next. Linked pages still missing:
  // CLI-REFERENCE is generated from src/cli/help.ts and names `fleet verbs`,
  // whose --help exits 2; RESIDENT-RUNTIME names deleted commands on purpose;
  // desktop/README.md documents its own package.json scripts.
  'docs/ARCHITECTURE.md',
  'docs/BUN-SHARDS.md',
  'docs/CLOUD.md',
  'docs/DELETION-SWEEP.md',
  'docs/DEPENDENCY-SECURITY.md',
  'docs/DEVIN.md',
  'docs/FOUNDRY-CONFIG.md',
  'docs/LOCAL-FLEET.md',
  'docs/OWNER-ASSIST.md',
  'docs/RELIABILITY.md',
  'docs/RESOURCE-POOLS.md',
  'docs/contracts/CONTRACT-SELECTOR.md',
  'docs/verify-changed.md',
  // Operating guides AGENTS.md and README.md link to. Linked guides that are
  // missing here name a verb completions SUBCOMMANDS does not offer: QUEUE
  // (`queue yield`, whose --help exits 2, and a `phm foo bar` example),
  // AGENT-BUS (`agents mesh status`, whose --help exits 2) and FLEET-API
  // (`fleet merge-recover`, whose -h exits 2).
  'docs/AGENT-APPS.md',
  'docs/AGENT-NETWORK-CHANNELS.md',
  'docs/AGENT-PROFILES.md',
  'docs/APP-DRIVE.md',
  'docs/APP-RESTART.md',
  'docs/BOT-SEATS.md',
  'docs/CI-BASELINE.md',
  'docs/COMMS-AGENT.md',
  'docs/CONNECTORS.md',
  'docs/DESKTOP-OPERATOR.md',
  'docs/DESKTOPCTL.md',
  'docs/DRAFTS.md',
  'docs/EVAL-PASSK.md',
  'docs/FLEET-LANE-FRESHNESS.md',
  'docs/LANE-HEALTH.md',
  'docs/MEMORY.md',
  'docs/NODES.md',
  'docs/NODE-ROUTER.md',
  'docs/PAGES.md',
  'docs/RADAR.md',
  'docs/REPO-RANK.md',
  'docs/RESEARCH-LOOP.md',
  'docs/ROUTE-HYSTERESIS.md',
  'docs/ROUTER-CATALOG.md',
  'docs/ROUTER-GATEWAY.md',
  'docs/SKILLS.md',
  'docs/TEAM.md',
  'docs/lanes.md',
  'docs/strategy/spawn-fleet-model.md',
  // Operating guides and runbooks the docs index (docs/README.md) and
  // docs/llms.txt route agents to. Dated audits, specs, roadmaps, versioned
  // contracts and the generated CLI pages (cli.md, CODEMAP.md) stay out: they
  // record a point in time or are rebuilt by docs-sync from src/cli/help.ts.
  'docs/AGENT-NATIVE-QUICKSTART.md',
  'docs/AMPLIFY.md',
  'docs/APP-STEER.md',
  'docs/ASHLR-UNIVERSE.md',
  'docs/AUTOFIX.md',
  'docs/BOTS.md',
  'docs/BRIDGE-WORKTREES.md',
  'docs/BUS-THREADS.md',
  'docs/CAPABILITY-REGISTRY.md',
  'docs/CLOUD-LANES.md',
  'docs/COMPANY-CONTEXT.md',
  'docs/CROSS-REVIEW.md',
  'docs/DONE-CONTRACT.md',
  'docs/DRIVE.md',
  'docs/DRIVER.md',
  'docs/FLEET-MERGE-BATCH.md',
  'docs/FLEET-USAGE-PACING.md',
  'docs/GROUP-CHAT.md',
  'docs/GROWTH.md',
  'docs/IDEATION.md',
  'docs/IMPACT-METRICS.md',
  'docs/JEV-INTEGRATION.md',
  'docs/JOB-COST.md',
  'docs/LOCAL-CONTEXT-STRATEGY.md',
  'docs/LOCUS-FIRM-FLEET.md',
  'docs/METRICS-ROUTER-FEED.md',
  'docs/MILESTONE-CONTRACT.md',
  'docs/OMLX-SMALL-MACS.md',
  'docs/OPENAI-AGENTS-INTEGRATION.md',
  'docs/PERSONAL-METER-PROVENANCE.md',
  'docs/PHANTOM-BRAND.md',
  'docs/PLUGINS.md',
  'docs/PR-CONFLICT-RESOLVER.md',
  'docs/PROVIDER-CARDS.md',
  'docs/PULSE-BRIDGE.md',
  'docs/REMOTE-PHONE.md',
  'docs/ROUTINES.md',
  'docs/SEAMS.md',
  'docs/SECRETS-FOR-ENROLLED-REPOS.md',
  'docs/SELF-SWAP.md',
  'docs/STIGMERGY.md',
  'docs/USAGE-SIGNALS.md',
  'docs/VERSE-CONTEXT.md',
  'docs/WORKER.md',
  'docs/WORKTREE-PRUNE.md',
  'docs/WORLD.md',
  // Fleet operating guides, held out until completion offered the fleet verbs
  // they document. COS.md and IMESSAGE.md wait on `fleet cos` and
  // `fleet imessage-acks`, whose --help does not yet pass
  // test/cli-help-no-side-effects.
  'docs/BRIEF-SEND.md',
  'docs/DISK-MAINT.md',
  'docs/FLEET-EMPTIES.md',
  'docs/FLEET-PROFILE.md',
  'docs/FLEET-MERGE-LATENCY.md',
  'docs/FLEET-MERGE-PLAN.md',
  'docs/FLEET-REBASE-PLAN.md',
  'docs/FLEET-REBASE-STATUS.md',
  'docs/GROK-ULTRA-RUNWAY.md',
  'docs/MACHINERY-MIGRATION.md',
  'docs/REBASE-ORDERING.md',
  'docs/RESOURCE-EVIDENCE.md',
  'docs/VERSE.md',
  'docs/fleet-health.md',
  'docs/fleet/pr-hygiene.md',
  // Guides held out until completion offered the job, leader, node, notify,
  // release, inbox, apps, mcp, daemon and authority verbs they document.
  'docs/APPS-CONTROL.md',
  'docs/AUTHORITY.md',
  'docs/CHANNELS.md',
  'docs/CONSOLE-LAYOUT.md',
  'docs/FLEET-COORDINATION.md',
  'docs/FLEET-MCP-ONRAMP.md',
  'docs/LEADER.md',
  'docs/OWNER-THREAD.md',
  'docs/RELEASE-AUTONOMY.md',
  'docs/RELEASING.md',
  'docs/ROUTING.md',
  'docs/RUN-THE-FLEET.md',
  'docs/SESSIONS.md',
  'docs/daemon-tick-phases.md',
  // The hand-written source of docs/llms.txt, the agent map the docs index
  // links to. The generated docs/llms.txt adds every doc's first line, so the
  // source is checked instead.
  'docs/llms-source.txt',
  // The website's maintainer notes (regeneration commands for its pages).
  'site/README.md',
];

/**
 * Hand-written website pages, held to the same rules: each `<code>` element is
 * an inline span and each `<pre>` block a fence. site/shipped.html is left
 * out because `phm shipped --site` renders it from merged pull request titles.
 */
const SITE_PAGES = [
  'site/index.html',
  'site/connect.html',
  'site/ecosystem.html',
  'site/compare/agent-clis.html',
  'site/use-cases/local-models.html',
  'site/use-cases/own-accounts.html',
  'site/use-cases/review-agent-work.html',
  'site/use-cases/signed-autonomy.html',
];

const PRE_LINE = '\u0001';

/** A doc's text; HTML is reduced to markdown-style code spans and marked <pre> lines. */
function docText(file: string): string {
  const raw = readFileSync(join(ROOT, file), 'utf8');
  if (!file.endsWith('.html')) return raw;
  return raw
    // Blank out scripts and styles but keep their newlines, so reported line
    // numbers match the page; the same holds for every replacement below.
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, (block) => block.replace(/[^\n]/g, ''))
    // Each <pre> line gets a PRE_LINE mark (line numbers stay true) and loses
    // its inline tags so it reads as plain shell.
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body: string) =>
      body.split('\n').map((l) => PRE_LINE + l.replace(/<[^>]+>/g, '')).join('\n'))
    .replace(/<\/?code\b[^>]*>/gi, '`')
    .replace(/<[^>]+>/g, (tag) => (tag.includes('\n') ? tag.replace(/[^\n]/g, '') : ' '))
    .replace(/&hellip;/g, '…')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Every `--flag` spelled anywhere in src/ (code, help text, comments). */
function sourceFlags(): Set<string> {
  const flags = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) {
        for (const m of readFileSync(path, 'utf8').matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
      }
    }
  };
  walk(join(ROOT, 'src'));
  return flags;
}

/** Second-word verbs bash completion offers per command. */
async function completionVerbs(): Promise<Map<string, Set<string>>> {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    expect(await cmdCompletions(['bash'])).toBe(0);
  } finally {
    write.mockRestore();
  }
  const verbs = new Map<string, Set<string>>();
  for (const m of chunks.join('').matchAll(/^\s+([\w-]+)\) COMPREPLY=\( \$\(compgen -W "([^"]*)"/gm)) {
    verbs.set(m[1]!, new Set(m[2]!.split(' ').filter((v) => !v.startsWith('-'))));
  }
  return verbs;
}

interface Invocation {
  file: string;
  line: number;
  span: string;
  command: string;
  verbs: string[];
  flags: string[];
}

/** `phm`/`ashlr` invocations in a doc's inline code spans. */
function invocations(file: string): Invocation[] {
  const out: Invocation[] = [];
  const lines = docText(file).split('\n');
  let fenced = false;
  lines.forEach((text, i) => {
    if (/^\s*(```|~~~)/.test(text)) {
      fenced = !fenced;
      return;
    }
    // Inside a fence or an HTML <pre>, a line that starts with the CLI is one
    // invocation (a trailing `# comment` dropped); outside, every inline code
    // span is.
    const pre = text.lastIndexOf(PRE_LINE);
    const spans = fenced || pre >= 0
      ? [text.slice(pre + 1).replace(/\s+#.*$/, '').trim()]
      : // Table cells escape `|` as `\|`; inside code it still means "or".
        [...text.replace(/\\\|/g, '|').matchAll(/`([^`]+)`/g)].map((m) => m[1]!.trim());
    for (const span of spans) {
      const head = /^(?:phm|ashlr)\s+([a-z][\w-]*)(.*)$/.exec(span);
      if (!head) continue;
      const [, command, tail] = head as unknown as [string, string, string];
      // A literal second word (or an a|b / a/b list of them) right after the
      // command; placeholders, quotes and flags stop it.
      const second = /^\s+([a-z][\w-]*(?:[|/][a-z][\w-]*)*)(?=\s|$|\])/.exec(tail);
      out.push({
        file,
        line: i + 1,
        span,
        command,
        verbs: second ? second[1]!.split(/[|/]/) : [],
        flags: [...tail.matchAll(/--[a-z][a-z0-9-]*/g)].map((f) => f[0]),
      });
    }
  });
  return out;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('agent docs name only real CLI commands, verbs and flags', () => {
  const all = [...DOCS, ...SITE_PAGES].flatMap(invocations);

  it('keeps companion server lists aligned with repo configuration', () => {
    // Read names only: never include server environment or credential values in diagnostics.
    const config = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8')) as { mcpServers: Record<string, unknown> };
    const expected = Object.keys(config.mcpServers).sort();
    for (const file of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'docs/ECOSYSTEM-MAP.md']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      const paragraph = text.split(/\n\s*\n/).find((p) => p.includes('`.mcp.json`') && p.includes('`phantom-secrets`'));
      expect(paragraph, `${file}: missing companion server list`).toBeDefined();
      const names = [...(paragraph ?? '').matchAll(/`([a-z][a-z0-9-]*)`/g)]
        .map((m) => m[1]!).sort();
      expect(names, `${file}: companion server list differs from .mcp.json`).toEqual(expected);
    }
  });

  it('keeps documented npm scripts aligned with package.json', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
    const bad: string[] = [];
    for (const file of DOCS) {
      const lines = readFileSync(join(ROOT, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        for (const match of line.matchAll(/\bnpm run ([a-z][a-zA-Z0-9:-]*)/g)) {
          if (!Object.hasOwn(pkg.scripts, match[1]!)) bad.push(`${file}:${i + 1}: npm run ${match[1]}`);
        }
      });
    }
    expect(bad, 'unknown npm script; fix the documented command').toEqual([]);
  });

  it('finds invocations to check', () => {
    expect(all.length).toBeGreaterThan(50);
  });

  it('every documented command is dispatched', () => {
    const known = new Set(TOP_LEVEL_COMMANDS);
    const bad = all.filter((inv) => !known.has(inv.command)).map((inv) => `${inv.file}:${inv.line}: \`${inv.span}\``);
    expect(bad, 'unknown top-level command; fix the doc line or the CLI').toEqual([]);
  });

  it('every documented verb is one the command offers', async () => {
    const verbs = await completionVerbs();
    const bad: string[] = [];
    for (const inv of all) {
      const offered = verbs.get(inv.command);
      if (!offered || offered.size === 0) continue;
      for (const v of inv.verbs) {
        if (!offered.has(v)) bad.push(`${inv.file}:${inv.line}: \`${inv.span}\` (${inv.command} has no "${v}")`);
      }
    }
    expect(bad, 'unknown verb; fix the doc line, or add the verb to completions SUBCOMMANDS').toEqual([]);
  });

  it('every documented flag exists in src/', () => {
    const flags = sourceFlags();
    const bad = all.flatMap((inv) =>
      inv.flags.filter((f) => !flags.has(f)).map((f) => `${inv.file}:${inv.line}: \`${inv.span}\` (${f})`),
    );
    expect(bad, 'flag not found anywhere in src/; fix the doc line').toEqual([]);
    // Scans every source file synchronously; under a loaded shard the default 5s budget is too tight.
  }, 60_000);
});
