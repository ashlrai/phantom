/**
 * Keeps docs/api/fleet-openapi.json honest against the reviewed remote
 * gateway surface in src/core/web/remote-gateway-policy.ts.
 *
 *   - every path the policy reads, streams or writes is in the spec;
 *   - every spec path is in the policy or in LOCAL_ONLY below (hub-only
 *     routes the phone gateway deliberately never forwards);
 *   - every spec write carries x-phantom-step-up matching the policy's
 *     decision, and its documented bodies pass validateRemoteMutation;
 *   - every spec read classifies as read/stream on the gateway.
 *
 * The policy's route lists are module-private, so the policy paths are
 * recovered from the source text: `'/api/…'` literals plus the anchored
 * `/^\/api\/…$/` route regexes (each `([^/]+)` segment becomes a path
 * parameter, each `(a|b)` group expands). That is enough to catch drift.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  classifyRemoteRoute,
  validateRemoteMutation,
} from '../src/core/web/remote-gateway-policy.js';

interface SpecSchema {
  $ref?: string;
  oneOf?: SpecSchema[];
  properties?: Record<string, SpecSchema>;
  const?: unknown;
  enum?: unknown[];
  type?: string;
}
interface SpecRequestBody {
  $ref?: string;
  content?: Record<string, { schema?: SpecSchema }>;
}
interface SpecOperation {
  requestBody?: SpecRequestBody;
  [extension: string]: unknown;
}
interface SpecDoc {
  openapi?: string;
  paths: Record<string, Record<string, SpecOperation>>;
  components?: { schemas?: Record<string, SpecSchema>; requestBodies?: Record<string, SpecRequestBody> };
}

const ROOT = join(__dirname, '..');
const SPEC = JSON.parse(
  readFileSync(join(ROOT, 'docs/api/fleet-openapi.json'), 'utf8'),
) as SpecDoc;
const POLICY_SOURCE = readFileSync(join(ROOT, 'src/core/web/remote-gateway-policy.ts'), 'utf8');

/** Hub routes the remote gateway does not expose, one line of why each stays local. */
const LOCAL_ONLY: Record<string, string> = {
  '/api/verse/fleet': 'composite hub snapshot; the remote surface reads fleet/runs and fleet/live instead',
  '/api/verse/fleet/control': 'daemon control plane with run/task writes is a desktop surface',
  '/api/verse/fleet/control/holds': 'lane-hold release is a desktop control action',
  '/api/verse/fleet/control/queue': 'task queue + goals projection is desktop-only',
  '/api/verse/fleet/control/remote-devices': 'the pairing registry must stay on the hub',
  '/api/verse/fleet/control/runs/{}/log': 'run logs can carry sensitive text; hub-only',
  '/api/verse/fleet/history': 'day-bucketed history read is desktop-only',
  '/api/verse/fleet/live/feedback': 'execution feedback index is hub-only',
  '/api/verse/fleet/live/feedback/cases/{}': 'feedback case detail is hub-only',
  '/api/verse/runs-history': 'run outcome samples are hub-only',
  '/api/verse/runs-history/lane-truth': 'lane truth reads local slots and meter rollouts; hub-only',
  '/api/verse/leader/memos/{}': 'Leader memo reads stay on the hub',
  '/api/verse/leader/orders': 'order trace is hub-only',
};

/** Query strings that satisfy the policy's exactParams shapes for reads that require one. */
const REMOTE_QUERY_PROBES: Record<string, string> = {
  '/api/verse/activity': 'since=v1.abcd1234.t.1',
  '/api/verse/authority/ledger': 'view=decisions&limit=40',
  '/api/verse/checkpoints': 'chatId=chat01',
  '/api/verse/checkpoints/diff': 'chatId=chat01&turnId=turn01&rootId=abcdef12&mode=turn',
  '/api/events': 'topics=verse-sessions',
  '/api/verse/fleet/live/bus': 'limit=5',
  '/api/verse/fleet/live/queue': 'limit=5',
  '/api/verse/fleet/runs/inbox': 'limit=5',
  '/api/verse/leader/thread': 'limit=50',
  // The gateway only reaches this stream through the `?`-carrying branch.
  '/api/verse/sessions/{sessionId}/events': 'after=1',
};

