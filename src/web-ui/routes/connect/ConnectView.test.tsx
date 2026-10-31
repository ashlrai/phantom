import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RESOURCE_CATALOG } from '../../../core/onboard/catalog.js';
import { ConnectView } from './ConnectView.js';

describe('Connect Resources', () => {
  it('renders every catalog entry in its step with accessible documentation links', () => {
    render(<ConnectView />);
    const titles = ['Subscriptions', 'API keys', 'Local models', 'This computer', 'Cloud computer', 'Proactive agents'];
    const kinds = ['subscription', 'apikey', 'local', 'computer', 'cloud', 'agent'];
    titles.forEach((title, index) => {
      const section = screen.getByRole('region', { name: title });
      for (const resource of RESOURCE_CATALOG.filter((item) => item.kind === kinds[index])) {
        expect(within(section).getByRole('link', { name: resource.displayName })).toHaveAttribute('href', resource.docsUrl);
      }
    });
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('has unique ids and safe descriptive metadata', () => {
    expect(new Set(RESOURCE_CATALOG.map((item) => item.id)).size).toBe(RESOURCE_CATALOG.length);
    expect(RESOURCE_CATALOG.filter((item) => item.kind === 'apikey').every((item) => item.keyEnvName && item.validateEndpoint?.startsWith('https://'))).toBe(true);
  });
});
