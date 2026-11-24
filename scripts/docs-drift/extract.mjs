import ts from 'typescript';

export const KINDS = ['command', 'flag', 'config', 'env', 'tool', 'version'];

export function inventory() {
  return Object.fromEntries(KINDS.map(kind => [kind, new Map()]));
}

export function add(facts, kind, value, file, line = 1) {
  if (!facts[kind].has(value)) facts[kind].set(value, { file, line });
}

// Parse syntax, never import the application or run its help handlers. Comments
// cannot make a removed command, flag or tool look supported.
export function extractSource(text, file, facts, { dispatch = false } = {}) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse source: ${file}`);
  const location = node => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
  let dispatchFound = false;
  const versions = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ['APP_VERSION', 'ABOUT_VERSION'].includes(node.name.getText(source))) {
      const value = literal(node.initializer);
      if (value && /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(value)) versions.push({ kind: 'version', value, file, line: location(node) });
    }
    if (dispatch && ts.isSwitchStatement(node) && node.expression.getText(source) === 'cmd') {
      dispatchFound = true;
      for (const clause of node.caseBlock.clauses) {
        const name = ts.isCaseClause(clause) && literal(clause.expression);
        if (name && /^[a-z][\w-]*$/.test(name)) add(facts, 'command', name, file, location(clause));
      }
    }
    const value = literal(node);
    // Literal help/argument definitions include delegated flags. Membership is
    // repository-wide, not a claim that every flag works on every subcommand.
    if (value) for (const match of value.matchAll(/--[a-z][a-z0-9-]*/g)) add(facts, 'flag', match[0], file, location(node));
    if (value && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(value)) add(facts, 'env', value, file, location(node));
    if (ts.isPropertyAccessExpression(node) && /(?:^|\.)env$/.test(node.expression.getText(source))) {
      add(facts, 'env', node.name.text, file, location(node));
    }
    if (ts.isPropertyAssignment(node) && /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/.test(node.name.getText(source))) {
      add(facts, 'env', node.name.getText(source), file, location(node));
    }
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      if (props.some(p => ['inputSchema', 'input_schema'].includes(p.name.getText(source).replace(/['"]/g, '')))) {
        const name = props.find(p => p.name.getText(source).replace(/['"]/g, '') === 'name');
        if (name && literal(name.initializer)) add(facts, 'tool', literal(name.initializer), file, location(name));
      }
    }
    // Commander adapters in sibling TypeScript/JavaScript repositories.
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'command') {
      const name = literal(node.arguments[0])?.split(/\s/)[0];
      if (name && /^[a-z][\w-]*$/.test(name)) add(facts, 'command', name, file, location(node));
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (dispatch && !dispatchFound) throw new Error(`Missing command dispatch in ${file}`);
  return versions;
}

// A captured, reviewed --help output is also usable for clap and other CLIs.
// The checker only reads the snapshot; its producer owns freshness.
export function extractHelp(text, file, facts) {
  let commands = false;
  text.split(/\r?\n/).forEach((line, i) => {
    if (/^\S.*:\s*$/.test(line)) commands = /^(?:Commands|Subcommands):/.test(line);
    const name = commands && /^\s{2,}([a-z][\w-]*)\s{2,}/.exec(line)?.[1];
    if (name) add(facts, 'command', name, file, i + 1);
    for (const flag of line.matchAll(/--[a-z][a-z0-9-]*/g)) add(facts, 'flag', flag[0], file, i + 1);
  });
}

export function extractSchema(schema, file, facts) {
  const open = new Set();
  function visit(node, path, stack) {
    if (!node || typeof node !== 'object') return;
    if (node.$ref) {
      if (!node.$ref.startsWith('#/')) throw new Error(`External schema ref in ${file}`);
      if (stack.has(node.$ref)) { open.add(path); return; }
      const target = node.$ref.slice(2).split('/').reduce((value, key) => value?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], schema);
      if (!target) throw new Error(`Unresolved schema ref in ${file}`);
      visit(target, path, new Set([...stack, node.$ref]));
    }
    for (const [key, child] of Object.entries(node.properties ?? {})) {
      const name = path ? `${path}.${key}` : key;
      add(facts, 'config', name, file);
      visit(child, name, stack);
    }
    if (node.patternProperties || node.additionalProperties === true || typeof node.additionalProperties === 'object' ||
      (node.type === 'object' && node.additionalProperties === undefined)) open.add(path);
    for (const variant of ['allOf', 'anyOf', 'oneOf']) for (const child of node[variant] ?? []) visit(child, path, stack);
  }
  visit(schema, '', new Set());
  return open;
}

// Strip values, quoted prose and forwarded child commands before tokenizing.
// Only names are returned, so JSON reports never echo credentials or goals.
function shellWords(span) {
  return span.replace(/\\\r?\n/g, ' ').replace(/\\\|/g, '|')
    .replace(/(['"])(?:\\.|(?!\1)[^\n])*?\1/g, '<value>')
    .split(/\s+(?:--(?:\s|$)|#)|[;&]/)[0].trim().split(/\s+/);
}

export function references(text, file, profile) {
  const refs = [];
  const push = (kind, value, line, historical, extra = {}) => refs.push({ kind, value, file, line, historical, ...extra });
  const lines = text.split(/\r?\n/);
  let fence = null;
  const sections = [];
  const localNames = new Set([...text.matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9]*_[A-Z0-9_]+)=/gm)].map(m => m[1]));
  const status = text.split('\n').slice(0, 12).join('\n').replace(/[*_]/g, '');
  const historicalDocument = /Status: NOT BUILT|Historical\/design context|Version:.*Draft/i.test(status);
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const lineNumber = i + 1;
    const marker = /^\s*(`{3,}|~{3,})([^`]*)$/.exec(line);
    if (marker) {
      if (!fence) fence = { char: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    const heading = !fence && /^(#{1,6})\s+(.+)/.exec(line);
    if (heading) {
      while (sections.length && sections.at(-1).depth >= heading[1].length) sections.pop();
      sections.push({ depth: heading[1].length, historical: /historical|next patches|planned|proposed|gated future|not yet built|stale.*reference/i.test(heading[2]) });
    }
    const historical = historicalDocument || profile.historicalPrefixes.some(prefix => file.startsWith(prefix)) || sections.some(s => s.historical) ||
      /\b(?:deleted|absent from|NOT built|not yet built|no longer supported|Add a feature flag)\b/i.test(lines.slice(i, i + 3).join(' '));
    if (fence || file.endsWith('.txt')) while (/\\\s*$/.test(line) && i + 1 < lines.length) line = line.replace(/\\\s*$/, ' ') + lines[++i].trim();
    const inline = [...line.matchAll(/`+([^`]+)`+/g)].map(m => m[1].trim());
    const spans = fence ? [line.replace(/^\s*\$\s+/, '').trim()]
      : file.endsWith('.txt') ? [line.trim(), ...inline] : inline;
    for (const span of spans) {
      const words = shellWords(span);
      if (profile.binaries.includes(words[0])) {
        const command = words[1];
        if (/^[a-z][\w-]*$/.test(command ?? '')) push('command', command, lineNumber, historical);
        for (const word of words.slice(1)) {
          for (const match of word.matchAll(/(?:^|\[|\|)(--[a-z][a-z0-9-]*)/g)) {
            const offset = lines.slice(lineNumber - 1, i + 1).findIndex(part => part.includes(match[1]));
            push('flag', match[1], lineNumber + Math.max(0, offset), historical);
          }
        }
        if (command === 'config' && ['get', 'set'].includes(words[2]) && /^[a-z][\w.-]*$/.test(words[3] ?? '')) {
          push('config', words[3], lineNumber, historical);
        }
      }
      // Standalone identifiers have explicit ownership, unlike arbitrary prose
      // or third-party examples (Node, PATH, protocol versions, plugin tools).
      for (const match of span.matchAll(/\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/g)) {
        if (profile.envPrefixes.some(prefix => match[0].startsWith(prefix))) push('env', match[0], lineNumber, historical,
          { ...(localNames.has(match[0]) ? { context: 'shell-variable' } : {}) });
      }
      if (/^[a-z][a-z0-9_]*[a-z0-9]$/.test(span) && profile.toolPrefixes.some(prefix => span.startsWith(prefix))) push('tool', span, lineNumber, historical);
      if (/^[a-z][\w-]*(?:\.[a-z][\w-]*)+$/.test(span) && profile.configRoots?.includes(span.split('.')[0]) &&
        /\bconfig(?:uration)? key\s*:/i.test(line)) push('config', span, lineNumber, historical);
    }
    for (const version of line.matchAll(/This source tree targets version (\d+\.\d+\.\d+(?:-[\w.-]+)?)/g)) {
      push('version', version[1], lineNumber, false, { fixable: true, column: version.index + 1 });
    }
  }
  return refs;
}