/** Concrete path-parameter values that satisfy the policy's id regexes. */
const PATH_PARAM_PROBES: Record<string, string> = {
  actionId: 'phmact1',
  agentId: 'ag_phmtest1',
  directiveId: 'phmdir1',
  memoId: 'lm-20250101010101-abcdef',
  proposalId: 'phm-prop-1',
  questionId: 'lm-20250101010101-abcdef:1',
  queueId: 'abc123def456',
  sessionId: 'phmsess1',
};

/** Property values that satisfy validateRemoteMutation's bounds, keyed by body key. */
const BODY_KEY_PROBES: Record<string, unknown> = {
  actionId: 'phmact1',
  confirm: true,
  headSha: 'a'.repeat(40),
  itemId: 'leader:leader-question:phm1',
  lane: 'phm-lane',
  model: 'fakemodel',
  on: true,
  projectPath: '/fake/project',
  reason: 'done',
  replyTo: 'th-1',
  repo: 'ashlrai/phantom',
  seatId: 'seat-1',
  sendNow: true,
  sessionId: 'phmsess1',
  source: 'operator',
  submission: {
    schemaVersion: 1,
    formRevision: 'abcdef01-abcdef02-abcdef03-abcdef04-abcdef05-abcdef06-abcdef07-abcdef08',
    kind: 'text',
    text: 'x',
  },
  target: 1,
  text: 'please review the queue',
  to: 'propose',
  turnCount: 1,
};

/** `/api/verse/sessions/{sessionId}` → `/api/verse/sessions/{}` — the form the policy regexes produce. */
function normalize(path: string): string {
  return path.replace(/\{[^}/]+\}/g, '{}');
}

/** Expand one unescaped anchored route regex into normalized path templates. */
function expandRouteRegex(body: string): string[] {
  // `([^/]+)` and `[^/]+` contain a literal slash — mark them before splitting on '/'.
  const marked = body.replace(/\(\[\^\/\]\+\)|\[\^\/\]\+/g, '{}');
  const parts: string[][] = marked.split('/').slice(1).map((segment) => {
    if (segment === '{}') return [segment];
    const group = /^\(([^()]+)\)$/.exec(segment);
    if (group && group[1]!.includes('|')) return group[1]!.split('|');
    return [segment];
  });
  return parts.reduce<string[]>(
    (acc, choices) => acc.flatMap((prefix) => choices.map((c) => `${prefix}/${c}`)),
    [''],
  );
}

/** All route templates the gateway policy admits: exact literals + expanded path regexes. */
function policyRouteTemplates(): { exact: Set<string>; prefixes: string[]; templated: Set<string> } {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const m of POLICY_SOURCE.matchAll(/['"](\/api\/[^'"]+)['"]/g)) {
    const literal = m[1]!;
    if (literal.endsWith('/')) prefixes.push(literal);
    else exact.add(literal);
  }
  const templated = new Set<string>();
  for (const m of POLICY_SOURCE.matchAll(/\/\^(?:\\\/|\[\^\/\]|[^/\n])*\$\//g)) {
    const body = m[0].slice(1, -1).replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/');
    if (!body.includes('/api/')) continue;
    for (const path of expandRouteRegex(body)) templated.add(path);
  }
  return { exact, prefixes, templated };
}

const specPaths = Object.keys(SPEC.paths);
const specNormalized = new Map(specPaths.map((p) => [normalize(p), p]));

function probePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, (_all, name: string) => {
    if (name === 'taskId') return path.includes('/cloud/tasks/') ? 'ct_20250101T0102_abc123' : 'dv_20250101T0102_abc123';
    return PATH_PARAM_PROBES[name] ?? 'phmid1';
  });
}

function resolveSchema(schema: SpecSchema): SpecSchema {
  while (schema.$ref) {
    const name = schema.$ref.split('/').pop()!;
    schema = SPEC.components?.schemas?.[name] ?? {};
  }
  return schema;
}

function probeValue(name: string, prop: SpecSchema): unknown {
  const resolved = resolveSchema(prop);
  if (name in BODY_KEY_PROBES) return BODY_KEY_PROBES[name];
  if (resolved.const !== undefined) return resolved.const;
  if (resolved.enum !== undefined) return resolved.enum[0];
  if (resolved.type === 'boolean') return true;
  if (resolved.type === 'integer' || resolved.type === 'number') return 1;
  if (resolved.type === 'object') return {};
  return 'phmtext';
}

