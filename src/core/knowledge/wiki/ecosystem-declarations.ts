import { parse } from 'smol-toml';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { nameWithOwnerFromRemote } from '../../fleet/repo-identity.js';

export type Anchor = { commit: string; file: string; line: number };
export type Declaration = {
  kind: 'cargo-dependency' | 'python-dependency' | 'git-submodule' | 'github-action' | 'brew-formula';
  target: string;
  anchor: Anchor;
};

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const named = (value: unknown) => typeof value === 'string' && /^[a-z0-9][a-z0-9_.-]*$/i.test(value) ? value : null;
const cargo = (name: string) => 'cargo:' + name.toLowerCase();
const python = (name: string) => 'python:' + name.toLowerCase().replace(/[-_.]+/g, '-');
const github = (name: string) => 'github:' + name.toLowerCase();
const githubSource = (value: unknown) => {
  if (typeof value !== 'string') return null;
  const match = /^(?:git\+)?https:\/\/github\.com\/([\w.-]+\/[\w.-]+)(?:[/?#]|$)/i.exec(value);
  const repo = match ? nameWithOwnerFromRemote('https://github.com/' + match[1]) : nameWithOwnerFromRemote(value);
  return repo ? github(repo) : null;
};
const lineOf = (source: string, offset: number) => source.slice(0, offset).split('\n').length;
const tomlDependencySections = ['dependencies', 'dev-dependencies', 'build-dependencies'] as const;

export function ecosystemDeclarations(repo: string, commit: string, contents: ReadonlyMap<string, string>) {
  const identities = new Set<string>([github(repo)]);
  const edges: Declaration[] = [];
  for (const [file, source] of contents) {
    const add = (kind: Declaration['kind'], target: string | null, line: number) => {
      if (target) edges.push({ kind, target, anchor: { file, commit, line } });
    };
    if (file.endsWith('Cargo.toml') || file === 'pyproject.toml') {
      try {
        const doc = parse(source);
        if (file.endsWith('Cargo.toml')) {
          const pkg = named(record(doc.package).name);
          if (pkg) identities.add(cargo(pkg));
          let section = '';
          for (const [index, line] of source.split('\n').entries()) {
            const header = /^\s*\[([\w-]+)\]\s*(?:#.*)?$/.exec(line);
            if (/^\s*\[/.test(line)) section = header?.[1] ?? '';
            const key = /^\s*([\w-]+)\s*=/.exec(line)?.[1];
            if (!key || !tomlDependencySections.some(value => value === section)) continue;
            const declared = record(doc[section])[key];
            const spec = record(declared);
            if (typeof declared !== 'string' && !Object.keys(spec).length) continue;
            const target = spec.git !== undefined ? githubSource(spec.git) : cargo(named(spec.package) ?? key);
            add('cargo-dependency', target, index + 1);
          }
        } else {
          const project = record(doc.project);
          const pkg = named(project.name);
          if (pkg) identities.add(python(pkg));
          const deps = new Set(Array.isArray(project.dependencies) ? project.dependencies : []);
          const start = /^\s*\[project\]\s*(?:#.*)?$/m.exec(source);
          const section = start ? source.slice(start.index + start[0].length).split(/^\s*\[[\w.-]+\]\s*(?:#.*)?$/m)[0]! : '';
          const list = /^[ \t]*dependencies[ \t]*=[ \t]*\[/m.exec(section);
          if (start && list) {
            const offset = start.index + start[0].length + list.index + list[0].length;
            const tail = source.slice(offset);
            for (const token of tail.matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|#[^\n]*|\]/g)) {
              if (token[0] === ']') break;
              const spec = token[0].slice(1, -1);
              const name = /^([\w.-]+)(?=\s|[<>=!~;[@]|$)/.exec(spec)?.[1];
              if (!token[0].startsWith('#') && name && deps.has(spec)) {
                const direct = /^\S+\s*@\s*(\S+)/.exec(spec)?.[1];
                add('python-dependency', direct ? githubSource(direct) : python(name), lineOf(source, offset + token.index));
              }
            }
          }
        }
      } catch { /* invalid manifests do not provide declaration evidence */ }
    } else if (file === '.gitmodules') {
      let submodule = false;
      for (const [index, line] of source.split('\n').entries()) {
        if (/^\s*\[/.test(line)) submodule = /^\s*\[submodule\s+"[^"]+"\]/i.test(line);
        const url = /^\s*url\s*=\s*"?([^"\s#]+)"?/i.exec(line)?.[1];
        if (!submodule || !url) continue;
        const relative = /^\.\.\/([\w.-]+)$/.exec(url)?.[1];
        add('git-submodule', relative ? githubSource(`https://github.com/${repo.split('/')[0]}/${relative}`) : githubSource(url), index + 1);
      }
    } else if (file.startsWith('.github/workflows/')) {
      const lineCounter = new LineCounter();
      const doc = parseDocument(source, { lineCounter, prettyErrors: false });
      const jobs = doc.get('jobs', true);
      if (doc.errors.length || !isMap(jobs)) continue;
      const use = (item: unknown) => {
        if (!isMap(item)) return;
        const node = item.get('uses', true);
        if (!isScalar(node) || typeof node.value !== 'string' || !node.range) return;
        const target = /^([\w.-]+\/[\w.-]+)(?:\/[^\s@]+)?@[^\s@]+$/.exec(node.value)?.[1];
        if (target) add('github-action', github(target), lineCounter.linePos(node.range[0]).line);
      };
      for (const { value: job } of jobs.items) {
        use(job);
        if (!isMap(job)) continue;
        const steps = job.get('steps', true);
        if (isSeq(steps)) for (const step of steps.items) use(step);
      }
    } else {
      for (const match of source.matchAll(/^[ \t]*(?:url|head)\s+["'](https:\/\/github\.com\/[^"']+)["']/gm)) {
        add('brew-formula', githubSource(match[1]), lineOf(source, match.index));
      }
    }
  }
  return { identities, edges };
}
