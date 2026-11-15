import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RESOURCE_CATALOG } from '../src/core/onboard/catalog.js';

describe('public connect page', () => {
  const page = readFileSync('site/connect.html', 'utf8');

  it('describes all six catalog categories and their named providers', () => {
    expect(page.match(/class="step"/g)).toHaveLength(6);
    for (const resource of RESOURCE_CATALOG.filter((item) => ['subscription', 'apikey', 'local'].includes(item.kind))) {
      expect(page).toContain(`>${resource.displayName}</li>`);
    }
  });

  it('links to the local hash route without collecting or sending credentials', () => {
    expect(page).toContain('href="http://127.0.0.1:7777/next/#/connect"');
    expect(page).toContain('npm install -g @ashlr/phantom');
    expect(page).toContain('phm verse');
    expect(page).not.toMatch(/<form\b|<input\b|<script\b/i);
  });
});
