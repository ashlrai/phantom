interface BrandArtwork {
  label: string;
  logo: string;
  tile: 'none' | 'neutral';
  url: string;
}

export const ECOSYSTEM_BRANDS = {
  phantom: { label: 'Phantom', logo: 'phantom-workbench-logo.svg', tile: 'none', url: 'https://github.com/ashlrai/phantom' },
  'phantom-secrets': { label: 'Phantom Secrets', logo: 'phantom-secrets-logo.svg', tile: 'none', url: 'https://github.com/ashlrai/phantom-secrets' },
  locus: { label: 'Locus', logo: 'locus-logo.svg', tile: 'neutral', url: 'https://github.com/ashlrai/locus' },
  lexicon: { label: 'Lexicon', logo: 'lexicon-logo.svg', tile: 'none', url: 'https://github.com/ashlrai/lexicon' },
  'ashlr-md': { label: 'Ashlr MD', logo: 'ashlr-md-logo.svg', tile: 'none', url: 'https://github.com/ashlrai/ashlr-md' },
  'ashlr-plugin': { label: 'Ashlr Plugin', logo: 'ashlr-plugin-logo.svg', tile: 'neutral', url: 'https://github.com/ashlrai/ashlr-plugin' },
  'ashlr-stack': { label: 'Ashlr Stack', logo: 'ashlr-stack-logo.svg', tile: 'neutral', url: 'https://github.com/ashlrai/ashlr-stack' },
  ashlrcode: { label: 'AshlrCode', logo: 'ashlrcode-logo.svg', tile: 'neutral', url: 'https://ashlr.ai/ashlrcode' },
  binshield: { label: 'Binshield', logo: 'binshield-logo.svg', tile: 'none', url: 'https://github.com/ashlrai/binshield' },
  cortex: { label: 'Cortex', logo: 'cortex-logo.svg', tile: 'none', url: 'https://ashlr.ai/cortex' },
} as const satisfies Record<string, BrandArtwork>;

type EcosystemBrand = (typeof ECOSYSTEM_BRANDS)[keyof typeof ECOSYSTEM_BRANDS];

export function ecosystemBrand(id: string): EcosystemBrand | undefined {
  const key = id.toLowerCase();
  return Object.hasOwn(ECOSYSTEM_BRANDS, key) ? ECOSYSTEM_BRANDS[key as keyof typeof ECOSYSTEM_BRANDS] : undefined;
}

export function ecosystemCapabilityBrand(id: string): EcosystemBrand | undefined {
  switch (id) {
    case 'vault': return ECOSYSTEM_BRANDS['phantom-secrets'];
    case 'plugin': return ECOSYSTEM_BRANDS['ashlr-plugin'];
    case 'stack': return ECOSYSTEM_BRANDS['ashlr-stack'];
    case 'locus':
    case 'lexicon':
    case 'ashlr-md': return ECOSYSTEM_BRANDS[id];
    default: return undefined;
  }
}

export function ecosystemConnectorBrand(name: string): EcosystemBrand | undefined {
  switch (name.toLowerCase()) {
    case 'ashlr':
    case 'ashlr-mcp': return ECOSYSTEM_BRANDS['ashlr-plugin'];
    case 'stack': return ECOSYSTEM_BRANDS['ashlr-stack'];
    default: return ecosystemBrand(name);
  }
}