/** One candidate body per documented request shape (every oneOf branch). */
function candidateBodies(operation: SpecOperation): unknown[] {
  let body = operation.requestBody;
  while (body?.$ref) {
    const name = body.$ref.split('/').pop()!;
    body = SPEC.components?.requestBodies?.[name];
  }
  const schema = body?.content?.['application/json']?.schema;
  if (!schema) return [{}];
  const branches = resolveSchema(schema).oneOf ?? [schema];
  return branches.map((branch) => {
    const resolved = resolveSchema(branch);
    const out: Record<string, unknown> = {};
    for (const [key, prop] of Object.entries(resolved.properties ?? {})) out[key] = probeValue(key, prop);
    return out;
  });
}

const WRITE_METHODS = new Set(['post', 'delete']);

describe('fleet-openapi.json', () => {
  it('is a valid OpenAPI 3.1 document', () => {
    expect(SPEC.openapi?.startsWith('3.1')).toBe(true);
    expect(specPaths.length).toBeGreaterThan(0);
  });

  it('covers every path the remote gateway policy admits', () => {
    const policy = policyRouteTemplates();
    const missing: string[] = [];
    for (const path of policy.exact) if (!specNormalized.has(path)) missing.push(path);
    for (const prefix of policy.prefixes) {
      if (!specPaths.some((p) => p === prefix.slice(0, -1) || normalize(p).startsWith(prefix))) {
        missing.push(`${prefix}{id}`);
      }
    }
    for (const path of policy.templated) if (!specNormalized.has(path)) missing.push(path);
    expect(missing).toEqual([]);
  });

  it('contains only policy paths or declared hub-only routes', () => {
    const policy = policyRouteTemplates();
    const policySet = new Set([...policy.exact, ...policy.templated]);
    const stray = specPaths.filter((p) => !policySet.has(normalize(p)) && !(normalize(p) in LOCAL_ONLY));
    expect(stray).toEqual([]);
    // Every LOCAL_ONLY entry must exist in the spec and be flagged on every one of its ops.
    for (const local of Object.keys(LOCAL_ONLY)) {
      const specPath = specNormalized.get(local);
      expect(specPath, `LOCAL_ONLY path missing from spec: ${local}`).toBeDefined();
      for (const [method, op] of Object.entries(SPEC.paths[specPath!]!)) {
        expect(op['x-phantom-local-only'], `${method.toUpperCase()} ${specPath} is hub-only`).toBe(true);
      }
    }
  });

  it('lets the gateway read every remote spec GET', () => {
    const failures: string[] = [];
    for (const [path, item] of Object.entries(SPEC.paths)) {
      if (!item.get || normalize(path) in LOCAL_ONLY) continue;
      const target = probePath(path) + (REMOTE_QUERY_PROBES[path] ? `?${REMOTE_QUERY_PROBES[path]}` : '');
      const decision = classifyRemoteRoute('GET', target);
      if (decision.kind !== 'read' && decision.kind !== 'stream') failures.push(`GET ${path} → ${JSON.stringify(decision)}`);
    }
    expect(failures).toEqual([]);
  });

  it('marks step-up on writes exactly as the gateway classifies them', () => {
    const failures: string[] = [];
    for (const [path, item] of Object.entries(SPEC.paths)) {
      if (normalize(path) in LOCAL_ONLY) continue;
      for (const method of WRITE_METHODS) {
        const op = item[method];
        if (!op) continue;
        const decision = classifyRemoteRoute(method.toUpperCase(), probePath(path));
        if (decision.kind !== 'write') {
          failures.push(`${method.toUpperCase()} ${path} → ${JSON.stringify(decision)}`);
          continue;
        }
        if (Boolean(op['x-phantom-step-up']) !== decision.stepUp) {
          failures.push(`${method.toUpperCase()} ${path} step-up=${decision.stepUp} but spec says ${String(op['x-phantom-step-up'])}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('documents request bodies the gateway validator accepts', () => {
    const failures: string[] = [];
    for (const [path, item] of Object.entries(SPEC.paths)) {
      if (normalize(path) in LOCAL_ONLY) continue;
      for (const method of WRITE_METHODS) {
        const op = item[method];
        if (!op) continue;
        const decision = classifyRemoteRoute(method.toUpperCase(), probePath(path));
        if (decision.kind !== 'write') continue;
        for (const body of candidateBodies(op)) {
          if (!validateRemoteMutation(decision, body)) {
            failures.push(`${method.toUpperCase()} ${path} body ${JSON.stringify(body)}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });
});
