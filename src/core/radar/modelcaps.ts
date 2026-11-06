/** Offline RADAR model inventory comparison. No provider access or routing changes. */
export interface RadarModel {
  id: string;
  /** Only explicitly advertised capabilities; absent means unknown. */
  capabilities?: string[];
}

export interface ModelcapsDiff {
  added: RadarModel[];
  removed: RadarModel[];
  changed: { id: string; before: string[] | null; after: string[] | null }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value &&
    [...value].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);
}

/**
 * Parse a decoded /v1/models response. Reject incomplete or invalid inventories
 * instead of treating failed discovery as evidence that models were removed.
 * Standard list metadata is ignored; capability claims are never inferred.
 */
export function parseModelcaps(body: unknown): RadarModel[] {
  if (!record(body) || !Array.isArray(body['data'])) {
    throw new Error('Expected a /v1/models object with a data array');
  }
  if (body['has_more'] !== undefined && body['has_more'] !== false) {
    throw new Error('Expected a complete model inventory (has_more must be false)');
  }
  const seen = new Set<string>();
  return body['data'].map((entry: unknown, index: number): RadarModel => {
    if (!record(entry) || !nonempty(entry['id'])) {
      throw new Error(`Invalid model id at data[${index}]`);
    }
    const id = entry['id'];
    if (seen.has(id)) throw new Error(`Duplicate model id at data[${index}]`);
    seen.add(id);
    const capabilities = entry['capabilities'];
    if (capabilities === undefined) return { id };
    if (!Array.isArray(capabilities) || !capabilities.every(nonempty)) {
      throw new Error(`Invalid capabilities at data[${index}]`);
    }
    return { id, capabilities: [...new Set(capabilities as string[])].sort() };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Compare complete responses from the same provider and account scope. */
export function diffModelcaps(before: unknown, after: unknown): ModelcapsDiff {
  const previous = new Map(parseModelcaps(before).map(model => [model.id, model]));
  const current = new Map(parseModelcaps(after).map(model => [model.id, model]));
  const changed: ModelcapsDiff['changed'] = [];
  for (const [id, model] of current) {
    const old = previous.get(id);
    if (old && JSON.stringify(old.capabilities) !== JSON.stringify(model.capabilities)) {
      changed.push({ id, before: old.capabilities ?? null, after: model.capabilities ?? null });
    }
  }
  return {
    added: [...current.values()].filter(model => !previous.has(model.id)),
    removed: [...previous.values()].filter(model => !current.has(model.id)),
    changed,
  };
}

/** JSON is escaped so provider-controlled names cannot inject report lines. */
export function renderModelcapsReport(diff: ModelcapsDiff): string {
  return [
    'RADAR-MODELCAPS',
    `New models (${diff.added.length}): ${JSON.stringify(diff.added)}`,
    `Removed models (${diff.removed.length}): ${JSON.stringify(diff.removed)}`,
    `Capability changes (${diff.changed.length}): ${JSON.stringify(diff.changed)}`,
    'Inventory observations only; availability and capability claims are not verified.',
  ].join('\n');
}
