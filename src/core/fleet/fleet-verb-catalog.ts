export interface FleetVerbEntry {
  verb: string;
  usage: string | null;
  summary: string | null;
}

export function extractVerbSummary(source: string, verb: string): { usage: string | null; summary: string | null } {
  let usage: string | null = null;
  // Some older commands spell this constant `usage` and use a multiline template.
  const constants = /\bconst\s+usage\s*=\s*(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/gi;
  for (const match of source.matchAll(constants)) {
    const firstLine = match[2].split(/\r?\n/)[0].trim();
    if (firstLine.includes(`fleet ${verb}`)) {
      usage = firstLine.replace(/^Usage:\s*/i, '');
      break;
    }
  }
  const comment = source.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  const cleaned = comment?.[1].replace(/^\s*\*\s?/gm, '').replace(/`/g, '')
    .replace(/\b(?:\.\.\/|\.\/|[\w.-]+\/)+(?=[\w.-])/g, '').replace(/\s+/g, ' ').trim();
  const sentence = cleaned?.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? cleaned;
  return { usage, summary: sentence ? sentence.slice(0, 160) : null };
}

export function buildFleetVerbCatalog(verbs: string[], readSource: (verb: string) => string | null): FleetVerbEntry[] {
  return [...verbs].sort().map(verb => {
    const source = readSource(verb);
    return { verb, ...(source === null ? { usage: null, summary: null } : extractVerbSummary(source, verb)) };
  });
}
